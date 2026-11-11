import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ImpactSummaryController } from './impact-summary.controller';
import { ImpactSummaryService } from './impact-summary.service';
import { AttendanceLog } from '../engagement/entities/attendance-log.entity';
import { Participation } from '../engagement/entities/participant.entity';
import { StudentReport } from '../reports/entities/student-report.entity';
import { PathsModule } from '../paths/paths.module';
import { StudentsModule } from '../students/students.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([AttendanceLog, Participation, StudentReport]),
    PathsModule,
    // Exports StudentReportsService: merged (lead + teammate) reports for verified hours.
    StudentsModule,
  ],
  controllers: [ImpactSummaryController],
  providers: [ImpactSummaryService],
})
export class ImpactSummaryModule {}
