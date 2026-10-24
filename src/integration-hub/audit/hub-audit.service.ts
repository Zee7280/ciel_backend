import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ExternalAudit, ExternalAuditActorType } from '../entities';
import { HUB_CONNECTION } from '../hub-connection.constants';
import { parsePage, uuidFilter } from '../hub-common.util';

export type HubActor = {
  type: ExternalAuditActorType;
  id?: string | null;
  label?: string | null;
  ip?: string | null;
};

export type HubAuditInput = {
  actor: HubActor;
  action: string;
  targetType: string;
  targetId?: string | null;
  connectionId?: string | null;
  details?: Record<string, unknown> | null;
};

/** Append-only hub audit trail (runtime role has no DELETE here). Never throws into callers. */
@Injectable()
export class HubAuditService {
  private readonly logger = new Logger(HubAuditService.name);

  constructor(
    @InjectRepository(ExternalAudit, HUB_CONNECTION)
    private readonly repo: Repository<ExternalAudit>,
  ) {}

  async log(input: HubAuditInput): Promise<void> {
    try {
      const row = this.repo.create({
        actorType: input.actor.type,
        actorId: input.actor.id ?? null,
        actorLabel: input.actor.label ?? null,
        ip: input.actor.ip ?? null,
        action: input.action.slice(0, 64),
        targetType: input.targetType.slice(0, 32),
        targetId: input.targetId ?? null,
        connectionId: input.connectionId ?? null,
        details: input.details ?? null,
      });
      await this.repo.save(row);
    } catch (err) {
      this.logger.warn(
        `hub audit write failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async list(filters: {
    page?: unknown;
    limit?: unknown;
    connectionId?: string;
    action?: string;
    targetType?: string;
    targetId?: string;
  }) {
    const { page, limit, skip } = parsePage(filters.page, filters.limit);
    const qb = this.repo
      .createQueryBuilder('a')
      .orderBy('a.createdAt', 'DESC')
      .skip(skip)
      .take(limit);
    const connectionId = uuidFilter(filters.connectionId, 'connectionId');
    if (connectionId) {
      qb.andWhere('a.connectionId = :cid', { cid: connectionId });
    }
    if (filters.action) {
      qb.andWhere('a.action = :action', { action: filters.action });
    }
    if (filters.targetType) {
      qb.andWhere('a.targetType = :tt', { tt: filters.targetType });
    }
    if (filters.targetId) {
      qb.andWhere('a.targetId = :tid', { tid: filters.targetId });
    }
    const [rows, total] = await qb.getManyAndCount();
    return { rows, total, page, limit };
  }
}
