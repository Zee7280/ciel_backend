import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ReportCompletionReminder } from './entities/report-completion-reminder.entity';
import { Opportunity } from '../opportunities/entities/opportunity.entity';
import { Participation } from '../engagement/entities/participant.entity';
import { StudentReport } from '../reports/entities/student-report.entity';
import { User } from '../users/entities/user.entity';
import { MailModule } from '../mail/mail.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { ReportRemindersService } from './report-reminders.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      ReportCompletionReminder,
      Opportunity,
      Participation,
      StudentReport,
      User,
    ]),
    MailModule,
    NotificationsModule,
  ],
  providers: [ReportRemindersService],
  exports: [ReportRemindersService],
})
export class ReportRemindersModule {}
