import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Setting } from '../settings/entities/setting.entity';
import {
    evaluateReportRequiresPartnerApproval,
    parseReportPartnerApprovalSettingValue,
    REPORT_PARTNER_APPROVAL_SETTING_KEY,
    type ReportPartnerApprovalInput,
} from './report-partner-approval.util';

@Injectable()
export class ReportPartnerApprovalSettingsService implements OnModuleInit {
    private cache: { enabled: boolean; expiresAt: number } | null = null;
    /** Rarely changes; long TTL avoids repeated settings reads under report verify load. */
    private readonly cacheTtlMs = 300_000;

    constructor(
        @InjectRepository(Setting)
        private readonly settingRepository: Repository<Setting>,
    ) {}

    async onModuleInit(): Promise<void> {
        await this.refreshCache();
    }

    invalidateCache(): void {
        this.cache = null;
    }

    async refreshCache(): Promise<boolean> {
        const setting = await this.settingRepository.findOne({
            where: { key: REPORT_PARTNER_APPROVAL_SETTING_KEY },
        });
        const enabled = parseReportPartnerApprovalSettingValue(setting?.value, true);
        this.cache = { enabled, expiresAt: Date.now() + this.cacheTtlMs };
        return enabled;
    }

    /** Cached platform toggle; defaults to true until first DB read (preserves legacy behavior). */
    isEnabledCached(): boolean {
        if (this.cache && Date.now() < this.cache.expiresAt) {
            return this.cache.enabled;
        }
        return this.cache?.enabled ?? true;
    }

    async isEnabled(): Promise<boolean> {
        if (this.cache && Date.now() < this.cache.expiresAt) {
            return this.cache.enabled;
        }
        return this.refreshCache();
    }

    reportRequiresPartnerApprovalSync(
        report: ReportPartnerApprovalInput,
        hasMeaningfulObjectValue: (value: unknown) => boolean,
    ): boolean {
        return evaluateReportRequiresPartnerApproval(
            report,
            this.isEnabledCached(),
            hasMeaningfulObjectValue,
        );
    }

    async reportRequiresPartnerApproval(
        report: ReportPartnerApprovalInput,
        hasMeaningfulObjectValue: (value: unknown) => boolean,
    ): Promise<boolean> {
        const enabled = await this.isEnabled();
        return evaluateReportRequiresPartnerApproval(report, enabled, hasMeaningfulObjectValue);
    }
}
