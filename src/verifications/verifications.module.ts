import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { VerificationsService } from './verifications.service';
import { VerificationsController } from './verifications.controller';
import { Timesheet } from '../timesheets/entities/timesheet.entity';
import { Report } from '../reports/entities/report.entity';
import { OrganizationsModule } from '../organizations/organizations.module';
import { OpportunitiesModule } from '../opportunities/opportunities.module';

@Module({
    imports: [
        TypeOrmModule.forFeature([Timesheet, Report]),
        OrganizationsModule,
        forwardRef(() => OpportunitiesModule)
    ],
    controllers: [VerificationsController],
    providers: [VerificationsService],
})
export class VerificationsModule { }
