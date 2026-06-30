import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PlatformJobsService } from './platform-jobs.service';
import { AttendanceSlaService } from '../engagement/attendance-sla.service';
import { ParticipationReconcileService } from '../engagement/participation-reconcile.service';
import { AttendanceLog } from '../engagement/entities/attendance-log.entity';
import { Opportunity } from '../opportunities/entities/opportunity.entity';
import { Participation } from '../engagement/entities/participant.entity';
import { User } from '../users/entities/user.entity';
import { MailModule } from '../mail/mail.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    TypeOrmModule.forFeature([AttendanceLog, Opportunity, Participation, User]),
    MailModule,
    NotificationsModule,
  ],
  providers: [
    PlatformJobsService,
    AttendanceSlaService,
    ParticipationReconcileService,
  ],
  exports: [
    PlatformJobsService,
    AttendanceSlaService,
    ParticipationReconcileService,
  ],
})
export class JobsModule {}
