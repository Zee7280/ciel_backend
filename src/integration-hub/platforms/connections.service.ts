import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  ExternalConnection,
  ExternalConnectionStatus,
  ExternalPlatform,
} from '../entities';
import { HUB_CONNECTION } from '../hub-connection.constants';
import { parsePage } from '../hub-common.util';
import { HubActor, HubAuditService } from '../audit/hub-audit.service';
import { ProposeConnectionDto, UpdateConnectionDto } from './dto/platform.dto';

function normalizeDomain(input: string | undefined | null): string | null {
  const v = (input ?? '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '');
  if (!v) return null;
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(v)) {
    throw new BadRequestException(
      'referralDomain must be a bare host name, e.g. app.vendor.com',
    );
  }
  return v;
}

@Injectable()
export class ConnectionsService {
  constructor(
    @InjectRepository(ExternalConnection, HUB_CONNECTION)
    private readonly repo: Repository<ExternalConnection>,
    @InjectRepository(ExternalPlatform, HUB_CONNECTION)
    private readonly platforms: Repository<ExternalPlatform>,
    private readonly audit: HubAuditService,
  ) {}

  async list(filters: {
    page?: unknown;
    limit?: unknown;
    platformId?: string;
    organizationId?: string;
    status?: string;
  }) {
    const { page, limit, skip } = parsePage(filters.page, filters.limit);
    const qb = this.repo
      .createQueryBuilder('c')
      .leftJoinAndSelect('c.platform', 'p')
      .orderBy('c.createdAt', 'DESC')
      .skip(skip)
      .take(limit);
    if (filters.platformId)
      qb.andWhere('c.platformId = :pid', { pid: filters.platformId });
    if (filters.organizationId) {
      qb.andWhere('c.organizationId = :oid', { oid: filters.organizationId });
    }
    if (filters.status)
      qb.andWhere('c.status = :status', { status: filters.status });
    const [rows, total] = await qb.getManyAndCount();
    return { rows, total, page, limit };
  }

  async get(id: string): Promise<ExternalConnection> {
    const c = await this.repo.findOne({
      where: { id },
      relations: ['platform'],
    });
    if (!c) throw new NotFoundException('Connection not found');
    return c;
  }

  /** Organization-scoped read: a connection of another organization is reported as not found. */
  async getForOrganization(
    id: string,
    organizationId: string,
  ): Promise<ExternalConnection> {
    const c = await this.repo.findOne({
      where: { id, organizationId },
      relations: ['platform'],
    });
    if (!c) throw new NotFoundException('Connection not found');
    return c;
  }

  async propose(
    dto: ProposeConnectionDto,
    org: { id: string; name: string },
    actor: HubActor,
    proposedByOrg: boolean,
  ): Promise<ExternalConnection> {
    const platform = await this.platforms.findOne({
      where: { id: dto.platformId },
    });
    if (!platform) throw new NotFoundException('Platform not found');
    if (platform.status === 'retired') {
      throw new BadRequestException('Platform is retired');
    }
    const existing = await this.repo.findOne({
      where: { platformId: platform.id, organizationId: org.id },
    });
    if (existing && existing.status !== 'revoked') {
      throw new ConflictException(
        'A connection for this platform and organization already exists',
      );
    }
    const scopes = (dto.scopes ?? platform.approvedEventTypes).filter((s) =>
      platform.approvedEventTypes.includes(s),
    );
    const row =
      existing ??
      this.repo.create({ platformId: platform.id, organizationId: org.id });
    row.organizationName = org.name;
    row.status = proposedByOrg ? 'org_approved' : 'proposed';
    row.purpose = dto.purpose?.trim() || null;
    row.scopes = scopes;
    row.dpaReference = dto.dpaReference?.trim() || null;
    row.personalFieldsAllowed = dto.personalFieldsAllowed ?? false;
    row.orgEvidenceOpenAllowed = dto.orgEvidenceOpenAllowed ?? false;
    row.retentionDays = dto.retentionDays ?? null;
    row.referralDomain = normalizeDomain(dto.referralDomain);
    row.proposedByUserId = actor.id ?? null;
    row.orgApprovedByUserId = proposedByOrg ? (actor.id ?? null) : null;
    row.orgApprovedAt = proposedByOrg ? new Date() : null;
    row.authorizedByUserId = null;
    row.authorizedAt = null;
    row.suspendedAt = null;
    row.statusReason = null;
    await this.repo.save(row);
    await this.audit.log({
      actor,
      action: 'CONNECTION_PROPOSED',
      targetType: 'connection',
      targetId: row.id,
      connectionId: row.id,
      details: {
        platformId: platform.id,
        organizationId: org.id,
        scopes,
        proposedByOrg,
      },
    });
    return this.get(row.id);
  }

