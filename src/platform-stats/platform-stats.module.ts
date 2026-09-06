import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from '../users/entities/user.entity';
import { Organization } from '../organizations/entities/organization.entity';
import { Opportunity } from '../opportunities/entities/opportunity.entity';
import { Participation } from '../engagement/entities/participant.entity';
import { AttendanceLog } from '../engagement/entities/attendance-log.entity';
import { StudentReport } from '../reports/entities/student-report.entity';
import { CourseProjectEntry } from '../paths/entities/course-project-entry.entity';
import { FypEntry } from '../paths/entities/fyp-entry.entity';
import { VentureEntry } from '../paths/entities/venture-entry.entity';
import { PlatformStatsController } from './platform-stats.controller';
import { PlatformStatsService } from './platform-stats.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      User,
      Organization,
      Opportunity,
      Participation,
      AttendanceLog,
      StudentReport,
      CourseProjectEntry,
      FypEntry,
      VentureEntry,
    ]),
  ],
  controllers: [PlatformStatsController],
  providers: [PlatformStatsService],
})
export class PlatformStatsModule {}
