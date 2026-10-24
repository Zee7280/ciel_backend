import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { HUB_CONNECTION } from '../hub-connection.constants';
import { ProcessingService } from '../processing/processing.service';

export type HubHealth = {
  generated_at: string;
  cached: boolean;
  last_24h: {
    received: number;
    processed: number;
    rejected: number;
    dead: number;
    deferred: number;
  };
  queue: {
    pending: number;
    dead: number;
    oldest_pending_seconds: number | null;
  };
  platforms: Array<{
    platform_id: string;
    slug: string;
    name: string;
    status: string;
    received_24h: number;
    failed_24h: number;
  }>;
  evidence: {
    accepted_objects: number;
    accepted_bytes: number;
    quarantined: number;
  };
  totals: {
    platforms: number;
    active_connections: number;
    current_records: number;
  };
  rate_limit_hits: number;
};

type CountRow = { k: string; n: string };

/** Periodic summary for the admin health screen; cached 5 minutes (design §13: no live polling). */
@Injectable()
export class HubHealthService {
  private cache: { value: HubHealth; expiresAt: number } | null = null;
  private rateLimitHitsProvider: () => number = () => 0;

  constructor(
    @InjectDataSource(HUB_CONNECTION) private readonly ds: DataSource,
    private readonly processing: ProcessingService,
  ) {}

  bindRateLimitCounter(fn: () => number): void {
    this.rateLimitHitsProvider = fn;
  }

  async snapshot(force = false): Promise<HubHealth> {
    if (!force && this.cache && this.cache.expiresAt > Date.now()) {
      return { ...this.cache.value, cached: true };
    }
    const since = new Date(Date.now() - 86_400_000);
    const byStatus = await this.ds.query<CountRow[]>(
      `SELECT status AS k, COUNT(*)::text AS n FROM external_hub.external_events
        WHERE "receivedAt" >= $1 GROUP BY status`,
      [since],
    );
    const s = Object.fromEntries(byStatus.map((r) => [r.k, Number(r.n)]));
    const platforms = await this.ds.query<
      Array<{
        platform_id: string;
        slug: string;
        name: string;
        status: string;
        received_24h: string;
        failed_24h: string;
      }>
    >(
      `SELECT p.id AS platform_id, p.slug, p.name, p.status,
              COUNT(e.id)::text AS received_24h,
              COUNT(e.id) FILTER (WHERE e.status IN ('rejected','dead'))::text AS failed_24h
         FROM external_hub.external_platforms p
         LEFT JOIN external_hub.external_events e
           ON e.platform_id = p.id AND e."receivedAt" >= $1
        GROUP BY p.id ORDER BY p.name`,
      [since],
    );
    const evidence = await this.ds.query<
      Array<{ accepted: string; bytes: string; quarantined: string }>
    >(
      `SELECT COUNT(*) FILTER (WHERE state = 'accepted')::text AS accepted,
              COALESCE(SUM("sizeBytes") FILTER (WHERE state = 'accepted'), 0)::text AS bytes,
              COUNT(*) FILTER (WHERE state = 'quarantined')::text AS quarantined
         FROM external_hub.external_evidence`,
    );
    const totals = await this.ds.query<
      Array<{ platforms: string; connections: string; records: string }>
    >(
      `SELECT (SELECT COUNT(*) FROM external_hub.external_platforms)::text AS platforms,
              (SELECT COUNT(*) FROM external_hub.external_connections WHERE status = 'active')::text AS connections,
              (SELECT COUNT(*) FROM external_hub.external_records WHERE status = 'current')::text AS records`,
    );
    const queue = await this.processing.queueStats();
    const value: HubHealth = {
      generated_at: new Date().toISOString(),
      cached: false,
      last_24h: {
        received: byStatus.reduce((acc, r) => acc + Number(r.n), 0),
        processed: s.processed ?? 0,
        rejected: s.rejected ?? 0,
        dead: s.dead ?? 0,
        deferred: (s.deferred ?? 0) + (s.received ?? 0),
      },
      queue: {
        pending: queue.pending,
        dead: queue.dead,
        oldest_pending_seconds: queue.oldestPendingSeconds,
      },
      platforms: platforms.map((p) => ({
        platform_id: p.platform_id,
        slug: p.slug,
        name: p.name,
        status: p.status,
        received_24h: Number(p.received_24h),
        failed_24h: Number(p.failed_24h),
      })),
      evidence: {
        accepted_objects: Number(evidence[0]?.accepted ?? 0),
        accepted_bytes: Number(evidence[0]?.bytes ?? 0),
        quarantined: Number(evidence[0]?.quarantined ?? 0),
      },
      totals: {
        platforms: Number(totals[0]?.platforms ?? 0),
        active_connections: Number(totals[0]?.connections ?? 0),
        current_records: Number(totals[0]?.records ?? 0),
      },
      rate_limit_hits: this.rateLimitHitsProvider(),
    };
    this.cache = { value, expiresAt: Date.now() + 5 * 60_000 };
    return value;
  }
}
