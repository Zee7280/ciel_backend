import { Controller, Get, Request, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ImpactSummaryService } from './impact-summary.service';

@Controller('students')
@UseGuards(JwtAuthGuard)
export class ImpactSummaryController {
    constructor(private readonly impactSummaryService: ImpactSummaryService) { }

    @Get('impact/summary')
    async getSummary(@Request() req) {
        const data = await this.impactSummaryService.getSummary(req.user.id);
        return { success: true, data };
    }
}
