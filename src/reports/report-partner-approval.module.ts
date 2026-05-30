import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Setting } from '../settings/entities/setting.entity';
import { ReportPartnerApprovalSettingsService } from './report-partner-approval-settings.service';

@Module({
    imports: [TypeOrmModule.forFeature([Setting])],
    providers: [ReportPartnerApprovalSettingsService],
    exports: [ReportPartnerApprovalSettingsService],
})
export class ReportPartnerApprovalModule {}
