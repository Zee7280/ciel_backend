import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, Not } from 'typeorm';
import { PlatformsService } from '../platforms/platforms.service';
import * as os from 'os';
import {
  ExternalConnection,
  ExternalEvent,
  ExternalEventStatus,
  ExternalEvidence,
  ExternalMetricCatalog,
  ExternalMetricValue,
  ExternalRecord,
  ExternalSummary,
} from '../entities';
import { HUB_CONNECTION } from '../hub-connection.constants';
import { HubRejectError } from '../hub-common.util';
import { HubEnvelope } from '../intake/envelope.util';
import { MetricCatalogService } from '../metrics/metric-catalog.service';
import { applyMetricDelta, summaryKeysFor } from './summaries.util';

export const HUB_MAX_ATTEMPTS = 6;
/** Backoff per failed attempt (minutes): 1, 5, 15, 60, 360. */
const BACKOFF_MINUTES = [1, 5, 15, 60, 360];
const LOCK_STALE_MS = 5 * 60 * 1000;

export type ProcessOutcome = {
  status: ExternalEventStatus;
  recordId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
};

export type SweepResult = {
  claimed: number;
  processed: number;
  deferred: number;
  rejected: number;
  dead: number;
  skipped: number;
  stoppedForBudget: boolean;
};

/**
 * Turns accepted events into normalized external records (versions, voids, evidence links,
 * targeted summary updates). Runs only on the hub connection: it cannot see core tables.
 */
@Injectable()
export class ProcessingService {
  private readonly logger = new Logger(ProcessingService.name);
  private readonly workerId = `${os.hostname()}:${process.pid}`.slice(0, 64);

  constructor(
    @InjectDataSource(HUB_CONNECTION) private readonly ds: DataSource,
    private readonly metrics: MetricCatalogService,
  ) {}

