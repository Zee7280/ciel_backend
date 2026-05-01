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

  async findPaginated(rawPage?: number, rawLimit?: number) {
    const page =
      typeof rawPage === 'number' && Number.isFinite(rawPage) && rawPage > 0
        ? Math.floor(rawPage)
        : 1;
    const limit =
      typeof rawLimit === 'number' && Number.isFinite(rawLimit) && rawLimit > 0
        ? Math.min(100, Math.floor(rawLimit))
        : 20;
    const skip = (page - 1) * limit;
    const [logs, total] = await this.auditRepo.findAndCount({
      order: { created_at: 'DESC' },
      skip,
      take: limit,
    });
    return { logs, total, page, limit };
  }
}
