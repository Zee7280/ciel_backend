import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  Query,
  Request,
  UseGuards,
  BadRequestException,
  UseInterceptors,
  ParseUUIDPipe,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { SubscriptionActiveGuard } from '../student-subscription/subscription-active.guard';
import { Roles } from '../auth/roles.decorator';
import { UserRole } from '../users/enums/user-role.enum';
import { StudentsService } from './students.service';
import type { StudentOpportunitiesQuery } from './students.service';
import { RedactOpportunityBrowseInterceptor } from '../opportunities/redact-opportunity-secrets.interceptor';
import {
  ApplyOpportunityByIdDto,
  ApplyOpportunityDto,
} from './dto/apply-opportunity.dto';

/** `req.user` as populated by JwtStrategy.validate(). */
type AuthenticatedRequest = { user: { id: string; role: UserRole } };

@Controller('students')
@UseGuards(JwtAuthGuard, RolesGuard, SubscriptionActiveGuard)
@Roles(UserRole.STUDENT, UserRole.SUPER_ADMIN)
export class StudentsController {
  constructor(private readonly studentsService: StudentsService) {}

  @Get('me/dashboard')
  getMyDashboard(@Request() req: AuthenticatedRequest) {
    return this.studentsService.getDashboard(req.user.id);
  }

  @Get('reports')
  getReports(
    @Request() req: AuthenticatedRequest,
    @Query('organisationId') organisationId: string,
  ) {
    if (!organisationId) {
      throw new BadRequestException('organisationId is required');
    }
    return this.studentsService.getReports(req.user.id, organisationId);
  }

  @Get('opportunities')
  @UseInterceptors(RedactOpportunityBrowseInterceptor)
  getOpportunities(
    @Request() req: AuthenticatedRequest,
    @Query() query: StudentOpportunitiesQuery,
  ) {
    // Same rule as the POST sibling below: a `student_id` in the query is only honoured for the
    // caller themselves or an admin — never as a way to read another student's scoped list.
    const requestedStudentId = query?.student_id || query?.studentId;
    const studentContextId =
      requestedStudentId &&
      (req.user?.role === UserRole.SUPER_ADMIN ||
        requestedStudentId === req.user.id)
        ? requestedStudentId
        : req.user.id;

    return this.studentsService.getOpportunities(
      { ...query, student_id: studentContextId },
      studentContextId,
    );
  }

  @Post('opportunities')
  @UseInterceptors(RedactOpportunityBrowseInterceptor)
  getOpportunitiesPost(
    @Request() req: AuthenticatedRequest,
    @Query() query: StudentOpportunitiesQuery,
    @Body() body?: { student_id?: string; studentId?: string },
  ) {
    const requestedStudentId = body?.student_id || body?.studentId;
    const studentContextId =
      requestedStudentId &&
      (req.user?.role === UserRole.SUPER_ADMIN ||
        requestedStudentId === req.user.id)
        ? requestedStudentId
        : req.user.id;

    return this.studentsService.getOpportunities(
      { ...query, ...body, student_id: studentContextId },
      studentContextId,
    );
  }

  @Get('opportunities/recommended')
  @UseInterceptors(RedactOpportunityBrowseInterceptor)
  getRecommendedOpportunities() {
    return this.studentsService.getRecommendedOpportunities();
  }

  @Get('opportunities/:id')
  @UseInterceptors(RedactOpportunityBrowseInterceptor)
  getOpportunityById(
    @Request() req: AuthenticatedRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.studentsService.getOpportunityById(id, req.user.id);
  }

  // Applications
  @Get('applications')
  getApplications(
    @Request() req: AuthenticatedRequest,
    @Query('status') status?: string,
  ) {
    return this.studentsService.getApplications(req.user.id, status);
  }

  @Post('applications')
  applyToOpportunity(
    @Request() req: AuthenticatedRequest,
    @Body() dto: ApplyOpportunityDto,
  ) {
    return this.studentsService.applyToOpportunity(req.user.id, dto);
  }

  @Post('opportunities/:id/apply')
  applyToOpportunityById(
    @Request() req: AuthenticatedRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: ApplyOpportunityByIdDto,
  ) {
    return this.studentsService.applyToOpportunity(req.user.id, {
      ...body,
      opportunityId: id,
    });
  }

  /** Re-send the faculty approval request for an application still with the named faculty (throttled). */
  @Post('applications/:id/remind-faculty')
  remindFacultyForApplication(
    @Request() req: AuthenticatedRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.studentsService.remindFacultyForApplication(req.user.id, id);
  }

  @Delete('applications/:id')
  withdrawApplication(
    @Request() req: AuthenticatedRequest,
    @Param('id') id: string,
  ) {
    return this.studentsService.withdrawApplication(req.user.id, id);
  }

  @Get('impact/history')
  getImpactHistoryGet(
    @Request() req: AuthenticatedRequest,
    @Query('student_id') student_id?: string,
    @Query('studentId') studentId?: string,
  ) {
    return this.studentsService.getImpactHistory(req.user.id, req.user.role, {
      student_id,
      studentId,
    });
  }

  @Post('impact/history')
  getImpactHistory(
    @Request() req: AuthenticatedRequest,
    @Body() body?: { student_id?: string; studentId?: string },
  ) {
    return this.studentsService.getImpactHistory(
      req.user.id,
      req.user.role,
      body,
    );
  }

  @Get('community-service/rankings')
  getCommunityServiceRankings(@Request() req: AuthenticatedRequest) {
    return this.studentsService.getCommunityServiceRankings(req.user.id);
  }
}
