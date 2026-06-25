import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { UsersModule } from '../users/users.module';
import { User } from '../users/entities/user.entity';
import { Opportunity } from '../opportunities/entities/opportunity.entity';
import { Report } from '../reports/entities/report.entity';
import { StudentReport } from '../reports/entities/student-report.entity';
import { Timesheet } from '../timesheets/entities/timesheet.entity';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { Setting } from '../settings/entities/setting.entity';
import { Participation } from '../engagement/entities/participant.entity';
import { OpportunitiesModule } from '../opportunities/opportunities.module';
import { StudentsModule } from '../students/students.module';
import { IssueLogsModule } from '../issue-logs/issue-logs.module';
import { FacultyUniversityScopeModule } from '../faculty-university-scope/faculty-university-scope.module';
import { OpportunityApplication } from '../opportunities/entities/opportunity-application.entity';
import { AttendanceLog } from '../engagement/entities/attendance-log.entity';
import { AdminProjectEvidenceService } from './admin-project-evidence.service';
import { ReportPartnerApprovalModule } from '../reports/report-partner-approval.module';
import { OrganizationMembershipModule } from '../organization-membership/organization-membership.module';
import { FeedbackModule } from '../feedback/feedback.module';

@Module({
    imports: [
        UsersModule,
        OpportunitiesModule,
        StudentsModule,
        ReportPartnerApprovalModule,
        OrganizationMembershipModule,
        IssueLogsModule,
        FacultyUniversityScopeModule,
        AuditLogsModule,
        FeedbackModule,
        TypeOrmModule.forFeature([
            User,
            Opportunity,
            Report,
            StudentReport,
            Timesheet,
            Setting,
            Participation,
            OpportunityApplication,
            AttendanceLog,
        ]),
    ],
    controllers: [AdminController],
    providers: [AdminService, AdminProjectEvidenceService],
})
export class AdminModule { }
