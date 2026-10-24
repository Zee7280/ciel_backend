import { Controller, Get, Post, UseGuards } from '@nestjs/common';
import { CronSecretGuard } from '../../jobs/cron-secret.guard';
import { ProcessingService } from '../processing/processing.service';
import { RetentionService } from './retention.service';
import { HubAuditService } from '../audit/hub-audit.service';

/**
 * Vercel Cron entry points for the hub (design §3.2). Push ingestion needs none of these; they
 * exist for deferred retries and retention only. GET for Vercel Cron, POST for manual runs.
 */
@Controller('internal/jobs')
@UseGuards(CronSecretGuard)
export class HubInternalJobsController {
  constructor(
    private readonly processing: ProcessingService,
    private readonly retention: RetentionService,
    private readonly audit: HubAuditService,
  ) {}

  private async sweep(trigger: string) {
    const result = await this.processing.sweep({ limit: 50, budgetMs: 25_000 });
    if (result.claimed > 0) {
      await this.audit.log({
        actor: { type: 'system', id: 'sweeper', label: trigger },
        action: 'SWEEP_RUN',
        targetType: 'system',
        details: { ...result },
      });
    }
    return { success: true, trigger, ...result };
  }

  @Get('hub-retry-sweeper')
  sweepGet() {
    return this.sweep('vercel-cron');
  }

  @Post('hub-retry-sweeper')
  sweepPost() {
    return this.sweep('manual-secret');
  }

  @Get('hub-retention')
  async retentionGet() {
    return {
      success: true,
      trigger: 'vercel-cron',
      ...(await this.retention.run()),
    };
  }

  @Post('hub-retention')
  async retentionPost() {
    return {
      success: true,
      trigger: 'manual-secret',
      ...(await this.retention.run()),
    };
  }
}
