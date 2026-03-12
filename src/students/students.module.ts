import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { StudentsController } from './students.controller';
import { StudentController } from './student.controller';
import { StudentsService } from './students.service';
import { User } from '../users/entities/user.entity';
import { Participant } from '../engagement/entities/participant.entity';
import { Opportunity } from '../opportunities/entities/opportunity.entity';
import { Timesheet } from '../timesheets/entities/timesheet.entity';
import { OpportunityParticipant } from '../opportunities/entities/opportunity-participant.entity';
import { OpportunityTeamMember } from '../opportunities/entities/opportunity-team-member.entity';
import { StudentReport } from '../reports/entities/student-report.entity';
import { Otp } from './entities/otp.entity';
import { StudentReportsService } from '../reports/student-reports.service';
import { StudentReportsController } from './student-reports.controller';
import { UsersModule } from '../users/users.module';
import { AttendanceLog } from '../engagement/entities/attendance-log.entity';

import { EngagementModule } from '../engagement/engagement.module';

@Module({
    imports: [
        TypeOrmModule.forFeature([User, Participant, Opportunity, Timesheet, OpportunityParticipant, OpportunityTeamMember, StudentReport, Otp, AttendanceLog]),
        UsersModule,
        EngagementModule
    ],
    controllers: [StudentsController, StudentReportsController, StudentController],
    providers: [StudentsService, StudentReportsService],
    exports: [StudentsService, StudentReportsService],
})
export class StudentsModule { }
