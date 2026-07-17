import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Section1AnalyticsService } from './section1-analytics.service';
import { Section1AnalyticsController } from './section1-analytics.controller';
import { SectionReportAnalyticsService } from './section-report-analytics.service';
import { SectionReportAnalyticsController } from './section-report-analytics.controller';
import { AnalyticsScopeService } from './shared/analytics-scope.service';
import { User } from '../users/entities/user.entity';
import { Opportunity } from '../opportunities/entities/opportunity.entity';
import { Participation } from '../engagement/entities/participant.entity';
import { AttendanceLog } from '../engagement/entities/attendance-log.entity';
import { StudentReport } from '../reports/entities/student-report.entity';
import { Organization } from '../organizations/entities/organization.entity';
import { EmailOtp } from '../auth/entities/email-otp.entity';
import { Otp } from '../students/entities/otp.entity';
import { FacultyUniversityScopeModule } from '../faculty-university-scope/faculty-university-scope.module';
import { UnifiedAnalyticsController } from './unified-analytics.controller';
import { UnifiedAnalyticsService } from './unified-analytics.service';

@Module({
  imports: [
    FacultyUniversityScopeModule,
    TypeOrmModule.forFeature([
      User,
      Opportunity,
      Participation,
      AttendanceLog,
      StudentReport,
      Organization,
      EmailOtp,
      Otp,
    ]),
  ],
  controllers: [
    Section1AnalyticsController,
    SectionReportAnalyticsController,
    UnifiedAnalyticsController,
  ],
  providers: [
    Section1AnalyticsService,
    SectionReportAnalyticsService,
    AnalyticsScopeService,
    UnifiedAnalyticsService,
  ],
  exports: [Section1AnalyticsService, SectionReportAnalyticsService],
})
export class AnalyticsModule {}
