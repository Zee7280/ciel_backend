import {
  Controller,
  Get,
  Header,
  HttpException,
  HttpStatus,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { HubAuditService } from '../audit/hub-audit.service';
import { HubRateLimiter } from '../security/hub-rate-limiter';
import { PlatformAuthGuard } from '../security/platform-auth.guard';
import type { HubRequest } from '../security/platform-auth.guard';
import {
  type ExportQuery,
  HubExportError,
  parseDateParam,
  parseExportQuery,
} from './export-cursor.util';
import {
  HUB_EXPORT_SCHEMA_VERSION,
  type HubExportScope,
} from './export-scopes.constants';
import { type ExportAccess, HubExportService } from './hub-export.service';

type ExportRows = {
  rows: unknown[];
  next_cursor: string | null;
  has_more: boolean;
};

/** Personal data in the body: never cache it anywhere between us and the university's server. */
const NO_STORE = 'no-store, no-cache, must-revalidate, private';

/** `summary` walks every record of the university; a handful per minute is all a report needs. */
export const HUB_EXPORT_SUMMARY_PER_MINUTE = 6;

/**
 * University Export API — `/api/integrations/v1/export/*`. Machine auth (same HMAC headers as the
 * vendor API), read-only, scoped to the organization on `connection_id`. Every call is audited
 * before the data leaves: when the audit row cannot be written the request fails.
 */
@Controller('api/integrations/v1/export')
@UseGuards(PlatformAuthGuard)
export class HubExportController {
  /** Separate budget for the summary endpoint, on top of the platform-wide guard limit. */
  readonly summaryLimiter = new HubRateLimiter();

  constructor(
    private readonly exporter: HubExportService,
    private readonly audit: HubAuditService,
  ) {}

  private platformOf(req: HubRequest) {
    const platform = req.hubPlatform;
    if (!platform) {
      throw new HttpException(
        { success: false, code: 'HUB_AUTH_MISSING' },
        HttpStatus.UNAUTHORIZED,
      );
    }
    return platform;
  }

  private ipOf(req: HubRequest): string | null {
    const fwd = req.headers['x-forwarded-for'];
    const first = Array.isArray(fwd) ? fwd[0] : fwd?.split(',')[0];
    return (first ?? req.ip ?? null)?.trim().slice(0, 64) ?? null;
  }

  private async access(
    req: HubRequest,
    query: Record<string, unknown>,
    scope: HubExportScope,
  ): Promise<ExportAccess> {
    return this.exporter.resolveAccess(
      this.platformOf(req),
      query.connection_id,
      scope,
    );
  }

  private async list(
    req: HubRequest,
    query: Record<string, unknown>,
    scope: HubExportScope,
    run: (access: ExportAccess, q: ExportQuery) => Promise<ExportRows>,
    extra: Record<string, unknown> = {},
  ) {
    const access = await this.access(req, query, scope);
    const q = parseExportQuery(query);
    const page = await run(access, q);
    await this.audit.logOrThrow({
      actor: {
        type: 'platform',
        id: access.platform.id,
        label: access.platform.slug,
        ip: this.ipOf(req),
      },
      action: 'export.read',
      targetType: 'export',
      targetId: scope,
      connectionId: access.connection.id,
      details: {
        ...extra,
        rows: page.rows.length,
        has_more: page.has_more,
        limit: q.limit,
        updated_since: q.updatedSince?.toISOString() ?? null,
        cursor_used: Boolean(q.cursor),
      },
    });
    return {
      success: true,
      schema_version: HUB_EXPORT_SCHEMA_VERSION,
      scope,
      connection_id: access.connection.id,
      organization: access.organization,
      personal_fields: access.personalFields,
      ...extra,
      rows: page.rows,
      page: {
        limit: q.limit,
        count: page.rows.length,
        next_cursor: page.next_cursor,
        has_more: page.has_more,
      },
    };
  }

  /** Students affiliated with the university (profile, roster link, registration number). */
  @Get('students')
  @Header('Cache-Control', NO_STORE)
  students(@Req() req: HubRequest, @Query() query: Record<string, unknown>) {
    return this.list(req, query, 'export:students', (a, q) =>
      this.exporter.students(a, q),
    );
  }

  /** Approved opportunities the university dashboard lists (owned or via authorised faculty / students). */
  @Get('opportunities')
  @Header('Cache-Control', NO_STORE)
  opportunities(
    @Req() req: HubRequest,
    @Query() query: Record<string, unknown>,
  ) {
    return this.list(req, query, 'export:opportunities', (a, q) =>
      this.exporter.opportunities(a, q),
    );
  }

  /** Verified community-service credit: `source=structured` (default) or `source=quick`. */
  @Get('community-service')
  @Header('Cache-Control', NO_STORE)
  communityService(
    @Req() req: HubRequest,
    @Query() query: Record<string, unknown>,
  ) {
    const source =
      typeof query.source === 'string' && query.source
        ? query.source
        : 'structured';
    if (source !== 'structured' && source !== 'quick') {
      throw new HubExportError(
        HttpStatus.BAD_REQUEST,
        'SOURCE_INVALID',
        'source must be "structured" (verified project reports) or "quick" (Quick Community Impact)',
      );
    }
    return this.list(
      req,
      query,
      'export:community-service',
      (a, q) =>
        source === 'quick'
          ? this.exporter.communityServiceQuick(a, q)
          : this.exporter.communityServiceStructured(a, q),
      { source },
    );
  }

  /** Supervisor-approved FYP / thesis entries. */
  @Get('fyp')
  @Header('Cache-Control', NO_STORE)
  fyp(@Req() req: HubRequest, @Query() query: Record<string, unknown>) {
    return this.list(req, query, 'export:fyp', (a, q) =>
      this.exporter.fyp(a, q),
    );
  }

  /** Supervisor-approved startup / venture entries. */
  @Get('ventures')
  @Header('Cache-Control', NO_STORE)
  ventures(@Req() req: HubRequest, @Query() query: Record<string, unknown>) {
    return this.list(req, query, 'export:ventures', (a, q) =>
      this.exporter.ventures(a, q),
    );
  }

  /** Period totals (semester report): `from` / `to` as YYYY-MM-DD or ISO date-time. */
  @Get('summary')
  @Header('Cache-Control', NO_STORE)
  async summary(
    @Req() req: HubRequest,
    @Query() query: Record<string, unknown>,
    @Res({ passthrough: true }) res: Response,
  ) {
    const platform = this.platformOf(req);
    const budget = this.summaryLimiter.check(
      `summary:${platform.id}`,
      HUB_EXPORT_SUMMARY_PER_MINUTE,
    );
    if (!budget.allowed) {
      res.setHeader('Retry-After', String(budget.retryAfterSeconds));
      throw new HttpException(
        {
          success: false,
          code: 'RATE_LIMITED',
          message: `summary is limited to ${HUB_EXPORT_SUMMARY_PER_MINUTE} calls per minute per platform`,
          retry_after_seconds: budget.retryAfterSeconds,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    const access = await this.access(req, query, 'export:summary');
    const period = {
      from: parseDateParam(query.from, 'from'),
      to: parseDateParam(query.to, 'to'),
    };
    if (period.from && period.to && period.from > period.to) {
      throw new HubExportError(
        HttpStatus.BAD_REQUEST,
        'PERIOD_INVALID',
        'from must not be after to',
      );
    }
    const summary = await this.exporter.summary(access, period);
    await this.audit.logOrThrow({
      actor: {
        type: 'platform',
        id: access.platform.id,
        label: access.platform.slug,
        ip: this.ipOf(req),
      },
      action: 'export.read',
      targetType: 'export',
      targetId: 'export:summary',
      connectionId: access.connection.id,
      details: {
        from: period.from?.toISOString() ?? null,
        to: period.to?.toISOString() ?? null,
      },
    });
    return {
      success: true,
      schema_version: HUB_EXPORT_SCHEMA_VERSION,
      scope: 'export:summary',
      connection_id: access.connection.id,
      organization: access.organization,
      summary,
    };
  }
}
