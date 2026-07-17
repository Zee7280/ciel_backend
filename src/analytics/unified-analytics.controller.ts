import {
  Controller,
  Get,
  Param,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { UserRole } from '../users/enums/user-role.enum';
import { Section1AnalyticsQueryDto } from './dto/section1-analytics-query.dto';
import {
  AnalyticsRequester,
  UnifiedAnalyticsService,
} from './unified-analytics.service';

type AuthenticatedRequest = { user: AnalyticsRequester };

@Controller()
export class UnifiedAnalyticsController {
  constructor(
    private readonly unifiedAnalyticsService: UnifiedAnalyticsService,
  ) {}

  @Get('admin/analytics/overview')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  getAdminOverview(
    @Request() req: AuthenticatedRequest,
    @Query() query: Section1AnalyticsQueryDto,
  ) {
    return this.unifiedAnalyticsService.getOverview(req.user, query, 'ciel');
  }

  @Get('student/projects/:projectId/analytics/overview')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.STUDENT)
  getStudentOverview(
    @Request() req: AuthenticatedRequest,
    @Param('projectId') projectId: string,
  ) {
    return this.unifiedAnalyticsService.getOverview(req.user, {
      project_id: projectId,
      scope: 'project',
    });
  }

  @Get('partners/analytics/overview')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(
    UserRole.NGO,
    UserRole.CORPORATE,
    UserRole.ORGANIZATION_ADMIN,
    UserRole.UNIVERSITY,
  )
  getPartnerOverview(
    @Request() req: AuthenticatedRequest,
    @Query() query: Section1AnalyticsQueryDto,
  ) {
    return this.unifiedAnalyticsService.getOverview(req.user, query);
  }

  @Get('partners/university/analytics/overview')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.UNIVERSITY, UserRole.ORGANIZATION_ADMIN)
  getUniversityOverview(
    @Request() req: AuthenticatedRequest,
    @Query() query: Section1AnalyticsQueryDto,
  ) {
    return this.unifiedAnalyticsService.getOverview(req.user, {
      ...query,
      scope: 'aggregate',
    });
  }

  @Get('faculty/analytics/overview')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.FACULTY)
  getFacultyOverview(
    @Request() req: AuthenticatedRequest,
    @Query() query: Section1AnalyticsQueryDto,
  ) {
    return this.unifiedAnalyticsService.getOverview(req.user, {
      ...query,
      scope: query.project_id ? 'project' : 'aggregate',
    });
  }
}
