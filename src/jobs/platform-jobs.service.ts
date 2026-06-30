import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { AttendanceSlaService } from '../engagement/attendance-sla.service';
import { ParticipationReconcileService } from '../engagement/participation-reconcile.service';

@Injectable()
export class PlatformJobsService {
  private readonly logger = new Logger(PlatformJobsService.name);

  constructor(
    private readonly attendanceSlaService: AttendanceSlaService,
    private readonly participationReconcileService: ParticipationReconcileService,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_2AM)
  async runNightlyJobs() {
    if (process.env.DISABLE_PLATFORM_CRON === 'true') {
      return;
    }
    this.logger.log('Starting nightly platform jobs');
    await this.attendanceSlaService.processPartnerAttendanceSla();
    await this.participationReconcileService.reconcileEnrollmentMetadata();
  }

  async runAttendanceSlaNow() {
    return this.attendanceSlaService.processPartnerAttendanceSla();
  }

  async runEnrollmentReconcileNow() {
    return this.participationReconcileService.reconcileEnrollmentMetadata();
  }
}
