import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { timingSafeEqual } from 'crypto';

/**
 * Protects scheduled-job endpoints. Vercel Cron calls the configured path with
 * `Authorization: Bearer <CRON_SECRET>` (the project env var of the same name). Any other caller
 * must present the same header. Fails closed: with no CRON_SECRET configured nothing is accepted,
 * so a forgotten env var can never turn these routes into public job triggers.
 */
export function isCronSecretValid(
  authorizationHeader: string | undefined,
  configuredSecret: string | undefined,
): boolean {
  const secret = (configuredSecret ?? '').trim();
  if (secret.length < 16) return false;
  const header = (authorizationHeader ?? '').trim();
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) return false;
  const presented = Buffer.from(match[1].trim());
  const expected = Buffer.from(secret);
  if (presented.length !== expected.length) return false;
  return timingSafeEqual(presented, expected);
}

@Injectable()
export class CronSecretGuard implements CanActivate {
  private readonly logger = new Logger(CronSecretGuard.name);

  canActivate(context: ExecutionContext): boolean {
    const req = context
      .switchToHttp()
      .getRequest<{ headers: Record<string, string | undefined> }>();
    if (!process.env.CRON_SECRET) {
      this.logger.warn(
        'CRON_SECRET is not configured; scheduled-job endpoint refused',
      );
    }
    if (
      !isCronSecretValid(req.headers.authorization, process.env.CRON_SECRET)
    ) {
      throw new UnauthorizedException('Invalid or missing cron secret');
    }
    return true;
  }
}
