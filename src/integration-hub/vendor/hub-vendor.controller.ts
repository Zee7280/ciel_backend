import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ExternalConnection } from '../entities';
import { HUB_CONNECTION } from '../hub-connection.constants';
import { effectiveSettings } from '../hub-common.util';
import { PlatformAuthGuard } from '../security/platform-auth.guard';
import type { HubRequest } from '../security/platform-auth.guard';
import { IntakeService } from '../intake/intake.service';
import { EvidenceService } from '../evidence/evidence.service';

const INLINE_BUDGET_MS = Math.max(
  200,
  parseInt(process.env.HUB_INLINE_BUDGET_MS ?? '1500', 10) || 1500,
);

/**
 * Universal vendor API. Mounted outside the `api/v1` prefix (see main.ts) at
 * /api/integrations/v1. Machine-authenticated only; no JWT user ever reaches these handlers and
 * nothing here reads a core table.
 */
@Controller('api/integrations/v1')
@UseGuards(PlatformAuthGuard)
export class HubVendorController {
  constructor(
    private readonly intake: IntakeService,
    private readonly evidence: EvidenceService,
    @InjectRepository(ExternalConnection, HUB_CONNECTION)
    private readonly connections: Repository<ExternalConnection>,
  ) {}

  private platformOf(req: HubRequest) {
    const platform = req.hubPlatform;
    const credential = req.hubCredential;
    if (!platform || !credential) {
      throw new HttpException(
        { success: false, code: 'HUB_AUTH_MISSING' },
        HttpStatus.UNAUTHORIZED,
      );
    }
    return { platform, credential };
  }

  private ipOf(req: HubRequest): string | null {
    const fwd = req.headers['x-forwarded-for'];
    const first = Array.isArray(fwd) ? fwd[0] : fwd?.split(',')[0];
    return (first ?? req.ip ?? null)?.trim().slice(0, 64) ?? null;
  }

  /** Accepts one event, an array, or `{ events: [...] }`. 200 when fully processed, 202 when queued. */
  @Post('events')
  async submitEvents(
    @Req() req: HubRequest,
    @Res({ passthrough: true }) res: Response,
    @Body() body: unknown,
  ) {
    const { platform, credential } = this.platformOf(req);
    const settings = effectiveSettings(platform);
    const bytes = req.rawBody?.length ?? 0;
    if (bytes > settings.max_payload_bytes) {
      throw new HttpException(
        {
          success: false,
          code: 'PAYLOAD_TOO_LARGE',
          message: `Request body exceeds ${settings.max_payload_bytes} bytes`,
        },
        HttpStatus.PAYLOAD_TOO_LARGE,
      );
    }
    const events: unknown[] = Array.isArray(body)
      ? body
      : body &&
          typeof body === 'object' &&
          Array.isArray((body as { events?: unknown }).events)
        ? (body as { events: unknown[] }).events
        : [body];
    if (events.length === 0) {
      throw new HttpException(
        { success: false, code: 'BATCH_EMPTY' },
        HttpStatus.BAD_REQUEST,
      );
    }
    if (events.length > settings.max_batch_size) {
      throw new HttpException(
        {
          success: false,
          code: 'BATCH_TOO_LARGE',
          message: `At most ${settings.max_batch_size} events per request`,
        },
        HttpStatus.BAD_REQUEST,
      );
    }
    const result = await this.intake.acceptBatch(
      {
        platform,
        credentialKeyId: credential.keyId,
        ip: this.ipOf(req),
        budgetMs: INLINE_BUDGET_MS,
      },
      events,
    );
    res.status(result.httpStatus);
    return {
      success: true,
      accepted: result.accepted,
      rejected: result.rejected,
      receipts: result.receipts,
    };
  }

  /** Receipt for the caller's own event; any other id is 404 (never 403, so nothing leaks). */
  @Get('events/:receiptId')
  async receipt(@Req() req: HubRequest, @Param('receiptId') receiptId: string) {
    const { platform } = this.platformOf(req);
    const receipt = /^[0-9a-f-]{36}$/i.test(receiptId)
      ? await this.intake.receiptFor(platform.id, receiptId)
      : null;
    if (!receipt)
      throw new NotFoundException({
        success: false,
        code: 'RECEIPT_NOT_FOUND',
      });
    return { success: true, receipt };
  }

  /** The platform's own status and its connections (ids + scopes) — hub data only. */
  @Get('status')
  async status(@Req() req: HubRequest) {
    const { platform } = this.platformOf(req);
    const rows = await this.connections.find({
      where: { platformId: platform.id },
      select: {
        id: true,
        status: true,
        scopes: true,
        organizationName: true,
        validUntil: true,
      },
      order: { createdAt: 'ASC' },
    });
    const settings = effectiveSettings(platform);
    return {
      success: true,
      platform: {
        id: platform.id,
        slug: platform.slug,
        status: platform.status,
        approved_event_types: platform.approvedEventTypes,
      },
      limits: {
        rate_limit_per_minute: settings.rate_limit_per_minute,
        max_batch_size: settings.max_batch_size,
        max_payload_bytes: settings.max_payload_bytes,
        max_evidence_bytes: settings.max_evidence_bytes,
        evidence_mime_allowlist: settings.evidence_mime_allowlist,
      },
      connections: rows.map((c) => ({
        connection_id: c.id,
        organization: c.organizationName,
        status: c.status,
        scopes: c.scopes,
        valid_until: c.validUntil,
      })),
    };
  }

  @Post('evidence/upload-ticket')
  @HttpCode(201)
  async uploadTicket(
    @Req() req: HubRequest,
    @Body() body: Record<string, unknown>,
  ) {
    const { platform } = this.platformOf(req);
    const ticket = await this.evidence.issueTicket(platform, body ?? {});
    return { success: true, ticket };
  }

  @Post('evidence/:uploadId/complete')
  @HttpCode(200)
  async completeEvidence(
    @Req() req: HubRequest,
    @Param('uploadId') uploadId: string,
    @Body() body: Record<string, unknown>,
  ) {
    const { platform } = this.platformOf(req);
    const out = await this.evidence.complete(platform, uploadId, body?.sha256);
    return { success: true, evidence: out };
  }
}
