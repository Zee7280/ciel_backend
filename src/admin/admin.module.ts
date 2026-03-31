import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { UsersModule } from '../users/users.module';
import { User } from '../users/entities/user.entity';
import { Opportunity } from '../opportunities/entities/opportunity.entity';
import { Report } from '../reports/entities/report.entity';
import { Timesheet } from '../timesheets/entities/timesheet.entity';
import { AuditLog } from '../audit-logs/entities/audit-log.entity';
import { Setting } from '../settings/entities/setting.entity';
import { Participation } from '../engagement/entities/participant.entity';
import { OpportunitiesModule } from '../opportunities/opportunities.module';
import { StudentsModule } from '../students/students.module';

@Module({
    imports: [
        UsersModule,
        OpportunitiesModule,
        StudentsModule,
        TypeOrmModule.forFeature([User, Opportunity, Report, Timesheet, AuditLog, Setting, Participation]),
    ],
    controllers: [AdminController],
    providers: [AdminService],
})
export class AdminModule { }
