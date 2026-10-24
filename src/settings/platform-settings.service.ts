import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Setting } from './entities/setting.entity';
import {
  PLATFORM_SETTING_KEYS,
  parseBooleanSetting,
} from './platform-settings.constants';

const TTL_MS = 15_000;

/** Cached read access to the `settings` table for platform-wide switches. */
@Injectable()
export class PlatformSettingsService {
  private cache = new Map<string, { value: string | null; at: number }>();

  constructor(
    @InjectRepository(Setting)
    private readonly settingRepository: Repository<Setting>,
  ) {}

  async getString(key: string): Promise<string | null> {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
    let value: string | null = null;
    try {
      const row = await this.settingRepository.findOne({ where: { key } });
      value = row?.value ?? null;
    } catch {
      // A settings read must never take the API down — fall back to the last known value.
      return hit?.value ?? null;
    }
    this.cache.set(key, { value, at: Date.now() });
    return value;
  }

  async getBool(key: string, fallback: boolean): Promise<boolean> {
    return parseBooleanSetting(await this.getString(key), fallback);
  }

  invalidate(key?: string): void {
    if (key) this.cache.delete(key);
    else this.cache.clear();
  }

  isMaintenanceMode(): Promise<boolean> {
    return this.getBool(PLATFORM_SETTING_KEYS.MAINTENANCE_MODE, false);
  }

  isRegistrationAllowed(): Promise<boolean> {
    return this.getBool(PLATFORM_SETTING_KEYS.ALLOW_REGISTRATIONS, true);
  }

  /** University SSO master switch; a university must also be activated individually. */
  isUniversitySsoEnabled(): Promise<boolean> {
    return this.getBool(PLATFORM_SETTING_KEYS.UNIVERSITY_SSO_ENABLED, false);
  }

  /** Student AI opportunity draft (Generate & Auto-Fill). */
  isAiOpportunityDraftEnabled(): Promise<boolean> {
    return this.getBool(
      PLATFORM_SETTING_KEYS.STUDENT_AI_OPPORTUNITY_DRAFT_ENABLED,
      false,
    );
  }

  /** Gates creating NEW private teams only; existing private teams keep their rules either way. */
  isPrivateTeamEnabled(): Promise<boolean> {
    return this.getBool(
      PLATFORM_SETTING_KEYS.STUDENT_PRIVATE_TEAM_ENABLED,
      false,
    );
  }

  /** Non-sensitive config for the public site shell (GET /public/config). */
  async getPublicConfig() {
    const [
      maintenance,
      allowRegistrations,
      siteName,
      contactEmail,
      reportingFee,
      subscriptionRequired,
      subscriptionFee,
      privateTeamEnabled,
      aiDraftEnabled,
      universitySsoEnabled,
    ] = await Promise.all([
      this.isMaintenanceMode(),
      this.isRegistrationAllowed(),
      this.getString(PLATFORM_SETTING_KEYS.SITE_NAME),
      this.getString(PLATFORM_SETTING_KEYS.CONTACT_EMAIL),
      this.getString(PLATFORM_SETTING_KEYS.REPORTING_FEE_PKR),
      this.getBool(PLATFORM_SETTING_KEYS.STUDENT_SUBSCRIPTION_REQUIRED, true),
      this.getString(PLATFORM_SETTING_KEYS.STUDENT_SUBSCRIPTION_FEE_PKR),
      this.isPrivateTeamEnabled(),
      this.isAiOpportunityDraftEnabled(),
      this.isUniversitySsoEnabled(),
    ]);
    const positiveInt = (raw: string | null, fallback: number) => {
      const n = parseInt(String(raw ?? '').replace(/[^\d]/g, ''), 10);
      return Number.isFinite(n) && n > 0 ? n : fallback;
    };
    return {
      maintenance_mode: maintenance,
      allow_registrations: allowRegistrations,
      site_name: siteName?.trim() || 'CIEL Pakistan',
      contact_email: contactEmail?.trim() || '',
      // Admin-set fees, so the student screens show the live amounts instead of build-time constants.
      reporting_fee_pkr: positiveInt(reportingFee, 200),
      student_subscription_required: subscriptionRequired,
      student_subscription_fee_pkr: positiveInt(subscriptionFee, 300),
      student_private_team_enabled: privateTeamEnabled,
      // Only advertised when this server can actually reach OpenAI.
      student_ai_draft_enabled:
        aiDraftEnabled && Boolean(process.env.OPENAI_API_KEY?.trim()),
      university_sso_enabled: universitySsoEnabled,
    };
  }
}
