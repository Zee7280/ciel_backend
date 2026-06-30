import { Module } from '@nestjs/common';
import { StorageModule } from '../common/storage.module';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Participation } from './entities/participant.entity';
import { AttendanceLog } from './entities/attendance-log.entity';
import { EngagementService } from './engagement.service';
import { TeamFormationService } from './team-formation.service';
import { EngagementController } from './engagement.controller';
import { StudentReport } from '../reports/entities/student-report.entity';
import { Opportunity } from '../opportunities/entities/opportunity.entity';
import { OpportunityApplication } from '../opportunities/entities/opportunity-application.entity';
import { User } from '../users/entities/user.entity';

import { MailModule } from '../mail/mail.module';
import { IssueLogsModule } from '../issue-logs/issue-logs.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Participation,
      AttendanceLog,
      Opportunity,
      OpportunityApplication,
      User,
      StudentReport,
    ]),
    StorageModule,
    MailModule,
    IssueLogsModule,
    NotificationsModule,
  ],
  providers: [EngagementService, TeamFormationService],
  controllers: [EngagementController],
  exports: [EngagementService, TeamFormationService],
})
export class EngagementModule {}
