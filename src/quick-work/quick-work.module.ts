import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from '../users/entities/user.entity';
import { FacultyUniversityConfirmation } from '../users/entities/faculty-university-confirmation.entity';
import { AttendanceLog } from '../engagement/entities/attendance-log.entity';
import { MailModule } from '../mail/mail.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { FacultyUniversityScopeModule } from '../faculty-university-scope/faculty-university-scope.module';
import { QuickWorkLog } from './entities/quick-work-log.entity';
import { QuickWorkParticipant } from './entities/quick-work-participant.entity';
import { QuickWorkService } from './quick-work.service';
import {
  AdminQuickWorkController,
  FacultyQuickWorkController,
  QuickWorkCertificateController,
  QuickWorkEmailResponseController,
  QuickWorkFacultyEmailReviewController,
  QuickWorkController,
} from './quick-work.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      QuickWorkLog,
      QuickWorkParticipant,
      User,
      FacultyUniversityConfirmation,
      AttendanceLog,
    ]),
    MailModule,
    NotificationsModule,
    AuditLogsModule,
    FacultyUniversityScopeModule,
  ],
  controllers: [
    QuickWorkCertificateController,
    QuickWorkEmailResponseController,
    QuickWorkFacultyEmailReviewController,
    QuickWorkController,
    FacultyQuickWorkController,
    AdminQuickWorkController,
  ],
  providers: [QuickWorkService],
})
export class QuickWorkModule {}
