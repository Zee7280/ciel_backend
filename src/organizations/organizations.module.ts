import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OrganizationsService } from './organizations.service';
import { OrganizationsController } from './organizations.controller';
import { AdminOrganizationsController } from './admin-organizations.controller';
import { Organization } from './entities/organization.entity';
import { User } from '../users/entities/user.entity';
import { Opportunity } from '../opportunities/entities/opportunity.entity';
import { OpportunityApplication } from '../opportunities/entities/opportunity-application.entity';
import { Timesheet } from '../timesheets/entities/timesheet.entity';
import { Report } from '../reports/entities/report.entity';
import { Participation } from '../engagement/entities/participant.entity';

import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { FacultyUniversityScopeModule } from '../faculty-university-scope/faculty-university-scope.module';

@Module({
    imports: [
        TypeOrmModule.forFeature([Organization, User, Opportunity, OpportunityApplication, Timesheet, Report, Participation]),
        AuditLogsModule,
        FacultyUniversityScopeModule,
    ],
    controllers: [OrganizationsController, AdminOrganizationsController],
    providers: [OrganizationsService],
    exports: [OrganizationsService],
})
export class OrganizationsModule { }
