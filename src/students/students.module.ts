import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { StudentsController } from './students.controller';
import { StudentController } from './student.controller';
import { StudentsService } from './students.service';
import { User } from '../users/entities/user.entity';
import { Participation } from '../engagement/entities/participant.entity';
import { Opportunity } from '../opportunities/entities/opportunity.entity';
import { Timesheet } from '../timesheets/entities/timesheet.entity';
import { StudentReport } from '../reports/entities/student-report.entity';
import { Otp } from './entities/otp.entity';
import { StudentReportsService } from '../reports/student-reports.service';
import { StudentReportsController } from './student-reports.controller';
import { PublicImpactReportsController } from './public-impact-reports.controller';
import { UsersModule } from '../users/users.module';
import { AttendanceLog } from '../engagement/entities/attendance-log.entity';
import { Organization } from '../organizations/entities/organization.entity';
import { Payment } from '../payments/entities/payment.entity';

import { EngagementModule } from '../engagement/engagement.module';
import { OpportunitiesModule } from '../opportunities/opportunities.module';
import { ReportPartnerApprovalModule } from '../reports/report-partner-approval.module';

@Module({
    imports: [
        TypeOrmModule.forFeature([
            User,
            Participation,
            Opportunity,
            Timesheet,
            StudentReport,
            Otp,
            AttendanceLog,
            Organization,
            Payment,
        ]),
        UsersModule,
        EngagementModule,
        OpportunitiesModule,
        ReportPartnerApprovalModule,
    ],
    controllers: [StudentsController, StudentReportsController, StudentController, PublicImpactReportsController],
    providers: [StudentsService, StudentReportsService],
    exports: [StudentsService, StudentReportsService],
})
export class StudentsModule { }
