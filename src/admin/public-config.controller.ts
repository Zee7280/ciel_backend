import { Controller, Get } from '@nestjs/common';
import { PlatformSettingsService } from '../settings/platform-settings.service';

/** Unauthenticated, read-only platform flags for the public site shell. */
@Controller('public/config')
export class PublicConfigController {
  constructor(private readonly platformSettings: PlatformSettingsService) {}

  @Get()
  async getConfig() {
    return { success: true, data: await this.platformSettings.getPublicConfig() };
  }
}
