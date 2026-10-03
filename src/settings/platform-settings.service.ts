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

  /** Non-sensitive config for the public site shell (GET /public/config). */
  async getPublicConfig() {
    const [maintenance, allowRegistrations, siteName, contactEmail] =
      await Promise.all([
        this.isMaintenanceMode(),
        this.isRegistrationAllowed(),
        this.getString(PLATFORM_SETTING_KEYS.SITE_NAME),
        this.getString(PLATFORM_SETTING_KEYS.CONTACT_EMAIL),
      ]);
    return {
      maintenance_mode: maintenance,
      allow_registrations: allowRegistrations,
      site_name: siteName?.trim() || 'CIEL Pakistan',
      contact_email: contactEmail?.trim() || '',
    };
  }
}
