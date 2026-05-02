import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FacultyReportsController } from './faculty-reports.controller';
import { FacultyReportsService } from '../reports/faculty-reports.service';
import { FacultyController } from './faculty.controller';
import { FacultyDashboardController } from './faculty-dashboard.controller';
import { FacultyService } from './faculty.service';
import { StudentReport } from '../reports/entities/student-report.entity';
import { AttendanceLog } from '../engagement/entities/attendance-log.entity';
import { User } from '../users/entities/user.entity';
import { Opportunity } from '../opportunities/entities/opportunity.entity';
import { Participation } from '../engagement/entities/participant.entity';
import { Timesheet } from '../timesheets/entities/timesheet.entity';
import { OpportunityApplication } from '../opportunities/entities/opportunity-application.entity';
import { OpportunitiesModule } from '../opportunities/opportunities.module';
import { FacultyApplicationsController } from './faculty-applications.controller';
import { FacultyUniversityScopeModule } from '../faculty-university-scope/faculty-university-scope.module';

@Module({
    imports: [
        TypeOrmModule.forFeature([
            StudentReport,
            AttendanceLog,
            User,
            Opportunity,
            Participation,
            Timesheet,
            OpportunityApplication,
        ]),
        OpportunitiesModule,
        FacultyUniversityScopeModule,
    ],
    controllers: [
        FacultyReportsController,
        FacultyController,
        FacultyDashboardController,
        FacultyApplicationsController,
    ],
    providers: [FacultyReportsService, FacultyService],
    exports: [FacultyReportsService, FacultyService],
})
export class FacultyModule { }
