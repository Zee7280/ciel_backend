import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Section1AnalyticsService } from './section1-analytics.service';
import { Section1AnalyticsController } from './section1-analytics.controller';
import { User } from '../users/entities/user.entity';
import { Opportunity } from '../opportunities/entities/opportunity.entity';
import { Participation } from '../engagement/entities/participant.entity';
import { AttendanceLog } from '../engagement/entities/attendance-log.entity';
import { StudentReport } from '../reports/entities/student-report.entity';
import { Organization } from '../organizations/entities/organization.entity';
import { EmailOtp } from '../auth/entities/email-otp.entity';
import { Otp } from '../students/entities/otp.entity';
import { FacultyUniversityScopeModule } from '../faculty-university-scope/faculty-university-scope.module';

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
    controllers: [Section1AnalyticsController],
    providers: [Section1AnalyticsService],
    exports: [Section1AnalyticsService],
})
export class AnalyticsModule {}
