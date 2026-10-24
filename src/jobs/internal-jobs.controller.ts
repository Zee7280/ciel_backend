import { Controller, Get, Post, UseGuards } from '@nestjs/common';
import { CronSecretGuard } from './cron-secret.guard';
import { PlatformJobsService } from './platform-jobs.service';

/**
 * Scheduled-job entry points for Vercel Cron (see `crons` in vercel.json). Vercel invokes cron
 * paths with GET on the production deployment only; POST is accepted for manual runs with the same
 * secret. These routes are not JWT routes: the only credential is CRON_SECRET.
 */
@Controller('internal/jobs')
@UseGuards(CronSecretGuard)
export class InternalJobsController {
  constructor(private readonly platformJobs: PlatformJobsService) {}

  @Get('nightly')
  runNightlyGet() {
    return this.platformJobs.runNightlyJobsNow('vercel-cron');
  }

  @Post('nightly')
  runNightlyPost() {
    return this.platformJobs.runNightlyJobsNow('manual-secret');
  }
}
