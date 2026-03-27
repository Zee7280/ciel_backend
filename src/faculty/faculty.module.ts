import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FacultyReportsController } from './faculty-reports.controller';
import { FacultyReportsService } from '../reports/faculty-reports.service';
import { StudentReport } from '../reports/entities/student-report.entity';
import { AttendanceLog } from '../engagement/entities/attendance-log.entity';
import { User } from '../users/entities/user.entity';

@Module({
    imports: [
        TypeOrmModule.forFeature([StudentReport, AttendanceLog, User]),
    ],
    controllers: [FacultyReportsController],
    providers: [FacultyReportsService],
    exports: [FacultyReportsService],
})
export class FacultyModule { }
