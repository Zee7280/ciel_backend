import {
    Controller,
    Get,
    Param,
    ParseIntPipe,
    Query,
    Request,
    UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { UserRole } from '../users/enums/user-role.enum';
import { SectionReportAnalyticsService } from './section-report-analytics.service';
import {
    Section1AnalyticsQueryDto,
    Section1StakeholderAnalyticsQueryDto,
} from './dto/section1-analytics-query.dto';

/**
 * Sections 2–10 analytics + cross-section summary.
 * Section 1 remains on Section1AnalyticsController (unchanged).
 */
@Controller()
export class SectionReportAnalyticsController {
    constructor(
        private readonly sectionReportAnalyticsService: SectionReportAnalyticsService,
    ) {}

    @Get('admin/analytics/section/:section')
    @UseGuards(JwtAuthGuard, RolesGuard)
    @Roles(UserRole.SUPER_ADMIN)
    getAdminSection(
        @Request() req,
        @Param('section', ParseIntPipe) section: number,
        @Query() query: Section1AnalyticsQueryDto,
    ) {
        return this.sectionReportAnalyticsService.getSectionAnalytics(
            section,
            req.user,
            query,
            'ciel',
        );
    }

    @Get('admin/analytics/section/:section/stakeholders')
    @UseGuards(JwtAuthGuard, RolesGuard)
    @Roles(UserRole.SUPER_ADMIN)
    getStakeholderSection(
        @Param('section', ParseIntPipe) section: number,
        @Query() query: Section1StakeholderAnalyticsQueryDto,
    ) {
        return this.sectionReportAnalyticsService.getUnGovernmentSlice(
            section,
            query.slice || 'un',
        );
    }

    @Get('admin/analytics/summary')
    @UseGuards(JwtAuthGuard, RolesGuard)
    @Roles(UserRole.SUPER_ADMIN)
    getAdminSummary(@Request() req, @Query() query: Section1AnalyticsQueryDto) {
        return this.sectionReportAnalyticsService.getSummary(
            req.user,
            query,
            'ciel',
        );
    }

    /** Student sections 2–10 (Section 1 keeps `.../section1-analytics`). */
    @Get('student/projects/:projectId/sections/:section/analytics')
    @UseGuards(JwtAuthGuard, RolesGuard)
    @Roles(UserRole.STUDENT)
    getStudentSectionAnalytics(
        @Request() req,
        @Param('projectId') projectId: string,
        @Param('section', ParseIntPipe) section: number,
    ) {
        return this.sectionReportAnalyticsService.getSectionAnalytics(
            section,
            req.user,
            { project_id: projectId, scope: 'project' },
        );
    }

    @Get('student/projects/:projectId/analytics/summary')
    @UseGuards(JwtAuthGuard, RolesGuard)
    @Roles(UserRole.STUDENT)
    getStudentSummary(@Request() req, @Param('projectId') projectId: string) {
        return this.sectionReportAnalyticsService.getSummary(req.user, {
            project_id: projectId,
            scope: 'project',
        });
    }

    @Get('partners/analytics/section/:section')
    @UseGuards(JwtAuthGuard, RolesGuard)
    @Roles(
        UserRole.NGO,
        UserRole.CORPORATE,
        UserRole.ORGANIZATION_ADMIN,
        UserRole.UNIVERSITY,
    )
    getPartnerSection(
        @Request() req,
        @Param('section', ParseIntPipe) section: number,
        @Query() query: Section1AnalyticsQueryDto,
    ) {
        return this.sectionReportAnalyticsService.getSectionAnalytics(
            section,
            req.user,
            query,
        );
    }

    @Get('partners/analytics/summary')
    @UseGuards(JwtAuthGuard, RolesGuard)
    @Roles(
        UserRole.NGO,
        UserRole.CORPORATE,
        UserRole.ORGANIZATION_ADMIN,
        UserRole.UNIVERSITY,
    )
    getPartnerSummary(@Request() req, @Query() query: Section1AnalyticsQueryDto) {
        return this.sectionReportAnalyticsService.getSummary(req.user, query);
    }

    @Get('partners/university/analytics/section/:section')
    @UseGuards(JwtAuthGuard, RolesGuard)
    @Roles(UserRole.UNIVERSITY, UserRole.ORGANIZATION_ADMIN)
    getUniversitySection(
        @Request() req,
        @Param('section', ParseIntPipe) section: number,
        @Query() query: Section1AnalyticsQueryDto,
    ) {
        return this.sectionReportAnalyticsService.getSectionAnalytics(
            section,
            req.user,
            { ...query, scope: 'aggregate' },
        );
    }

    @Get('partners/university/analytics/summary')
    @UseGuards(JwtAuthGuard, RolesGuard)
    @Roles(UserRole.UNIVERSITY, UserRole.ORGANIZATION_ADMIN)
    getUniversitySummary(
        @Request() req,
        @Query() query: Section1AnalyticsQueryDto,
    ) {
        return this.sectionReportAnalyticsService.getSummary(req.user, {
            ...query,
            scope: 'aggregate',
        });
    }

    @Get('faculty/analytics/section/:section')
    @UseGuards(JwtAuthGuard, RolesGuard)
    @Roles(UserRole.FACULTY)
    getFacultySection(
        @Request() req,
        @Param('section', ParseIntPipe) section: number,
        @Query() query: Section1AnalyticsQueryDto,
    ) {
        return this.sectionReportAnalyticsService.getSectionAnalytics(
            section,
            req.user,
            {
                ...query,
                scope: query.project_id ? 'project' : 'aggregate',
            },
        );
    }

    @Get('faculty/analytics/summary')
    @UseGuards(JwtAuthGuard, RolesGuard)
    @Roles(UserRole.FACULTY)
    getFacultySummary(@Request() req, @Query() query: Section1AnalyticsQueryDto) {
        return this.sectionReportAnalyticsService.getSummary(req.user, {
            ...query,
            scope: query.project_id ? 'project' : 'aggregate',
        });
    }
}
