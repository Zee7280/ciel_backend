import { Controller, Get, Param, Query, Request, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { UserRole } from '../users/enums/user-role.enum';
import { Section1AnalyticsService } from './section1-analytics.service';
import {
    Section1AnalyticsQueryDto,
    Section1StakeholderAnalyticsQueryDto,
} from './dto/section1-analytics-query.dto';

@Controller()
export class Section1AnalyticsController {
    constructor(private readonly section1AnalyticsService: Section1AnalyticsService) {}

    /** CIEL admin: full Section 1 analytics (basic + premium + restricted). */
    @Get('admin/analytics/section1')
    @UseGuards(JwtAuthGuard, RolesGuard)
    @Roles(UserRole.SUPER_ADMIN)
    getAdminSection1Analytics(@Request() req, @Query() query: Section1AnalyticsQueryDto) {
        return this.section1AnalyticsService.getSection1Analytics(req.user, query, 'ciel');
    }

    /** UN / Government aggregated slice (non-personal). */
    @Get('admin/analytics/section1/stakeholders')
    @UseGuards(JwtAuthGuard, RolesGuard)
    @Roles(UserRole.SUPER_ADMIN)
    getStakeholderSection1Analytics(@Query() query: Section1StakeholderAnalyticsQueryDto) {
        return this.section1AnalyticsService.getUnGovernmentSlice(query.slice || 'un');
    }

    /** Student: own project Section 1 analytics only. */
    @Get('student/projects/:projectId/section1-analytics')
    @UseGuards(JwtAuthGuard, RolesGuard)
    @Roles(UserRole.STUDENT)
    getStudentProjectSection1Analytics(
        @Request() req,
        @Param('projectId') projectId: string,
    ) {
        return this.section1AnalyticsService.getSection1Analytics(req.user, {
            project_id: projectId,
            scope: 'project',
        });
    }

    /** Partner organization: linked project summary analytics. */
    @Get('partners/analytics/section1')
    @UseGuards(JwtAuthGuard, RolesGuard)
    @Roles(UserRole.NGO, UserRole.CORPORATE, UserRole.ORGANIZATION_ADMIN, UserRole.UNIVERSITY)
    getPartnerSection1Analytics(@Request() req, @Query() query: Section1AnalyticsQueryDto) {
        return this.section1AnalyticsService.getSection1Analytics(req.user, query);
    }

    /** University organization: aggregated Section 1 analytics for institution scope. */
    @Get('partners/university/analytics/section1')
    @UseGuards(JwtAuthGuard, RolesGuard)
    @Roles(UserRole.UNIVERSITY, UserRole.ORGANIZATION_ADMIN)
    getUniversitySection1Analytics(@Request() req, @Query() query: Section1AnalyticsQueryDto) {
        return this.section1AnalyticsService.getSection1Analytics(req.user, {
            ...query,
            scope: 'aggregate',
        });
    }

    /** Faculty delegated university view (same aggregate rules as university org). */
    @Get('faculty/analytics/section1')
    @UseGuards(JwtAuthGuard, RolesGuard)
    @Roles(UserRole.FACULTY)
    getFacultySection1Analytics(@Request() req, @Query() query: Section1AnalyticsQueryDto) {
        return this.section1AnalyticsService.getSection1Analytics(req.user, {
            ...query,
            scope: query.project_id ? 'project' : 'aggregate',
        });
    }
}
