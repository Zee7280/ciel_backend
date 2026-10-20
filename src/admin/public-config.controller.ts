import { Controller, Get, Header } from '@nestjs/common';
import { PlatformSettingsService } from '../settings/platform-settings.service';

/** Unauthenticated, read-only platform flags for the public site shell. */
@Controller('public/config')
export class PublicConfigController {
  constructor(private readonly platformSettings: PlatformSettingsService) {}

  @Get()
  // Edge-cacheable for 60s (browser always revalidates): the site shell asks for this on every
  // public page, and admin flag changes still land within a minute.
  @Header(
    'Cache-Control',
    'public, max-age=0, s-maxage=60, stale-while-revalidate=300',
  )
  async getConfig() {
    return {
      success: true,
      data: await this.platformSettings.getPublicConfig(),
    };
  }
}
