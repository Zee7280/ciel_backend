import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, LessThan, Repository } from 'typeorm';
import {
  ExternalConnection,
  ExternalEvent,
  ExternalEvidence,
  ExternalPlatform,
  ExternalRecord,
} from '../entities';
import { HUB_CONNECTION } from '../hub-connection.constants';
import { effectiveSettings } from '../hub-common.util';
import { EvidenceService } from '../evidence/evidence.service';
import { HubAuditService } from '../audit/hub-audit.service';
import { ProcessingService } from '../processing/processing.service';

const BATCH = 200;

export type RetentionResult = {
  expired_tickets: number;
  purged_evidence: number;
  purged_records: number;
  purged_events: number;
  summaries_rebuilt: number;
  connections_scanned: number;
};

/**
 * Daily retention (design §5): bounded delete batches per connection, driven by the platform
 * defaults and per-connection overrides. Audit rows are never purged (the role cannot).
 */
@Injectable()
export class RetentionService {
  private readonly logger = new Logger(RetentionService.name);

  constructor(
    @InjectRepository(ExternalPlatform, HUB_CONNECTION)
    private readonly platforms: Repository<ExternalPlatform>,
    @InjectRepository(ExternalConnection, HUB_CONNECTION)
    private readonly connections: Repository<ExternalConnection>,
    @InjectRepository(ExternalEvent, HUB_CONNECTION)
    private readonly events: Repository<ExternalEvent>,
    @InjectRepository(ExternalRecord, HUB_CONNECTION)
    private readonly records: Repository<ExternalRecord>,
    @InjectRepository(ExternalEvidence, HUB_CONNECTION)
    private readonly evidence: Repository<ExternalEvidence>,
    private readonly evidenceService: EvidenceService,
    private readonly audit: HubAuditService,
    private readonly processing: ProcessingService,
  ) {}

  async run(): Promise<RetentionResult> {
    const result: RetentionResult = {
      expired_tickets: 0,
      purged_evidence: 0,
      purged_records: 0,
      purged_events: 0,
      summaries_rebuilt: 0,
      connections_scanned: 0,
    };

    // 1. Expired upload tickets never completed → object removed, row rejected.
    const expired = await this.evidence.find({
      where: { state: 'quarantined', ticketExpiresAt: LessThan(new Date()) },
      take: BATCH,
    });
    for (const row of expired) {
      await this.evidenceService.purge(row, 'TICKET_EXPIRED');
      result.expired_tickets += 1;
    }

    // 2. Per-connection retention.
    const platforms = await this.platforms.find();
    const settingsByPlatform = new Map(
      platforms.map((p) => [p.id, effectiveSettings(p)]),
    );
    const connections = await this.connections.find();
    for (const c of connections) {
      const s = settingsByPlatform.get(c.platformId);
      if (!s) continue;
      result.connections_scanned += 1;
      const retentionDays = c.retentionDays ?? s.retention_days;
      const cutoff = new Date(Date.now() - retentionDays * 86_400_000);
      const logCutoff = new Date(
        Date.now() - s.log_retention_days * 86_400_000,
      );

      // Accepted evidence past retention: delete object, keep metadata as purged.
      const oldEvidence = await this.evidence.find({
        where: {
          connectionId: c.id,
          state: 'accepted',
          createdAt: LessThan(cutoff),
        },
        take: BATCH,
      });
      for (const row of oldEvidence) {
        await this.evidenceService.purge(row, 'RETENTION');
        result.purged_evidence += 1;
      }

      // Record versions past retention (superseded, voided and current alike: the contractual
      // period applies to the data itself). Summaries of that connection are rebuilt afterwards so
      // dashboards never show totals for records that no longer exist.
      const oldRecords = await this.records.find({
        where: { connectionId: c.id, createdAt: LessThan(cutoff) },
        select: { id: true, status: true },
        take: BATCH,
      });
      if (oldRecords.length) {
        await this.evidence.update(
          { recordId: In(oldRecords.map((r) => r.id)) },
          { recordId: null },
        );
        await this.records.delete({ id: In(oldRecords.map((r) => r.id)) });
        result.purged_records += oldRecords.length;
        if (oldRecords.some((r) => r.status === 'current')) {
          await this.processing.rebuildSummaries(c.id);
          result.summaries_rebuilt += 1;
        }
      }

      // Rejected / dead events are processing logs: shorter retention. Processed events (history)
      // follow the record retention.
      const oldLogs = await this.events.find({
        where: [
          {
            connectionId: c.id,
            status: In(['rejected', 'dead']),
            receivedAt: LessThan(logCutoff),
          },
          {
            connectionId: c.id,
            status: 'processed',
            receivedAt: LessThan(cutoff),
          },
        ],
        select: { id: true },
        take: BATCH,
      });
      if (oldLogs.length) {
        await this.events.delete({ id: In(oldLogs.map((e) => e.id)) });
        result.purged_events += oldLogs.length;
      }
    }

    this.logger.log(`Hub retention run: ${JSON.stringify(result)}`);
    await this.audit.log({
      actor: { type: 'system', id: 'retention', label: 'hub-retention' },
      action: 'RETENTION_RUN',
      targetType: 'system',
      details: { ...result },
    });
    return result;
  }
}
