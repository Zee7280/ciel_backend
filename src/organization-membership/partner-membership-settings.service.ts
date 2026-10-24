import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Setting } from '../settings/entities/setting.entity';
import {
  CORPORATE_MEMBERSHIP_REQUIRED_KEY,
  PARTNER_MEMBERSHIP_REQUIRED_KEY,
  UNIVERSITY_MEMBERSHIP_REQUIRED_KEY,
  parsePartnerMembershipRequiredSettingValue,
} from './partner-membership.util';

/** Cached "membership fee required" switches (partner, university, corporate); all default to off. */
@Injectable()
export class PartnerMembershipSettingsService implements OnModuleInit {
  private readonly caches = new Map<
    string,
    { enabled: boolean; expiresAt: number }
  >();
  private readonly cacheTtlMs = 300_000;

  constructor(
    @InjectRepository(Setting)
    private readonly settingRepository: Repository<Setting>,
  ) {}

  async onModuleInit(): Promise<void> {
    await Promise.all(
      [
        PARTNER_MEMBERSHIP_REQUIRED_KEY,
        UNIVERSITY_MEMBERSHIP_REQUIRED_KEY,
        CORPORATE_MEMBERSHIP_REQUIRED_KEY,
      ].map((key) => this.refreshCache(key)),
    );
  }

  invalidateCache(key: string = PARTNER_MEMBERSHIP_REQUIRED_KEY): void {
    this.caches.delete(key);
  }

  async refreshCache(
    key: string = PARTNER_MEMBERSHIP_REQUIRED_KEY,
  ): Promise<boolean> {
    const setting = await this.settingRepository.findOne({ where: { key } });
    const enabled = parsePartnerMembershipRequiredSettingValue(
      setting?.value,
      false,
    );
    this.caches.set(key, { enabled, expiresAt: Date.now() + this.cacheTtlMs });
    return enabled;
  }

  isRequiredCached(key: string): boolean {
    return this.caches.get(key)?.enabled ?? false;
  }

  async isRequired(key: string): Promise<boolean> {
    const cached = this.caches.get(key);
    if (cached && Date.now() < cached.expiresAt) {
      return cached.enabled;
    }
    return this.refreshCache(key);
  }

  /** Defaults to false (partners register without fee until admin enables). */
  isPartnerMembershipRequiredCached(): boolean {
    return this.isRequiredCached(PARTNER_MEMBERSHIP_REQUIRED_KEY);
  }

  async isPartnerMembershipRequired(): Promise<boolean> {
    return this.isRequired(PARTNER_MEMBERSHIP_REQUIRED_KEY);
  }
}
