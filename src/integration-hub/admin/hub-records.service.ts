import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  ExternalConnection,
  ExternalEvent,
  ExternalEvidence,
  ExternalRecord,
  ExternalRecordReviewState,
  ExternalSummary,
} from '../entities';
import { HUB_CONNECTION } from '../hub-connection.constants';
import { parsePage } from '../hub-common.util';
import { HubActor, HubAuditService } from '../audit/hub-audit.service';

type Scope = { organizationId?: string };

/** Read models for the admin console and the organization external-records page. */
@Injectable()
export class HubRecordsService {
  constructor(
    @InjectRepository(ExternalRecord, HUB_CONNECTION)
    private readonly records: Repository<ExternalRecord>,
    @InjectRepository(ExternalEvent, HUB_CONNECTION)
    private readonly events: Repository<ExternalEvent>,
    @InjectRepository(ExternalEvidence, HUB_CONNECTION)
    private readonly evidence: Repository<ExternalEvidence>,
    @InjectRepository(ExternalSummary, HUB_CONNECTION)
    private readonly summaries: Repository<ExternalSummary>,
    private readonly audit: HubAuditService,
  ) {}

  private scopeJoin<T extends { innerJoin: (...a: unknown[]) => T }>(
    qb: T,
    alias: string,
    scope: Scope,
  ): T {
    if (!scope.organizationId) return qb;
    // Entity join (not a raw table name): TypeORM maps property names to the real columns.
    return qb.innerJoin(
      ExternalConnection,
      'oc',
      `oc.id = ${alias}.connectionId AND oc.organizationId = :scopeOrg`,
      { scopeOrg: scope.organizationId },
    );
  }

  async listRecords(
    filters: {
      page?: unknown;
      limit?: unknown;
      connectionId?: string;
      platformId?: string;
      status?: string;
      reviewState?: string;
      activityType?: string;
      q?: string;
      from?: string;
      to?: string;
    },
    scope: Scope = {},
  ) {
    const { page, limit, skip } = parsePage(filters.page, filters.limit);
    let qb = this.records
      .createQueryBuilder('r')
      .orderBy('r.occurredOn', 'DESC')
      .addOrderBy('r.createdAt', 'DESC')
      .skip(skip)
      .take(limit);
    qb = this.scopeJoin(qb, 'r', scope);
    qb.andWhere('r.status = :status', { status: filters.status || 'current' });
    if (filters.connectionId)
      qb.andWhere('r.connectionId = :cid', { cid: filters.connectionId });
    if (filters.platformId)
      qb.andWhere('r.platformId = :pid', { pid: filters.platformId });
    if (filters.reviewState)
      qb.andWhere('r.reviewState = :rs', { rs: filters.reviewState });
    if (filters.activityType)
      qb.andWhere('r.activityType = :at', { at: filters.activityType });
    if (filters.from)
      qb.andWhere('r.occurredOn >= :from', { from: filters.from });
    if (filters.to) qb.andWhere('r.occurredOn <= :to', { to: filters.to });
    if (filters.q?.trim()) {
      qb.andWhere('(r.externalActivityId ILIKE :q OR r.title ILIKE :q)', {
        q: `%${filters.q.trim()}%`,
      });
    }
    const [rows, total] = await qb.getManyAndCount();
    return { rows, total, page, limit };
  }

  async getRecord(id: string, scope: Scope = {}) {
    let qb = this.records.createQueryBuilder('r').where('r.id = :id', { id });
    qb = this.scopeJoin(qb, 'r', scope);
    const record = await qb.getOne();
    if (!record) throw new NotFoundException('Record not found');
    const versions = await this.records.find({
      where: {
        connectionId: record.connectionId,
        externalActivityId: record.externalActivityId,
      },
      order: { version: 'DESC' },
      select: {
        id: true,
        version: true,
        status: true,
        createdAt: true,
        sourceEventId: true,
        reviewState: true,
      },
    });
    const evidence = await this.evidence.find({
      where: { recordId: record.id },
      order: { createdAt: 'ASC' },
    });
    const sourceEvent = await this.events.findOne({
      where: { id: record.sourceEventId },
      select: {
        id: true,
        sourceEventId: true,
        eventType: true,
        receivedAt: true,
        processedAt: true,
        status: true,
      },
    });
    return { record, versions, evidence, sourceEvent };
  }

  async review(
    id: string,
    reviewState: ExternalRecordReviewState,
    note: string | undefined,
    actor: HubActor,
  ) {
    const record = await this.records.findOne({ where: { id } });
    if (!record) throw new NotFoundException('Record not found');
    const from = record.reviewState;
    record.reviewState = reviewState;
    record.reviewNote = note?.trim() || null;
    record.reviewedByUserId = actor.id ?? null;
    record.reviewedAt = new Date();
    await this.records.save(record);
    await this.audit.log({
      actor,
      action: 'RECORD_REVIEWED',
      targetType: 'record',
      targetId: record.id,
      connectionId: record.connectionId,
      details: { from, to: reviewState, note: record.reviewNote },
    });
    return record;
  }

  async listEvents(
    filters: {
      page?: unknown;
      limit?: unknown;
      platformId?: string;
      connectionId?: string;
      status?: string;
      eventType?: string;
      q?: string;
    },
    scope: Scope = {},
  ) {
    const { page, limit, skip } = parsePage(filters.page, filters.limit);
    let qb = this.events
      .createQueryBuilder('e')
      .select([
        'e.id',
        'e.connectionId',
        'e.platformId',
        'e.sourceEventId',
        'e.eventType',
        'e.status',
        'e.attempts',
        'e.nextAttemptAt',
        'e.errorCode',
        'e.errorMessage',
        'e.payloadBytes',
        'e.receivedAt',
        'e.processedAt',
        'e.credentialKeyId',
      ])
      .orderBy('e.receivedAt', 'DESC')
      .skip(skip)
      .take(limit);
    qb = this.scopeJoin(qb, 'e', scope);
    if (filters.platformId)
      qb.andWhere('e.platformId = :pid', { pid: filters.platformId });
    if (filters.connectionId)
      qb.andWhere('e.connectionId = :cid', { cid: filters.connectionId });
    if (filters.status)
      qb.andWhere('e.status = :status', { status: filters.status });
    if (filters.eventType)
      qb.andWhere('e.eventType = :et', { et: filters.eventType });
    if (filters.q?.trim())
      qb.andWhere('e.sourceEventId ILIKE :q', { q: `%${filters.q.trim()}%` });
    const [rows, total] = await qb.getManyAndCount();
    return { rows, total, page, limit };
  }

  async getEvent(id: string, scope: Scope = {}) {
    let qb = this.events.createQueryBuilder('e').where('e.id = :id', { id });
    qb = this.scopeJoin(qb, 'e', scope);
    const event = await qb.getOne();
    if (!event) throw new NotFoundException('Event not found');
    return event;
  }

  async summariesFor(connectionId: string, scope: Scope = {}) {
    let qb = this.summaries
      .createQueryBuilder('s')
      .where('s.connectionId = :cid', { cid: connectionId })
      .orderBy('s.scopeKey', 'ASC')
      .addOrderBy('s.period', 'ASC');
    qb = this.scopeJoin(qb, 's', scope);
    return qb.getMany();
  }
}
