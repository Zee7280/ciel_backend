import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from '../users/entities/user.entity';
import { Participation } from '../engagement/entities/participant.entity';
import { AttendanceLog } from '../engagement/entities/attendance-log.entity';
import { StudentReport } from '../reports/entities/student-report.entity';
import { QuickWorkLog } from '../quick-work/entities/quick-work-log.entity';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { CsReportSnapshot } from './entities/cs-report-snapshot.entity';
import { CsReportingService } from './cs-reporting.service';
import { CsReportingController } from './cs-reporting.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      CsReportSnapshot,
      StudentReport,
      Participation,
      AttendanceLog,
      User,
      QuickWorkLog,
    ]),
    AuditLogsModule,
  ],
  controllers: [CsReportingController],
  providers: [CsReportingService],
})
export class CsReportingModule {}
