import { Module } from '@nestjs/common';
import { PartnersController, PartnerAliasController } from './partners.controller';
import { UsersModule } from '../users/users.module';
import { OrganizationsModule } from '../organizations/organizations.module';
import { ReportsModule } from '../reports/reports.module';
import { OpportunitiesModule } from '../opportunities/opportunities.module';
import { StudentsModule } from '../students/students.module';
import { OrganizationMembershipModule } from '../organization-membership/organization-membership.module';

@Module({
    imports: [
        UsersModule,
        OrganizationsModule,
        ReportsModule,
        OpportunitiesModule,
        StudentsModule,
        OrganizationMembershipModule,
    ],
    controllers: [PartnersController, PartnerAliasController],
})
export class PartnersModule { }
