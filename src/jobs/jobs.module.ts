import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PlatformJobsService } from './platform-jobs.service';
import { InternalJobsController } from './internal-jobs.controller';
import { CronSecretGuard } from './cron-secret.guard';
import { AttendanceSlaService } from '../engagement/attendance-sla.service';
import { ParticipationReconcileService } from '../engagement/participation-reconcile.service';
import { AttendanceLog } from '../engagement/entities/attendance-log.entity';
import { Opportunity } from '../opportunities/entities/opportunity.entity';
import { Participation } from '../engagement/entities/participant.entity';
import { User } from '../users/entities/user.entity';
import { MailModule } from '../mail/mail.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { HubJobsDisabledController } from './hub-jobs-disabled.controller';
import { isHubEnabled } from '../integration-hub/hub-connection.constants';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    TypeOrmModule.forFeature([AttendanceLog, Opportunity, Participation, User]),
    MailModule,
    NotificationsModule,
    AuditLogsModule,
  ],
  controllers: [
    InternalJobsController,
    // Hub cron paths answer "skipped" until the hub module (which owns the real handlers) is on.
    ...(isHubEnabled() ? [] : [HubJobsDisabledController]),
  ],
  providers: [
    PlatformJobsService,
    AttendanceSlaService,
    ParticipationReconcileService,
    CronSecretGuard,
  ],
  exports: [
    PlatformJobsService,
    AttendanceSlaService,
    ParticipationReconcileService,
  ],
})
export class JobsModule {}
