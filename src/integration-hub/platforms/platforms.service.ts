import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ExternalPlatform, ExternalPlatformStatus } from '../entities';
import { HUB_CONNECTION } from '../hub-connection.constants';
import { effectiveSettings, parsePage, slugify } from '../hub-common.util';
import { HubActor, HubAuditService } from '../audit/hub-audit.service';
import { CreatePlatformDto, UpdatePlatformDto } from './dto/platform.dto';

const TRANSITIONS: Record<ExternalPlatformStatus, ExternalPlatformStatus[]> = {
  sandbox: ['live', 'suspended', 'retired'],
  live: ['suspended', 'retired'],
  suspended: ['live', 'sandbox', 'retired'],
  retired: [],
};

@Injectable()
export class PlatformsService {
  constructor(
    @InjectRepository(ExternalPlatform, HUB_CONNECTION)
    private readonly repo: Repository<ExternalPlatform>,
    private readonly audit: HubAuditService,
  ) {}

  async list(filters: {
    page?: unknown;
    limit?: unknown;
    status?: string;
    q?: string;
  }) {
    const { page, limit, skip } = parsePage(filters.page, filters.limit);
    const qb = this.repo
      .createQueryBuilder('p')
      .orderBy('p.createdAt', 'DESC')
      .skip(skip)
      .take(limit);
    if (filters.status)
      qb.andWhere('p.status = :status', { status: filters.status });
    if (filters.q?.trim()) {
      qb.andWhere('(LOWER(p.name) LIKE :q OR p.slug LIKE :q)', {
        q: `%${filters.q.trim().toLowerCase()}%`,
      });
    }
    const [rows, total] = await qb.getManyAndCount();
    return {
      rows: rows.map((p) => ({
        ...p,
        effectiveSettings: effectiveSettings(p),
      })),
      total,
      page,
      limit,
    };
  }

  async get(id: string): Promise<ExternalPlatform> {
    const p = await this.repo.findOne({ where: { id } });
    if (!p) throw new NotFoundException('Platform not found');
    return p;
  }

  async create(
    dto: CreatePlatformDto,
    actor: HubActor,
  ): Promise<ExternalPlatform> {
    const slug = (dto.slug ?? slugify(dto.name)).toLowerCase();
    if (slug.length < 2) throw new BadRequestException('Slug too short');
    if (await this.repo.findOne({ where: { slug } })) {
      throw new ConflictException(`Slug "${slug}" is already registered`);
    }
    const row = this.repo.create({
      slug,
      name: dto.name.trim(),
      description: dto.description?.trim() || null,
      status: 'sandbox',
      integrationMode: dto.integrationMode ?? 'push',
      approvedEventTypes: dto.approvedEventTypes ?? [],
      settings: dto.settings ?? {},
      technicalContact: dto.technicalContact ?? null,
      agreementReference: dto.agreementReference?.trim() || null,
      createdByUserId: actor.id ?? null,
    });
    await this.repo.save(row);
    await this.audit.log({
      actor,
      action: 'PLATFORM_REGISTERED',
      targetType: 'platform',
      targetId: row.id,
      details: { slug, name: row.name, integrationMode: row.integrationMode },
    });
    return row;
  }

  async update(
    id: string,
    dto: UpdatePlatformDto,
    actor: HubActor,
  ): Promise<ExternalPlatform> {
    const row = await this.get(id);
    if (row.status === 'retired') {
      throw new BadRequestException('Retired platforms cannot be edited');
    }
    const before = { ...row };
    if (dto.name !== undefined) row.name = dto.name.trim();
    if (dto.description !== undefined)
      row.description = dto.description.trim() || null;
    if (dto.integrationMode !== undefined)
      row.integrationMode = dto.integrationMode;
    if (dto.approvedEventTypes !== undefined)
      row.approvedEventTypes = dto.approvedEventTypes;
    if (dto.settings !== undefined)
      row.settings = { ...row.settings, ...dto.settings };
    if (dto.technicalContact !== undefined)
      row.technicalContact = dto.technicalContact;
    if (dto.agreementReference !== undefined) {
      row.agreementReference = dto.agreementReference.trim() || null;
    }
    await this.repo.save(row);
    await this.audit.log({
      actor,
      action: 'PLATFORM_UPDATED',
      targetType: 'platform',
      targetId: row.id,
      details: {
        changed: Object.keys(dto),
        before: { name: before.name, status: before.status },
      },
    });
    return row;
  }

  async setStatus(
    id: string,
    status: ExternalPlatformStatus,
    reason: string | undefined,
    actor: HubActor,
  ): Promise<ExternalPlatform> {
    const row = await this.get(id);
    if (row.status === status) return row;
    if (!TRANSITIONS[row.status].includes(status)) {
      throw new BadRequestException(
        `Cannot move platform from ${row.status} to ${status}`,
      );
    }
    const from = row.status;
    row.status = status;
    if (status === 'live') {
      row.liveAt = row.liveAt ?? new Date();
      row.suspendedAt = null;
      row.suspensionReason = null;
    }
    if (status === 'suspended' || status === 'retired') {
      row.suspendedAt = new Date();
      row.suspensionReason = reason?.trim() || null;
    }
    await this.repo.save(row);
    await this.audit.log({
      actor,
      action: `PLATFORM_${status.toUpperCase()}`,
      targetType: 'platform',
      targetId: row.id,
      details: { from, to: status, reason: reason ?? null },
    });
    return row;
  }

  /** True when a platform may authenticate and submit. */
  static acceptsTraffic(p: Pick<ExternalPlatform, 'status'>): boolean {
    return p.status === 'sandbox' || p.status === 'live';
  }
}
