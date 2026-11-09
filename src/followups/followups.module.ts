import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { StudentReport } from '../reports/entities/student-report.entity';
import { MailModule } from '../mail/mail.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { AiModule } from '../ai/ai.module';
import { ReportFollowUp } from './entities/report-follow-up.entity';
import { FollowUpQuestion } from './entities/follow-up-question.entity';
import { FollowUpDispatch } from './entities/follow-up-dispatch.entity';
import { FollowUpAnswer } from './entities/follow-up-answer.entity';
import { FollowUpOptOut } from './entities/follow-up-opt-out.entity';
import { FollowUpsService } from './followups.service';
import {
  AdminFollowUpsController,
  AdminFollowUpTrackerController,
  MailWebhookController,
  PublicFollowUpsController,
  StudentFollowUpPreviewController,
  StudentFollowUpsController,
} from './followups.controller';

/**
 * Section 9.5 follow-up: activated when CIEL PK publishes a report whose student planned a
 * check, mailed by the nightly job, answered by the partner on a no-login page.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      ReportFollowUp,
      FollowUpQuestion,
      FollowUpDispatch,
      FollowUpAnswer,
      FollowUpOptOut,
      StudentReport,
    ]),
    MailModule,
    NotificationsModule,
    AuditLogsModule,
    AiModule,
  ],
  controllers: [
    AdminFollowUpsController,
    AdminFollowUpTrackerController,
    StudentFollowUpsController,
    StudentFollowUpPreviewController,
    PublicFollowUpsController,
    MailWebhookController,
  ],
  providers: [FollowUpsService],
  exports: [FollowUpsService],
})
export class FollowUpsModule {}
