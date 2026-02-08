import { Module } from '@nestjs/common';
import { PartnersController } from './partners.controller';
import { UsersModule } from '../users/users.module';
import { OrganizationsModule } from '../organizations/organizations.module';
import { ReportsModule } from '../reports/reports.module';
import { OpportunitiesModule } from '../opportunities/opportunities.module';

@Module({
    imports: [UsersModule, OrganizationsModule, ReportsModule, OpportunitiesModule],
    controllers: [PartnersController],
})
export class PartnersModule { }
