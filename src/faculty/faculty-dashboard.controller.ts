import { Controller, Get, Query, Request, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { FacultyDashboardViewMode, FacultyService } from './faculty.service';

import { FacultyAnalyticsQueryDto } from './dto/faculty-analytics-query.dto';

function parseFacultyDashboardView(raw?: string): FacultyDashboardViewMode {
    const v = String(raw ?? '')
        .trim()
        .toLowerCase();
    if (v === 'personal' || v === 'mine' || v === 'my') return 'personal';
    if (v === 'university' || v === 'delegated' || v === 'institution' || v === 'org') return 'university';
    return 'combined';
}

@Controller('faculty')
@UseGuards(JwtAuthGuard)
export class FacultyDashboardController {
    constructor(private readonly facultyService: FacultyService) {}

    @Get('dashboard')
    async getDashboard(
        @Request() req: { user: { id: string; email?: string } },
        @Query('view') viewRaw?: string,
    ) {
        const view = parseFacultyDashboardView(viewRaw);
        return this.facultyService.getDashboard(req.user.id, req.user.email || '', view);
    }

    @Get('analytics')
    async getImpactAnalytics(
        @Request() req: { user: { id: string; email?: string } },
        @Query('view') viewRaw?: string,
        @Query() analyticsQuery?: FacultyAnalyticsQueryDto,
    ) {
        const view = parseFacultyDashboardView(viewRaw);
        return this.facultyService.getImpactAnalytics(
            req.user.id,
            req.user.email || '',
            view,
            analyticsQuery,
        );
    }
}
