import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  ExternalConnection,
  ExternalEvent,
  ExternalPlatform,
} from '../entities';
import { HUB_CONNECTION } from '../hub-connection.constants';
import { effectiveSettings } from '../hub-common.util';
import { ConnectionsService } from '../platforms/connections.service';
import { ProcessingService } from '../processing/processing.service';
import {
  attestationSufficient,
  findPersonalFields,
  validateEnvelope,
} from './envelope.util';

export type IntakeReceipt = {
  event_id: string | null;
  receipt_id: string | null;
  /** processed | received | deferred | rejected | duplicate */
  status: string;
  error_code?: string;
  errors?: string[];
};

export type IntakeResult = {
  /** 200 when every event reached a final state in this request; 202 when any is still queued. */
  httpStatus: 200 | 202;
  accepted: number;
  rejected: number;
  receipts: IntakeReceipt[];
};

export type IntakeContext = {
  platform: ExternalPlatform;
  credentialKeyId: string;
  ip: string | null;
  /** Milliseconds available for inline processing of the whole batch. */
  budgetMs: number;
};

/**
 * Lightweight intake (design §4): authenticate (guard), check connection + scope, validate,
 * enforce uniqueness, persist, then normalize inline while the budget lasts. Anything left over
 * stays `received` for the sweeper. Never touches core tables.
 */
@Injectable()
export class IntakeService {
  constructor(
    @InjectRepository(ExternalEvent, HUB_CONNECTION)
    private readonly events: Repository<ExternalEvent>,
    private readonly connections: ConnectionsService,
    private readonly processing: ProcessingService,
  ) {}

  async acceptBatch(
    ctx: IntakeContext,
    rawEvents: unknown[],
  ): Promise<IntakeResult> {
    const settings = effectiveSettings(ctx.platform);
    const deadline = Date.now() + ctx.budgetMs;
    const receipts: IntakeReceipt[] = [];
    const connectionCache = new Map<
      string,
      { ok: true; connection: ExternalConnection } | { ok: false; code: string }
    >();
    let accepted = 0;
    let rejected = 0;
    let pending = 0;

    for (const raw of rawEvents.slice(0, settings.max_batch_size)) {
      const v = validateEnvelope(raw);
      if (!v.ok) {
        rejected += 1;
        receipts.push({
          event_id: v.eventId,
          receipt_id: null,
          status: 'rejected',
          error_code: v.code,
          errors: v.errors,
        });
        continue;
      }
      const env = v.value;

      let conn = connectionCache.get(env.connection_id);
      if (!conn) {
        conn = await this.connections.resolveForIntake(
          env.connection_id,
          ctx.platform.id,
        );
        connectionCache.set(env.connection_id, conn);
      }
      if (!conn.ok) {
        rejected += 1;
        receipts.push({
          event_id: env.event_id,
          receipt_id: null,
          status: 'rejected',
          error_code: conn.code,
        });
        continue;
      }
      const connection = conn.connection;

      if (
        !ctx.platform.approvedEventTypes.includes(env.event_type) ||
        !connection.scopes.includes(env.event_type)
      ) {
        rejected += 1;
        receipts.push({
          event_id: env.event_id,
          receipt_id: null,
          status: 'rejected',
          error_code: 'EVENT_TYPE_NOT_IN_SCOPE',
        });
        continue;
      }

      // Scan every free-text surface a vendor controls, not only the payload.
      const personal = findPersonalFields({
        payload: env.payload ?? {},
        activity_title: env.activity.title ?? '',
        metric_methods: (env.metrics ?? []).map((m) => m.method ?? ''),
      });
      if (personal.length > 0) {
        if (!connection.personalFieldsAllowed) {
          rejected += 1;
          receipts.push({
            event_id: env.event_id,
            receipt_id: null,
            status: 'rejected',
            error_code: 'PERSONAL_DATA_NOT_ALLOWED',
            errors: personal,
          });
          continue;
        }
        if (!attestationSufficient(env.attestation)) {
          rejected += 1;
          receipts.push({
            event_id: env.event_id,
            receipt_id: null,
            status: 'rejected',
            error_code: 'ATTESTATION_REQUIRED',
            errors: [
              'attestation.lawful_basis and attestation.consent_ref are required when personal fields are present',
            ],
          });
          continue;
        }
      }

      const existing = await this.events.findOne({
        where: { connectionId: connection.id, sourceEventId: env.event_id },
        select: { id: true, status: true },
      });
      if (existing) {
        receipts.push({
          event_id: env.event_id,
          receipt_id: existing.id,
          status: 'duplicate',
          error_code: undefined,
          errors: [`already ${existing.status}`],
        });
        continue;
      }

      // When we are going to process inline, hold the row lock from the insert so a concurrent
      // sweeper run skips it (processEvent clears the lock in every outcome).
      const inline = Date.now() < deadline;
      const row = this.events.create({
        connectionId: connection.id,
        platformId: ctx.platform.id,
        sourceEventId: env.event_id,
        eventType: env.event_type,
        schemaVersion: env.schema_version,
        envelope: env as unknown as Record<string, unknown>,
        status: 'received',
        attempts: 0,
        nextAttemptAt: new Date(),
        lockedAt: inline ? new Date() : null,
        lockedBy: inline ? 'intake' : null,
        credentialKeyId: ctx.credentialKeyId,
        sourceIp: ctx.ip,
        payloadBytes: v.bytes,
      });
      try {
        await this.events.save(row);
      } catch (err) {
        // Unique violation from a concurrent duplicate: report as duplicate rather than failing the batch.
        if ((err as { code?: string }).code === '23505') {
          const dup = await this.events.findOne({
            where: { connectionId: connection.id, sourceEventId: env.event_id },
            select: { id: true, status: true },
          });
          receipts.push({
            event_id: env.event_id,
            receipt_id: dup?.id ?? null,
            status: 'duplicate',
          });
          continue;
        }
        throw err;
      }
      accepted += 1;

      if (inline) {
        const out = await this.processing.processEvent(row.id);
        if (out.status === 'processed') {
          receipts.push({
            event_id: env.event_id,
            receipt_id: row.id,
            status: 'processed',
          });
        } else if (out.status === 'rejected') {
          receipts.push({
            event_id: env.event_id,
            receipt_id: row.id,
            status: 'rejected',
            error_code: out.errorCode ?? undefined,
            errors: out.errorMessage ? [out.errorMessage] : undefined,
          });
        } else {
          pending += 1;
          receipts.push({
            event_id: env.event_id,
            receipt_id: row.id,
            status: out.status,
            error_code: out.errorCode ?? undefined,
          });
        }
      } else {
        pending += 1;
        receipts.push({
          event_id: env.event_id,
          receipt_id: row.id,
          status: 'received',
        });
      }
    }

    return {
      httpStatus: pending > 0 ? 202 : 200,
      accepted,
      rejected,
      receipts,
    };
  }

  /** Receipt for the caller's own event only; anything else is 404 at the controller. */
  async receiptFor(
    platformId: string,
    receiptId: string,
  ): Promise<IntakeReceipt | null> {
    const row = await this.events.findOne({
      where: { id: receiptId, platformId },
      select: {
        id: true,
        sourceEventId: true,
        status: true,
        errorCode: true,
        errorMessage: true,
        receivedAt: true,
        processedAt: true,
      },
    });
    if (!row) return null;
    return {
      event_id: row.sourceEventId,
      receipt_id: row.id,
      status: row.status,
      ...(row.errorCode ? { error_code: row.errorCode } : {}),
      ...(row.errorMessage ? { errors: [row.errorMessage] } : {}),
    };
  }
}
