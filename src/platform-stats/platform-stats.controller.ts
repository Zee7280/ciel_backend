import { Controller, Get, Header } from '@nestjs/common';
import { PlatformStatsService } from './platform-stats.service';

@Controller('public/platform-stats')
export class PlatformStatsController {
  constructor(private readonly platformStatsService: PlatformStatsService) {}

  @Get()
  @Header(
    'Cache-Control',
    'public, max-age=120, s-maxage=300, stale-while-revalidate=600',
  )
  async getPlatformStats() {
    const data = await this.platformStatsService.getAggregatedStats();
    return { success: true, data };
  }
}
