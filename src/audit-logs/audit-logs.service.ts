import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  Brackets,
  In,
  LessThan,
  Repository,
  SelectQueryBuilder,
} from 'typeorm';
import { AuditLog } from './entities/audit-log.entity';

export type AuditMutationRecordInput = {
  action: string;
  user?: string | null;
  user_email?: string | null;
  ip?: string | null;
  target?: string | null;
  target_type?: string | null;
  details?: Record<string, unknown> | null;
};

export type AuditLogFilters = {
  userEmail?: string;
  /** Substring of the route/action (e.g. "/admin/settings"). */
  path?: string;
  dateFrom?: string;
  dateTo?: string;
  /** 'success' | 'failure' */
  outcome?: string;
  method?: string;
  targetType?: string;
  userRole?: string;
  /** Free text across action, actor, target and target label. */
  search?: string;
};

/** Columns the list and the CSV export carry; `details` only comes back from findOne. */
const SUMMARY_COLUMNS = [
  'log.id',
  'log.action',
  'log.user',
  'log.user_email',
  'log.target',
  'log.target_type',
  'log.ip',
  'log.method',
  'log.outcome',
  'log.status_code',
  'log.user_role',
  'log.target_label',
  'log.created_at',
];

export const AUDIT_EXPORT_MAX_ROWS = 5000;
/** Rows younger than this can never be purged by age; individual / selected deletes stay possible. */
export const AUDIT_PURGE_MIN_DAYS = 30;

@Injectable()
export class AuditLogsService {
  private readonly logger = new Logger(AuditLogsService.name);

  constructor(
    @InjectRepository(AuditLog)
    private readonly auditRepo: Repository<AuditLog>,
  ) {}

