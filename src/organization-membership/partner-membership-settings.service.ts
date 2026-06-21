import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Setting } from '../settings/entities/setting.entity';
import {
    PARTNER_MEMBERSHIP_REQUIRED_KEY,
    parsePartnerMembershipRequiredSettingValue,
} from './partner-membership.util';

@Injectable()
export class PartnerMembershipSettingsService implements OnModuleInit {
    private cache: { enabled: boolean; expiresAt: number } | null = null;
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
            where: { key: PARTNER_MEMBERSHIP_REQUIRED_KEY },
        });
        const enabled = parsePartnerMembershipRequiredSettingValue(setting?.value, false);
        this.cache = { enabled, expiresAt: Date.now() + this.cacheTtlMs };
        return enabled;
    }

    /** Defaults to false (partners register without fee until admin enables). */
    isPartnerMembershipRequiredCached(): boolean {
        if (this.cache && Date.now() < this.cache.expiresAt) {
            return this.cache.enabled;
        }
        return this.cache?.enabled ?? false;
    }

    async isPartnerMembershipRequired(): Promise<boolean> {
        if (this.cache && Date.now() < this.cache.expiresAt) {
            return this.cache.enabled;
        }
        return this.refreshCache();
    }
}