  async update(
    id: string,
    dto: UpdateConnectionDto,
    actor: HubActor,
  ): Promise<ExternalConnection> {
    const row = await this.get(id);
    if (row.status === 'revoked')
      throw new BadRequestException('Connection is revoked');
    if (dto.purpose !== undefined) row.purpose = dto.purpose.trim() || null;
    if (dto.scopes !== undefined) {
      row.scopes = dto.scopes.filter((s) =>
        row.platform.approvedEventTypes.includes(s),
      );
    }
    if (dto.dpaReference !== undefined)
      row.dpaReference = dto.dpaReference.trim() || null;
    if (dto.personalFieldsAllowed !== undefined)
      row.personalFieldsAllowed = dto.personalFieldsAllowed;
    if (dto.orgEvidenceOpenAllowed !== undefined) {
      row.orgEvidenceOpenAllowed = dto.orgEvidenceOpenAllowed;
    }
    if (dto.retentionDays !== undefined) row.retentionDays = dto.retentionDays;
    if (dto.referralDomain !== undefined)
      row.referralDomain = normalizeDomain(dto.referralDomain);
    if (dto.validUntil !== undefined) {
      const d = dto.validUntil ? new Date(dto.validUntil) : null;
      if (d && Number.isNaN(d.getTime()))
        throw new BadRequestException('validUntil is not a date');
      row.validUntil = d;
    }
    await this.repo.save(row);
    await this.audit.log({
      actor,
      action: 'CONNECTION_UPDATED',
      targetType: 'connection',
      targetId: row.id,
      connectionId: row.id,
      details: { changed: Object.keys(dto) },
    });
    return row;
  }

  private async transition(
    row: ExternalConnection,
    to: ExternalConnectionStatus,
    allowedFrom: ExternalConnectionStatus[],
    action: string,
    actor: HubActor,
    reason?: string,
  ): Promise<ExternalConnection> {
    if (!allowedFrom.includes(row.status)) {
      throw new BadRequestException(
        `Cannot ${action.toLowerCase()} a connection in status ${row.status}`,
      );
    }
    const from = row.status;
    row.status = to;
    row.statusReason = reason?.trim() || null;
    await this.repo.save(row);
    await this.audit.log({
      actor,
      action,
      targetType: 'connection',
      targetId: row.id,
      connectionId: row.id,
      details: { from, to, reason: reason ?? null },
    });
    return row;
  }

  async orgApprove(id: string, organizationId: string, actor: HubActor) {
    const row = await this.getForOrganization(id, organizationId);
    row.orgApprovedByUserId = actor.id ?? null;
    row.orgApprovedAt = new Date();
    return this.transition(
      row,
      'org_approved',
      ['proposed'],
      'CONNECTION_ORG_APPROVED',
      actor,
    );
  }

  async orgReject(
    id: string,
    organizationId: string,
    actor: HubActor,
    reason?: string,
  ) {
    const row = await this.getForOrganization(id, organizationId);
    return this.transition(
      row,
      'revoked',
      ['proposed', 'org_approved'],
      'CONNECTION_ORG_REJECTED',
      actor,
      reason,
    );
  }

  /** Organization admins may ask for their own active connection to be paused. */
  async orgRequestSuspension(
    id: string,
    organizationId: string,
    actor: HubActor,
    reason?: string,
  ) {
    const row = await this.getForOrganization(id, organizationId);
    row.suspendedAt = new Date();
    return this.transition(
      row,
      'suspended',
      ['active'],
      'CONNECTION_SUSPENDED_BY_ORG',
      actor,
      reason,
    );
  }

  async authorize(id: string, actor: HubActor) {
    const row = await this.get(id);
    if (row.platform.status === 'retired')
      throw new BadRequestException('Platform is retired');
    row.authorizedByUserId = actor.id ?? null;
    row.authorizedAt = new Date();
    row.validFrom = row.validFrom ?? new Date();
    row.suspendedAt = null;
    return this.transition(
      row,
      'active',
      ['org_approved'],
      'CONNECTION_AUTHORIZED',
      actor,
    );
  }

  async suspend(id: string, actor: HubActor, reason?: string) {
    const row = await this.get(id);
    row.suspendedAt = new Date();
    return this.transition(
      row,
      'suspended',
      ['active'],
      'CONNECTION_SUSPENDED',
      actor,
      reason,
    );
  }

  async resume(id: string, actor: HubActor) {
    const row = await this.get(id);
    row.suspendedAt = null;
    return this.transition(
      row,
      'active',
      ['suspended'],
      'CONNECTION_RESUMED',
      actor,
    );
  }

  async revoke(id: string, actor: HubActor, reason?: string) {
    const row = await this.get(id);
    return this.transition(
      row,
      'revoked',
      ['proposed', 'org_approved', 'active', 'suspended'],
      'CONNECTION_REVOKED',
      actor,
      reason,
    );
  }

  /** Intake check: the connection must belong to the platform, be active and inside its validity window. */
  async resolveForIntake(
    connectionId: string,
    platformId: string,
  ): Promise<
    { ok: true; connection: ExternalConnection } | { ok: false; code: string }
  > {
    const c = await this.repo.findOne({ where: { id: connectionId } });
    if (!c || c.platformId !== platformId)
      return { ok: false, code: 'CONNECTION_NOT_FOUND' };
    if (c.status !== 'active')
      return { ok: false, code: 'CONNECTION_NOT_ACTIVE' };
    const now = Date.now();
    if (c.validFrom && c.validFrom.getTime() > now)
      return { ok: false, code: 'CONNECTION_NOT_YET_VALID' };
    if (c.validUntil && c.validUntil.getTime() < now)
      return { ok: false, code: 'CONNECTION_EXPIRED' };
    return { ok: true, connection: c };
  }

  assertOrgRole(role: string | undefined): void {
    if (!role) throw new ForbiddenException();
  }
}
