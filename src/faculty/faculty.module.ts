import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FacultyReportsController } from './faculty-reports.controller';
import { FacultyReportsService } from '../reports/faculty-reports.service';
import { FacultyController } from './faculty.controller';
import { FacultyService } from './faculty.service';
import { StudentReport } from '../reports/entities/student-report.entity';
import { AttendanceLog } from '../engagement/entities/attendance-log.entity';
import { User } from '../users/entities/user.entity';
import { Opportunity } from '../opportunities/entities/opportunity.entity';
import { OpportunitiesModule } from '../opportunities/opportunities.module';
import { FacultyApplicationsController } from './faculty-applications.controller';

@Module({
    imports: [
        TypeOrmModule.forFeature([StudentReport, AttendanceLog, User, Opportunity]),
        OpportunitiesModule,
    ],
    controllers: [FacultyReportsController, FacultyController, FacultyApplicationsController],
    providers: [FacultyReportsService, FacultyService],
    exports: [FacultyReportsService, FacultyService],
})
export class FacultyModule { }
