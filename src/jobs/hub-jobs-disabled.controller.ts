import { Controller, Get, Post, UseGuards } from '@nestjs/common';
import { CronSecretGuard } from './cron-secret.guard';

/**
 * Registered only while the Integration Hub is NOT enabled (no HUB_DATABASE_URL). The Vercel cron
 * entries for the hub jobs exist in vercel.json from day one; without this fallback they would log
 * a 404 every run until the hub is switched on. With it they answer 200 "skipped".
 */
@Controller('internal/jobs')
@UseGuards(CronSecretGuard)
export class HubJobsDisabledController {
  private skipped(job: string) {
    return {
      success: true,
      skipped: true,
      job,
      reason: 'Integration Hub is not enabled (HUB_DATABASE_URL is not set)',
    };
  }

  @Get('hub-retry-sweeper')
  sweeperGet() {
    return this.skipped('hub-retry-sweeper');
  }

  @Post('hub-retry-sweeper')
  sweeperPost() {
    return this.skipped('hub-retry-sweeper');
  }

  @Get('hub-retention')
  retentionGet() {
    return this.skipped('hub-retention');
  }

  @Post('hub-retention')
  retentionPost() {
    return this.skipped('hub-retention');
  }
}
