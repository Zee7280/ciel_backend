import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, In } from 'typeorm';
import {
  ExternalConnection,
  ExternalCredential,
  ExternalEvent,
  ExternalEvidence,
  ExternalPlatform,
  ExternalRecord,
  ExternalSummary,
} from '../entities';
import { HUB_CONNECTION } from '../hub-connection.constants';
import { HubActor, HubAuditService } from '../audit/hub-audit.service';

export type DeletionCheck = {
  deletable: boolean;
  reason: string | null;
  events: number;
  records: number;
  evidence: number;
  connections: number;
};

/**
 * Hard delete for platforms and connections that never received any data (set up by mistake,
 * test entries, a typo in the name). Anything that holds events, records or evidence is refused:
 * those must be suspended / revoked / retired instead so the history stays auditable.
 * The audit trail is never deleted; a PLATFORM_DELETED / CONNECTION_DELETED row records the act.
 */
@Injectable()
export class HubDeletionService {
  constructor(
    @InjectDataSource(HUB_CONNECTION) private readonly ds: DataSource,
    private readonly audit: HubAuditService,
  ) {}

  private async usage(
    em: EntityManager,
    where: { platformId?: string; connectionId?: string },
  ) {
    const [events, records, evidence] = await Promise.all([
      em.count(ExternalEvent, { where }),
      em.count(ExternalRecord, { where }),
      em.count(ExternalEvidence, { where }),
    ]);
    return { events, records, evidence };
  }

  async checkPlatform(id: string): Promise<DeletionCheck> {
    const em = this.ds.manager;
    const platform = await em.findOne(ExternalPlatform, { where: { id } });
    if (!platform) throw new NotFoundException('Platform not found');
    const u = await this.usage(em, { platformId: id });
    const connections = await em.count(ExternalConnection, {
      where: { platformId: id },
    });
    const activeConnections = await em.count(ExternalConnection, {
      where: { platformId: id, status: 'active' },
    });
    let reason: string | null = null;
    if (platform.status === 'live') {
      reason = 'Live platforms cannot be deleted. Suspend or retire it first.';
    } else if (activeConnections > 0) {
      reason = 'The platform has an active connection. Revoke it first.';
    } else if (u.events + u.records + u.evidence > 0) {
      reason =
        'The platform has already sent data. Keep it retired so its history stays auditable.';
    }
    return { deletable: reason === null, reason, connections, ...u };
  }

  async checkConnection(id: string): Promise<DeletionCheck> {
    const em = this.ds.manager;
    const connection = await em.findOne(ExternalConnection, { where: { id } });
    if (!connection) throw new NotFoundException('Connection not found');
    const u = await this.usage(em, { connectionId: id });
    let reason: string | null = null;
    if (connection.status === 'active') {
      reason = 'Active connections cannot be deleted. Revoke it first.';
    } else if (u.events + u.records + u.evidence > 0) {
      reason =
        'The connection has already received data. Keep it revoked so its history stays auditable.';
    }
    return { deletable: reason === null, reason, connections: 1, ...u };
  }

  async deletePlatform(id: string, actor: HubActor): Promise<void> {
    const check = await this.checkPlatform(id);
    if (!check.deletable) throw new ConflictException(check.reason);
    const snapshot = await this.ds.transaction(async (em) => {
      const platform = await em.findOne(ExternalPlatform, {
        where: { id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!platform) throw new NotFoundException('Platform not found');
      // Re-check inside the lock: a vendor call may have landed since the pre-check.
      const u = await this.usage(em, { platformId: id });
      if (u.events + u.records + u.evidence > 0) {
        throw new ConflictException(
          'The platform received data while deleting. Retire it instead.',
        );
      }
      const connections = await em.find(ExternalConnection, {
        where: { platformId: id },
        select: { id: true, organizationName: true, status: true },
      });
      const connectionIds = connections.map((c) => c.id);
      if (connectionIds.length) {
        await em.delete(ExternalSummary, { connectionId: In(connectionIds) });
        await em.delete(ExternalConnection, { id: In(connectionIds) });
      }
      const credentials = await em.delete(ExternalCredential, {
        platformId: id,
      });
      await em.delete(ExternalPlatform, { id });
      return {
        slug: platform.slug,
        name: platform.name,
        status: platform.status,
        connections: connections.map((c) => ({
          id: c.id,
          organization: c.organizationName,
          status: c.status,
        })),
        credentialsDeleted: credentials.affected ?? 0,
      };
    });
    await this.audit.log({
      actor,
      action: 'PLATFORM_DELETED',
      targetType: 'platform',
      targetId: id,
      details: snapshot,
    });
  }

  async deleteConnection(id: string, actor: HubActor): Promise<void> {
    const check = await this.checkConnection(id);
    if (!check.deletable) throw new ConflictException(check.reason);
    const snapshot = await this.ds.transaction(async (em) => {
      const connection = await em.findOne(ExternalConnection, {
        where: { id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!connection) throw new NotFoundException('Connection not found');
      if (connection.status === 'active') {
        throw new BadRequestException('Revoke the connection first');
      }
      const u = await this.usage(em, { connectionId: id });
      if (u.events + u.records + u.evidence > 0) {
        throw new ConflictException(
          'The connection received data while deleting. Revoke it instead.',
        );
      }
      await em.delete(ExternalSummary, { connectionId: id });
      await em.delete(ExternalConnection, { id });
      return {
        platformId: connection.platformId,
        organizationId: connection.organizationId,
        organization: connection.organizationName,
        status: connection.status,
      };
    });
    await this.audit.log({
      actor,
      action: 'CONNECTION_DELETED',
      targetType: 'connection',
      targetId: id,
      connectionId: id,
      details: snapshot,
    });
  }
}
