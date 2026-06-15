import { Controller, Get, Header } from '@nestjs/common';
import { getReportScoringConfig } from './cii-section-weights.constants';

@Controller('public/report-scoring-config')
export class PublicReportScoringController {
    @Get()
    @Header('Cache-Control', 'public, max-age=300, s-maxage=600, stale-while-revalidate=3600')
    getReportScoringConfig() {
        return {
            success: true,
            data: getReportScoringConfig(),
        };
    }
}