  async processEvent(eventId: string): Promise<ProcessOutcome> {
    const catalog = await this.metrics.catalogMap();
    try {
      return await this.ds.transaction(async (em) => {
        // Row lock: intake, sweeper and admin replay may race on the same event. The lock plus the
        // status re-check below guarantee an event is applied at most once.
        const event = await em.findOne(ExternalEvent, {
          where: { id: eventId },
          lock: { mode: 'pessimistic_write' },
        });
        if (!event) {
          return {
            status: 'dead',
            recordId: null,
            errorCode: 'EVENT_MISSING',
            errorMessage: null,
          };
        }
        if (event.status === 'processed' || event.status === 'rejected') {
          return {
            status: event.status,
            recordId: null,
            errorCode: event.errorCode,
            errorMessage: event.errorMessage,
          };
        }
        const connection = await em.findOne(ExternalConnection, {
          where: { id: event.connectionId },
          relations: ['platform'],
        });
        const now = Date.now();
        const connectionUsable =
          !!connection &&
          connection.status === 'active' &&
          PlatformsService.acceptsTraffic(connection.platform) &&
          (!connection.validFrom || connection.validFrom.getTime() <= now) &&
          (!connection.validUntil || connection.validUntil.getTime() >= now);
        if (!connectionUsable) {
          // Not an error of the vendor's: wait for the connection to be resumed without burning
          // retry attempts (a long suspension must not turn queued events into dead letters).
          return this.defer(
            em,
            event,
            'CONNECTION_NOT_ACTIVE',
            'connection is not active',
            60,
            false,
          );
        }
        // Serialize summary maintenance per connection (also taken by rebuildSummaries).
        await em.query(
          `SELECT id FROM external_hub.external_connections WHERE id = $1 FOR UPDATE`,
          [event.connectionId],
        );
        const envelope = event.envelope as unknown as HubEnvelope;
        const recordId = await this.apply(em, event, envelope, catalog);
        event.status = 'processed';
        event.processedAt = new Date();
        event.errorCode = null;
        event.errorMessage = null;
        event.lockedAt = null;
        event.lockedBy = null;
        await em.save(event);
        return {
          status: 'processed',
          recordId,
          errorCode: null,
          errorMessage: null,
        };
      });
    } catch (err) {
      if (err instanceof HubRejectError) {
        await this.ds.getRepository(ExternalEvent).update(
          { id: eventId, status: Not('processed') },
          {
            status: 'rejected',
            errorCode: err.code,
            errorMessage: err.message.slice(0, 2000),
            processedAt: new Date(),
            lockedAt: null,
            lockedBy: null,
          },
        );
        return {
          status: 'rejected',
          recordId: null,
          errorCode: err.code,
          errorMessage: err.message,
        };
      }
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`event ${eventId} deferred: ${message}`);
      const repo = this.ds.getRepository(ExternalEvent);
      const event = await repo.findOne({ where: { id: eventId } });
      if (!event) {
        return {
          status: 'dead',
          recordId: null,
          errorCode: 'EVENT_MISSING',
          errorMessage: null,
        };
      }
      if (event.status === 'processed' || event.status === 'rejected') {
        // A concurrent worker finished it while we failed (e.g. on the unique index): keep its result.
        return {
          status: event.status,
          recordId: null,
          errorCode: event.errorCode,
          errorMessage: event.errorMessage,
        };
      }
      return this.defer(repo.manager, event, 'PROCESSING_ERROR', message);
    }
  }

  private async defer(
    em: EntityManager,
    event: ExternalEvent,
    code: string,
    message: string,
    minMinutes?: number,
    countAttempt = true,
  ): Promise<ProcessOutcome> {
    if (countAttempt) event.attempts += 1;
    const dead = countAttempt && event.attempts >= HUB_MAX_ATTEMPTS;
    const backoff =
      BACKOFF_MINUTES[
        Math.min(Math.max(event.attempts, 1) - 1, BACKOFF_MINUTES.length - 1)
      ];
    event.status = dead ? 'dead' : 'deferred';
    event.nextAttemptAt = dead
      ? null
      : new Date(Date.now() + Math.max(backoff, minMinutes ?? 0) * 60_000);
    event.errorCode = code;
    event.errorMessage = message.slice(0, 2000);
    event.lockedAt = null;
    event.lockedBy = null;
    await em.save(event);
    return {
      status: event.status,
      recordId: null,
      errorCode: code,
      errorMessage: message,
    };
  }

  /**
   * Rebuilds every summary row of one connection from its current records. Used only by the
   * nightly retention job after it purged records (bounded: one connection at a time, and only
   * connections that actually lost rows), never on the ingestion path.
   */
  async rebuildSummaries(connectionId: string): Promise<number> {
    const catalog = await this.metrics.catalogMap();
    return this.ds.transaction(async (em) => {
      // Same per-connection lock as processEvent, so no increment is lost during the rebuild.
      await em.query(
        `SELECT id FROM external_hub.external_connections WHERE id = $1 FOR UPDATE`,
        [connectionId],
      );
      const summaries = em.getRepository(ExternalSummary);
      await summaries.delete({ connectionId });
      const current = await em.find(ExternalRecord, {
        where: { connectionId, status: 'current' },
        select: {
          id: true,
          activityType: true,
          externalActivityId: true,
          occurredOn: true,
          metrics: true,
        },
      });
      const rows = new Map<string, ExternalSummary>();
      for (const record of current) {
        for (const key of summaryKeysFor(record)) {
          const k = `${key.scopeKey}|${key.period}`;
          let row = rows.get(k);
          if (!row) {
            row = summaries.create({
              connectionId,
              scopeKey: key.scopeKey,
              period: key.period,
              recordCount: 0,
              metricTotals: {},
            });
            rows.set(k, row);
          }
          row.recordCount += 1;
          row.metricTotals = applyMetricDelta(
            row.metricTotals,
            record.metrics,
            catalog,
            1,
          );
        }
      }
      if (rows.size) await summaries.save([...rows.values()]);
      return rows.size;
    });
  }

  /** Applies one envelope inside the transaction; returns the affected record id. */
  private async apply(
    em: EntityManager,
    event: ExternalEvent,
    env: HubEnvelope,
    catalog: Map<string, Pick<ExternalMetricCatalog, 'aggregation'>>,
  ): Promise<string | null> {
    const records = em.getRepository(ExternalRecord);
    const current = await records.findOne({
      where: {
        connectionId: event.connectionId,
        externalActivityId: env.activity.external_id,
        status: 'current',
      },
    });

    switch (env.event_type) {
      case 'activity.session':
      case 'impact.metric':
      case 'activity.corrected': {
        if (env.event_type !== 'activity.session' && !current) {
          throw new HubRejectError(
            'RECORD_NOT_FOUND',
            `no current record for activity "${env.activity.external_id}" to apply ${env.event_type}`,
          );
        }
        const nextPayload =
          env.event_type === 'impact.metric'
            ? (current?.payload ?? {})
            : (env.payload ?? current?.payload ?? {});
        let nextMetrics: ExternalMetricValue[];
        if (env.event_type === 'impact.metric') {
          const merged = new Map(
            (current?.metrics ?? []).map((m) => [m.code, m]),
          );
          for (const m of env.metrics ?? []) merged.set(m.code, m);
          nextMetrics = [...merged.values()];
        } else {
          nextMetrics = env.metrics ?? current?.metrics ?? [];
        }
        const validated = await this.metrics.validate(nextMetrics);
        if (!validated.ok) {
          throw new HubRejectError(
            'METRIC_INVALID',
            validated.errors.join('; '),
          );
        }
        const occurredOn = env.occurred_on ?? env.occurred_at.slice(0, 10);
        // Version numbers span every status (a voided activity can be re-submitted as a new version).
        const maxVersion = await records
          .createQueryBuilder('r')
          .select('COALESCE(MAX(r.version), 0)', 'max')
          .where('r.connectionId = :cid AND r.externalActivityId = :aid', {
            cid: event.connectionId,
            aid: env.activity.external_id,
          })
          .getRawOne<{ max: string | number }>();
        const next = records.create({
          connectionId: event.connectionId,
          platformId: event.platformId,
          externalActivityId: env.activity.external_id,
          activityType: env.activity.type,
          title: env.activity.title ?? current?.title ?? null,
          occurredOn:
            env.event_type === 'impact.metric'
              ? (current?.occurredOn ?? occurredOn)
              : occurredOn,
          payload: nextPayload,
          metrics: validated.metrics,
          attestation: env.attestation ?? current?.attestation ?? null,
          version: Number(maxVersion?.max ?? 0) + 1,
          status: 'current',
          sourceEventId: event.id,
          reviewState: 'unreviewed',
        });
        await records.save(next);
        if (current) {
          current.status = 'superseded';
          current.supersededById = next.id;
          await records.save(current);
          // -1 on the old keys and +1 on the new keys: net zero when type/month are unchanged,
          // correct when a correction moves the activity to another type or month.
          await this.updateSummaries(em, current, catalog, -1, -1);
        }
        await this.updateSummaries(em, next, catalog, 1, 1);
        await this.linkEvidence(em, event, env, next.id);
        return next.id;
      }
      case 'evidence.item': {
        if (!current) {
          throw new HubRejectError(
            'RECORD_NOT_FOUND',
            'no current record to attach evidence to',
          );
        }
        if (!env.evidence?.length) {
          throw new HubRejectError(
            'EVIDENCE_EMPTY',
            'evidence.item carries no upload ids',
          );
        }
        await this.linkEvidence(em, event, env, current.id);
        return current.id;
      }
      case 'activity.voided': {
        if (!current) {
          throw new HubRejectError(
            'RECORD_NOT_FOUND',
            'no current record to void',
          );
        }
        current.status = 'voided';
        current.voidedAt = new Date();
        await records.save(current);
        await this.updateSummaries(em, current, catalog, -1, -1);
        return current.id;
      }
      default:
        throw new HubRejectError(
          'EVENT_TYPE_UNSUPPORTED',
          String(env.event_type),
        );
    }
  }

  private async linkEvidence(
    em: EntityManager,
    event: ExternalEvent,
    env: HubEnvelope,
    recordId: string,
  ): Promise<void> {
    const ids = (env.evidence ?? []).map((e) => e.upload_id);
    if (ids.length === 0) return;
    const rows = await em.find(ExternalEvidence, {
      where: { uploadId: In(ids), connectionId: event.connectionId },
    });
    if (rows.length !== ids.length) {
      throw new HubRejectError(
        'EVIDENCE_NOT_FOUND',
        'one or more evidence upload ids are unknown for this connection',
      );
    }
    const notAccepted = rows.filter((r) => r.state !== 'accepted');
    if (notAccepted.length) {
      throw new HubRejectError(
        'EVIDENCE_NOT_ACCEPTED',
        `evidence not yet accepted: ${notAccepted.map((r) => r.uploadId).join(', ')} (call /evidence/:uploadId/complete first)`,
      );
    }
    const elsewhere = rows.filter((r) => r.recordId && r.recordId !== recordId);
    if (elsewhere.length) {
      throw new HubRejectError(
        'EVIDENCE_ALREADY_LINKED',
        `evidence already attached to another record: ${elsewhere.map((r) => r.uploadId).join(', ')}`,
      );
    }
    await em.update(
      ExternalEvidence,
      { uploadId: In(ids), connectionId: event.connectionId },
      { recordId },
    );
  }

  private async updateSummaries(
    em: EntityManager,
    record: ExternalRecord,
    catalog: Map<string, Pick<ExternalMetricCatalog, 'aggregation'>>,
    sign: 1 | -1,
    countDelta: number,
  ): Promise<void> {
    const repo = em.getRepository(ExternalSummary);
    for (const key of summaryKeysFor(record)) {
      let row = await repo
        .createQueryBuilder('s')
        .setLock('pessimistic_write')
        .where('s.connectionId = :cid AND s.scopeKey = :sk AND s.period = :p', {
          cid: record.connectionId,
          sk: key.scopeKey,
          p: key.period,
        })
        .getOne();
      if (!row) {
        row = repo.create({
          connectionId: record.connectionId,
          scopeKey: key.scopeKey,
          period: key.period,
          recordCount: 0,
          metricTotals: {},
        });
      }
      row.recordCount = Math.max(0, row.recordCount + countDelta);
      row.metricTotals = applyMetricDelta(
        row.metricTotals,
        record.metrics,
        catalog,
        sign,
      );
      await repo.save(row);
    }
  }

  /**
   * Sweeper for deferred / stranded events. Claims a bounded batch with SKIP LOCKED, honours a
   * per-connection cap and a time budget, skips suspended connections. Safe to run concurrently.
   */
  async sweep(
    opts: {
      limit?: number;
      perConnectionCap?: number;
      budgetMs?: number;
    } = {},
  ): Promise<SweepResult> {
    const limit = Math.min(200, Math.max(1, opts.limit ?? 25));
    const cap = Math.max(1, opts.perConnectionCap ?? 10);
    const deadline = Date.now() + (opts.budgetMs ?? 20_000);
    const result: SweepResult = {
      claimed: 0,
      processed: 0,
      deferred: 0,
      rejected: 0,
      dead: 0,
      skipped: 0,
      stoppedForBudget: false,
    };

    type ClaimedRow = { id: string; connection_id: string };
    const claimed = await this.ds.transaction(async (em) => {
      // Fair claim: at most `cap` events per connection per run, so one flooded connection cannot
      // monopolise the batch (design test C5).
      const rows = await em.query<ClaimedRow[]>(
        `WITH ranked AS (
           SELECT id, connection_id,
                  ROW_NUMBER() OVER (
                    PARTITION BY connection_id
                    ORDER BY "nextAttemptAt" NULLS FIRST, "receivedAt"
                  ) AS rn
             FROM external_hub.external_events
            WHERE status IN ('received', 'deferred')
              AND ("nextAttemptAt" IS NULL OR "nextAttemptAt" <= now())
              AND ("lockedAt" IS NULL OR "lockedAt" < now() - ($1 || ' milliseconds')::interval)
         )
         SELECT e.id, e.connection_id
           FROM external_hub.external_events e
           JOIN ranked r ON r.id = e.id AND r.rn <= $3
          ORDER BY e."nextAttemptAt" NULLS FIRST, e."receivedAt"
          LIMIT $2
          FOR UPDATE OF e SKIP LOCKED`,
        [String(LOCK_STALE_MS), limit, cap],
      );
      if (rows.length === 0) return rows;
      await em.update(
        ExternalEvent,
        { id: In(rows.map((r) => r.id)) },
        { lockedAt: new Date(), lockedBy: this.workerId },
      );
      return rows;
    });
    result.claimed = claimed.length;

    const perConn = new Map<string, number>();
    const leftover: string[] = [];
    for (const row of claimed) {
      if (Date.now() > deadline) {
        result.stoppedForBudget = true;
        leftover.push(row.id);
        continue;
      }
      const n = perConn.get(row.connection_id) ?? 0;
      if (n >= cap) {
        result.skipped += 1;
        leftover.push(row.id);
        continue;
      }
      perConn.set(row.connection_id, n + 1);
      const out = await this.processEvent(row.id);
      if (out.status === 'processed') result.processed += 1;
      else if (out.status === 'rejected') result.rejected += 1;
      else if (out.status === 'dead') result.dead += 1;
      else result.deferred += 1;
    }
    if (leftover.length) {
      await this.ds
        .getRepository(ExternalEvent)
        .update({ id: In(leftover) }, { lockedAt: null, lockedBy: null });
    }
    return result;
  }

  /** Admin replay: a dead or rejected event goes back to the queue with a fresh attempt budget. */
  async replay(eventId: string): Promise<ProcessOutcome> {
    // Only failed or stuck events may be replayed; a processed event must never be re-applied.
    const result = await this.ds.getRepository(ExternalEvent).update(
      { id: eventId, status: In(['dead', 'rejected', 'deferred', 'received']) },
      {
        status: 'deferred',
        attempts: 0,
        nextAttemptAt: new Date(),
        errorCode: null,
        errorMessage: null,
        lockedAt: null,
        lockedBy: null,
      },
    );
    if (!result.affected) {
      throw new BadRequestException(
        'Only dead, rejected or deferred events can be replayed',
      );
    }
    return this.processEvent(eventId);
  }

  /** Queue health for the admin screen: pending count and age of the oldest pending event. */
  async queueStats(): Promise<{
    pending: number;
    dead: number;
    oldestPendingSeconds: number | null;
  }> {
    const repo = this.ds.getRepository(ExternalEvent);
    const pending = await repo.count({
      where: { status: In(['received', 'deferred']) },
    });
    const dead = await repo.count({ where: { status: 'dead' } });
    const oldest = await repo.findOne({
      where: { status: In(['received', 'deferred']) },
      order: { receivedAt: 'ASC' },
      select: { id: true, receivedAt: true },
    });
    return {
      pending,
      dead,
      oldestPendingSeconds: oldest
        ? Math.round((Date.now() - oldest.receivedAt.getTime()) / 1000)
        : null,
    };
  }
}