  /** Persists audit row; swallow errors so business requests never fail on logging. */
  async recordMutation(input: AuditMutationRecordInput): Promise<void> {
    try {
      const d = input.details ?? {};
      const str = (v: unknown, max: number) =>
        typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;
      const methodFromAction = (input.action || '').trim().split(/\s+/)[0];
      const row = this.auditRepo.create({
        action: input.action.slice(0, 512),
        user: input.user ?? undefined,
        user_email: input.user_email ?? undefined,
        ip: input.ip ?? undefined,
        target: input.target ?? undefined,
        target_type: input.target_type ?? undefined,
        method: /^[A-Z]{3,7}$/.test(methodFromAction) ? methodFromAction : null,
        outcome: str(d.outcome, 16),
        status_code:
          typeof d.status_code === 'number' && Number.isFinite(d.status_code)
            ? d.status_code
            : null,
        user_role: str(d.user_role, 64),
        target_label: str(d.target_label, 160),
        details: input.details ?? undefined,
      });
      await this.auditRepo.save(row);
    } catch (err) {
      this.logger.warn(
        `audit write failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private applyFilters(
    qb: SelectQueryBuilder<AuditLog>,
    filters: AuditLogFilters,
  ): void {
    const email = filters.userEmail?.trim();
    if (email) {
      qb.andWhere('LOWER(log.user_email) LIKE :email', {
        email: `%${this.escapeLike(email.toLowerCase())}%`,
      });
    }
    const path = filters.path?.trim();
    if (path) {
      qb.andWhere('LOWER(log.action) LIKE :path', {
        path: `%${this.escapeLike(path.toLowerCase())}%`,
      });
    }
    const outcome = filters.outcome?.trim().toLowerCase();
    if (outcome === 'success' || outcome === 'failure') {
      qb.andWhere('log.outcome = :outcome', { outcome });
    }
    const method = filters.method?.trim().toUpperCase();
    if (method) {
      // Rows written before the `method` column existed still carry it as the action prefix.
      qb.andWhere(
        new Brackets((sub) => {
          sub
            .where('log.method = :method', { method })
            .orWhere('log.action LIKE :methodPrefix', {
              methodPrefix: `${method} %`,
            });
        }),
      );
    }
    const targetType = filters.targetType?.trim();
    if (targetType) {
      qb.andWhere('log.target_type = :targetType', { targetType });
    }
    const userRole = filters.userRole?.trim();
    if (userRole) {
      qb.andWhere('log.user_role = :userRole', { userRole });
    }
    const search = filters.search?.trim();
    if (search) {
      const term = `%${this.escapeLike(search.toLowerCase())}%`;
      qb.andWhere(
        new Brackets((sub) => {
          sub
            .where('LOWER(log.action) LIKE :term', { term })
            .orWhere('LOWER(log.user) LIKE :term', { term })
            .orWhere('LOWER(log.user_email) LIKE :term', { term })
            .orWhere('LOWER(log.target) LIKE :term', { term })
            .orWhere('LOWER(log.target_type) LIKE :term', { term })
            .orWhere('LOWER(log.target_label) LIKE :term', { term })
            .orWhere('log.ip LIKE :term', { term });
        }),
      );
    }
    const from = this.parseDate(filters.dateFrom, false);
    if (from) qb.andWhere('log.created_at >= :from', { from });
    const to = this.parseDate(filters.dateTo, true);
    if (to) qb.andWhere('log.created_at <= :to', { to });
  }

  async findPaginated(
    rawPage?: number,
    rawLimit?: number,
    filters: AuditLogFilters = {},
  ) {
    const page =
      typeof rawPage === 'number' && Number.isFinite(rawPage) && rawPage > 0
        ? Math.floor(rawPage)
        : 1;
    const limit =
      typeof rawLimit === 'number' && Number.isFinite(rawLimit) && rawLimit > 0
        ? Math.min(100, Math.floor(rawLimit))
        : 20;
    const skip = (page - 1) * limit;
    // Summary columns only: `details` holds the full request body (up to ~160 KB a row) and a
    // 20-row page carrying it broke the admin screen on the serverless response limit.
    const qb = this.auditRepo
      .createQueryBuilder('log')
      .select(SUMMARY_COLUMNS)
      .addSelect('log.details IS NOT NULL', 'log_has_details')
      .orderBy('log.created_at', 'DESC')
      .skip(skip)
      .take(limit);
    this.applyFilters(qb, filters);
    const { entities, raw } = await qb.getRawAndEntities();
    const total = await qb.getCount();
    const logs = entities.map((e, i) => ({
      ...e,
      has_details:
        (raw[i] as { log_has_details?: boolean })?.log_has_details === true,
    }));
    return { logs, total, page, limit };
  }

  async findOne(id: string) {
    const log = await this.auditRepo.findOne({ where: { id } });
    if (!log) throw new NotFoundException('Audit entry not found');
    return log;
  }

  /** Dashboard strip: volume, failure rate, who and what, over the last 24 h / 7 d. */
  async summary() {
    const now = Date.now();
    const d1 = new Date(now - 24 * 3600 * 1000);
    const d7 = new Date(now - 7 * 24 * 3600 * 1000);
    const base = () => this.auditRepo.createQueryBuilder('log');
    const [total, last24h, failures24h, last7d] = await Promise.all([
      base().getCount(),
      base().where('log.created_at >= :d1', { d1 }).getCount(),
      base()
        .where('log.created_at >= :d1', { d1 })
        .andWhere(`log.outcome = 'failure'`)
        .getCount(),
      base().where('log.created_at >= :d7', { d7 }).getCount(),
    ]);
    const group = async (expr: string, alias: string, take: number) =>
      base()
        .select(expr, alias)
        .addSelect('COUNT(*)', 'count')
        .where('log.created_at >= :d7', { d7 })
        .groupBy(expr)
        .orderBy('count', 'DESC')
        .limit(take)
        .getRawMany<Record<string, string>>();
    const [byMethod, topActors, topActions] = await Promise.all([
      group(`COALESCE(log.method, split_part(log.action, ' ', 1))`, 'key', 6),
      group(`COALESCE(log.user_email, log.user, 'unknown')`, 'key', 5),
      group('log.action', 'key', 8),
    ]);
    const rows = (list: Record<string, string>[]) =>
      list
        .filter((r) => r.key)
        .map((r) => ({ key: r.key, count: Number(r.count) || 0 }));
    return {
      total,
      last_24h: last24h,
      failures_24h: failures24h,
      last_7d: last7d,
      by_method_7d: rows(byMethod),
      top_actors_7d: rows(topActors),
      top_actions_7d: rows(topActions),
    };
  }

  /** CSV of the filtered trail (summary columns), capped. */
  async exportCsv(filters: AuditLogFilters = {}): Promise<string> {
    const qb = this.auditRepo
      .createQueryBuilder('log')
      .select(SUMMARY_COLUMNS)
      .orderBy('log.created_at', 'DESC')
      .take(AUDIT_EXPORT_MAX_ROWS);
    this.applyFilters(qb, filters);
    const rows = await qb.getMany();
    const header = [
      'created_at',
      'method',
      'action',
      'outcome',
      'status_code',
      'user',
      'user_email',
      'user_role',
      'target_type',
      'target',
      'target_label',
      'ip',
      'id',
    ];
    const cell = (v: unknown) => {
      const s =
        v == null
          ? ''
          : v instanceof Date
            ? v.toISOString()
            : typeof v === 'object'
              ? JSON.stringify(v)
              : String(v as string | number | boolean);
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = rows.map((r) =>
      [
        r.created_at,
        r.method ?? (r.action || '').split(' ')[0],
        r.action,
        r.outcome,
        r.status_code,
        r.user,
        r.user_email,
        r.user_role,
        r.target_type,
        r.target,
        r.target_label,
        r.ip,
        r.id,
      ]
        .map(cell)
        .join(','),
    );
    return [header.join(','), ...lines].join('\n');
  }

  /**
   * Deletion of the trail is itself a super-admin mutation and is audited by the interceptor
   * (DELETE /admin/audit-logs…), so a gap always has an entry explaining it.
   */
  async deleteMany(input: { ids?: string[]; olderThanDays?: number }) {
    const ids = [
      ...new Set(
        (input.ids || []).map((x) => String(x).trim()).filter(Boolean),
      ),
    ].slice(0, 500);
    let deleted = 0;
    if (ids.length) {
      const r = await this.auditRepo.delete({ id: In(ids) });
      deleted += r.affected ?? 0;
    }
    const days = Number(input.olderThanDays);
    if (Number.isFinite(days) && days >= AUDIT_PURGE_MIN_DAYS) {
      const cutoff = new Date(Date.now() - days * 24 * 3600 * 1000);
      const r = await this.auditRepo.delete({ created_at: LessThan(cutoff) });
      deleted += r.affected ?? 0;
    }
    return { deleted };
  }

  async deleteOne(id: string) {
    const r = await this.auditRepo.delete({ id });
    if (!r.affected) throw new NotFoundException('Audit entry not found');
    return { deleted: r.affected };
  }

  private escapeLike(value: string): string {
    return value.replace(/[\\%_]/g, (c) => `\\${c}`);
  }

  /** ISO date or datetime; a bare YYYY-MM-DD "to" date is inclusive of the whole day. */
  private parseDate(raw: string | undefined, endOfDay: boolean): Date | null {
    const v = raw?.trim();
    if (!v) return null;
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return null;
    if (endOfDay && /^\d{4}-\d{2}-\d{2}$/.test(v)) {
      d.setUTCHours(23, 59, 59, 999);
    }
    return d;
  }
}
