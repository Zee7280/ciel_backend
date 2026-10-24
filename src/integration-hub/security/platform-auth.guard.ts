import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { ExternalCredential, ExternalPlatform } from '../entities';
import { effectiveSettings } from '../hub-common.util';
import { PlatformsService } from '../platforms/platforms.service';
import { CredentialsService } from './credentials.service';
import {
  canonicalString,
  isNonceWellFormed,
  isTimestampFresh,
  parseHubHeaders,
  sha256Hex,
  verifySignature,
} from './hub-hmac.util';
import { HubNonceCache } from './hub-nonce-cache';
import { HubRateLimiter } from './hub-rate-limiter';

/** What the guard attaches to the request for vendor controllers. */
export type HubRequest = Request & {
  rawBody?: Buffer;
  hubPlatform?: ExternalPlatform;
  hubCredential?: ExternalCredential;
};

/**
 * Machine authentication for /api/integrations/v1/*. Not a JWT route: the only credential is a
 * platform key + HMAC signature. Order of checks is cheapest-first so unauthenticated floods cost
 * one header parse and one indexed lookup.
 */
@Injectable()
export class PlatformAuthGuard implements CanActivate {
  readonly nonces = new HubNonceCache();
  readonly limiter = new HubRateLimiter();

  constructor(private readonly credentials: CredentialsService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<HubRequest>();
    const res = context.switchToHttp().getResponse<Response>();

    const headers = parseHubHeaders(
      req.headers as Record<string, string | string[] | undefined>,
    );
    if (!headers) {
      throw new UnauthorizedException({
        success: false,
        code: 'HUB_AUTH_HEADERS_MISSING',
        message:
          'X-Hub-Key-Id, X-Hub-Timestamp, X-Hub-Nonce and X-Hub-Signature are required',
      });
    }
    if (!isTimestampFresh(headers.timestamp)) {
      throw new UnauthorizedException({
        success: false,
        code: 'HUB_TIMESTAMP_STALE',
        message:
          'X-Hub-Timestamp must be unix seconds within ±300s of server time',
      });
    }
    if (!isNonceWellFormed(headers.nonce)) {
      throw new UnauthorizedException({
        success: false,
        code: 'HUB_NONCE_INVALID',
        message: 'X-Hub-Nonce must be 16–64 chars [A-Za-z0-9_-:.]',
      });
    }

    const resolved = await this.credentials.resolveForAuth(headers.keyId);
    if (!resolved) {
      throw new UnauthorizedException({
        success: false,
        code: 'HUB_CREDENTIAL_INVALID',
        message: 'Unknown, revoked or expired key id',
      });
    }
    const { credential, platform, secret } = resolved;

    if (!PlatformsService.acceptsTraffic(platform)) {
      throw new ForbiddenException({
        success: false,
        code: 'PLATFORM_SUSPENDED',
        message: `Platform is ${platform.status}`,
      });
    }

    const settings = effectiveSettings(platform);
    const rl = this.limiter.check(
      `platform:${platform.id}`,
      settings.rate_limit_per_minute,
    );
    if (!rl.allowed) {
      res.setHeader('Retry-After', String(rl.retryAfterSeconds));
      throw new HttpException(
        {
          success: false,
          code: 'RATE_LIMITED',
          message: `Rate limit of ${settings.rate_limit_per_minute}/min exceeded`,
          retry_after_seconds: rl.retryAfterSeconds,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const path = (req.originalUrl ?? req.url ?? '').split('?')[0];
    const body: Buffer | string = req.rawBody ?? '';
    const canonical = canonicalString({
      method: req.method,
      path,
      timestamp: headers.timestamp,
      nonce: headers.nonce,
      bodySha256: sha256Hex(body),
    });
    if (!verifySignature(secret, canonical, headers.signature)) {
      throw new UnauthorizedException({
        success: false,
        code: 'HUB_SIGNATURE_INVALID',
        message: 'Signature does not match the canonical request',
      });
    }
    if (!this.nonces.consume(headers.keyId, headers.nonce)) {
      throw new UnauthorizedException({
        success: false,
        code: 'HUB_NONCE_REPLAYED',
        message: 'Nonce already used',
      });
    }

    req.hubPlatform = platform;
    req.hubCredential = credential;
    void this.credentials.touch(credential).catch(() => undefined);
    return true;
  }
}
