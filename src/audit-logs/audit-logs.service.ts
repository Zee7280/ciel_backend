import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
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
};

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
      const row = this.auditRepo.create({
        action: input.action.slice(0, 512),
        user: input.user ?? undefined,
        user_email: input.user_email ?? undefined,
        ip: input.ip ?? undefined,
        target: input.target ?? undefined,
        target_type: input.target_type ?? undefined,
        details: input.details ?? undefined,
      });
      await this.auditRepo.save(row);
    } catch (err) {
      this.logger.warn(
        `audit write failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
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
    const qb = this.auditRepo
      .createQueryBuilder('log')
      .orderBy('log.created_at', 'DESC')
      .skip(skip)
      .take(limit);
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
    const from = this.parseDate(filters.dateFrom, false);
    if (from) qb.andWhere('log.created_at >= :from', { from });
    const to = this.parseDate(filters.dateTo, true);
    if (to) qb.andWhere('log.created_at <= :to', { to });
    const [logs, total] = await qb.getManyAndCount();
    return { logs, total, page, limit };
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
