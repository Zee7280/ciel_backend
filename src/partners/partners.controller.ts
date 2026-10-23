import { imageUploadOptions } from '../common/safe-upload';
import {
  Controller,
  Get,
  Body,
  Patch,
  UseGuards,
  Request,
  Post,
  UseInterceptors,
  UploadedFile,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  Put,
  Delete,
  Param,
  Query,
  ParseUUIDPipe,
} from '@nestjs/common';
import { UsersService } from '../users/users.service';
import { OrganizationsService } from '../organizations/organizations.service';
import { UpdateOrganizationDto } from '../organizations/dto/organization.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { UserRole } from '../users/enums/user-role.enum';
import { MembershipActiveGuard } from '../organization-membership/membership-active.guard';
import { FileInterceptor } from '@nestjs/platform-express';
import { ReportsService } from '../reports/reports.service';
import { CreateReportDto } from '../reports/dto/create-report.dto';
import { UpdateReportDto } from '../reports/dto/update-report.dto';
import { OpportunitiesService } from '../opportunities/opportunities.service';
import { GetApplicantsDto } from './dto/get-applicants.dto';
import { UpdateApplicantDto } from './dto/update-applicant.dto';
import { StudentReportsService } from '../reports/student-reports.service';
import { CommunityAwardService } from '../reports/community-award.service';
import { FacultyUniversityScopeService } from '../faculty-university-scope/faculty-university-scope.service';
import { NotifyCommunityAwardDto } from '../reports/dto/notify-community-award.dto';
import { RunIndependentAnalysisDto } from '../faculty/dto/run-independent-analysis.dto';
import { RunIndependentAnalysisBatchDto } from '../faculty/dto/run-independent-analysis-batch.dto';
import { S3Service } from '../common/s3.service';
import { OpportunityApplicationsService } from '../opportunities/opportunity-applications.service';
import { FacultyReportsService } from '../reports/faculty-reports.service';
import { NpeRankingService } from '../ranking/npe-ranking.service';
import { NpeStudioService } from '../ranking/npe-studio.service';
import {
  NpeAnalyzeDto,
  NpeClearReviewDto,
  NpePublishDto,
  NpeStudioDto,
} from '../ranking/dto/npe-ranking.dto';

/** The AI analyzer feeds scores and rankings, so only CIEL PK Admin may run it. */
const ANALYZER_ADMIN_ONLY = 'The AI analyzer can only be run by CIEL PK Admin.';

/**
 * The listing filters a partner may set. `studentId` / `includeHidden` switch findAll onto an
 * admin path that skips the draft, evidence and payment redaction partners must get.
 */
export function partnerReportListQuery(
  query: Record<string, unknown>,
): Record<string, unknown> {
  const allowed = ['status', 'page', 'limit', 'q', 'dateFrom', 'dateTo'];
  return Object.fromEntries(
    Object.entries(query || {}).filter(([key]) => allowed.includes(key)),
  );
}

/**
 * Shape of `req.user` as returned by JwtStrategy.validate. `organizationId` is optional on the
 * token; the handlers that have always forwarded it to a service unchecked keep doing so
 * (`as string`) so the service sees exactly what it saw before.
 */
interface PartnerRequestUser {
  id: string;
  email?: string;
  role?: UserRole;
  organizationId?: string;
  name?: string;
}

interface PartnerRequest {
  user: PartnerRequestUser;
}

/** Optional admin-only override fields accepted on the logo upload form. */
interface LogoUploadBody {
  userId?: string;
  id?: string;
}

@Controller('partners')
@UseGuards(JwtAuthGuard, RolesGuard, MembershipActiveGuard)
@Roles(
  UserRole.UNIVERSITY,
  UserRole.NGO,
  UserRole.CORPORATE,
  UserRole.ORGANIZATION_ADMIN,
)
export class PartnersController {
  constructor(
    private readonly usersService: UsersService,
    private readonly organizationsService: OrganizationsService,
    private readonly reportsService: ReportsService,
    private readonly opportunitiesService: OpportunitiesService,
    private readonly studentReportsService: StudentReportsService,
    private readonly s3Service: S3Service,
    private readonly opportunityApplicationsService: OpportunityApplicationsService,
    private readonly communityAward: CommunityAwardService,
    private readonly npeRanking: NpeRankingService,
    private readonly npeStudio: NpeStudioService,
    private readonly facultyUniversityScope: FacultyUniversityScopeService,
    private readonly facultyReportsService: FacultyReportsService,
  ) {}

  @Get('me')
  async getPartnerProfile(@Request() req: PartnerRequest) {
    const org = await this.organizationsService.getMyOrganization(req.user.id);
    if (!org) {
      return { success: false, message: 'Organization not found' };
    }

    // Map to spec response
    return {
      success: true,
      data: {
        id: org.id,
        name: org.name,
        type: org.orgType,
        description: org.description,
        website: org.websiteUrl,
        city: org.city,
        address: org.address,
        region: org.region,
        country: org.country,
        logo_url: org.logoUrl,
        verification_status: org.verificationStatus, // map if needed
        verification_scope: org.verificationScope,
        works_with_minors: org.worksWithMinors,
        contact: {
          name: org.contactName,
          email: org.contactEmail,
          phone: org.contactPhone,
        },
        compliance: {
          safeguarding_acknowledged: org.safeguardingAcknowledged,
          data_policy_acknowledged: org.dataPolicyAcknowledged,
        },
      },
    };
  }

  @Patch('me')
  async updatePartnerProfile(
    @Request() req: PartnerRequest,
    @Body() updateOrganizationDto: UpdateOrganizationDto,
  ) {
    // We might need to map incoming camelCase/snake_case if DTO doesn't handle it.
    // For now assuming DTO matches or is handled by ValidationPipe
    const updatedOrg = await this.organizationsService.updateMyOrganization(
      req.user.id,
      updateOrganizationDto,
    );
    return { success: true, data: updatedOrg };
  }

  @Post('me/logo')
  @UseInterceptors(FileInterceptor('logo', imageUploadOptions))
  async uploadLogo(
    @Request() req: PartnerRequest,
    @UploadedFile() file: Express.Multer.File,
    @Body() body: LogoUploadBody,
  ) {
    if (!file) {
      throw new BadRequestException('Logo file not provided');
    }

    const logoUrl = await this.s3Service.uploadFile(file, 'logos');

    // A body-supplied userId/id is only honoured for admins — never as a way to overwrite
    // another organization's logo.
    const requestedUserId = body.userId || body.id;
    const targetUserId =
      requestedUserId && req.user?.role === UserRole.SUPER_ADMIN
        ? requestedUserId
        : req.user.id;

    await this.organizationsService.updateMyOrganization(targetUserId, {
      logoUrl,
    });
    return { success: true, data: { logo_url: logoUrl } };
  }

  @Post('profile/logo')
  @UseInterceptors(FileInterceptor('logo', imageUploadOptions))
  async uploadLogoProfile(
    @Request() req: PartnerRequest,
    @UploadedFile() file: Express.Multer.File,
    @Body() body: LogoUploadBody,
  ) {
    return this.uploadLogo(req, file, body);
  }

  @Get('dashboard')
  async getDashboardStats(
    @Request() req: PartnerRequest,
    @Query('id') userId?: string,
  ) {
    let orgId = req.user.organizationId;

    if (userId && req.user?.role === UserRole.SUPER_ADMIN) {
      // Admin-only: fetch another user's org stats (e.g. for support/testing).
      const userOrg = await this.organizationsService.getMyOrganization(userId);
      if (userOrg) {
        orgId = userOrg.id;
      } else {
        throw new BadRequestException(
          'User linked to provided ID has no organization',
        );
      }
    }

    if (!orgId) {
      throw new BadRequestException('User is not linked to an organization');
    }
    return this.organizationsService.getPartnerDashboardStats(orgId);
  }

  @Get('community-service/award-cards')
  async communityAwardCards(@Request() req: PartnerRequest) {
    if (!req.user.organizationId) {
      throw new BadRequestException('User is not linked to an organization');
    }
    const org = await this.organizationsService.getMyOrganization(req.user.id);
    const isUni = String(org?.orgType || '')
      .toLowerCase()
      .includes('university');
    const data = isUni
      ? await this.communityAward.listForUniversity(req.user.organizationId)
      : await this.communityAward.listForPartnerOrg(
          req.user.organizationId,
          await this.opportunitiesService.resolvePartnerLinkedOpportunityIds(
            req.user.id,
          ),
        );
    const decorated = await this.npeRanking.decorateAwardCards(
      data,
      isUni
        ? {
            userId: req.user.id,
            role: 'university',
            organizationId: req.user.organizationId,
            organizationName: org?.name,
          }
        : undefined,
    );
    return {
      success: true,
      data: decorated,
      scope: isUni ? 'university' : 'partner',
    };
  }

  @Post('community-service/award-notify')
  async communityAwardNotify(
    @Request() req: PartnerRequest,
    @Body() dto: NotifyCommunityAwardDto,
  ) {
    if (!req.user.organizationId) {
      throw new BadRequestException('User is not linked to an organization');
    }
    const org = await this.organizationsService.getMyOrganization(req.user.id);
    const isUni = String(org?.orgType || '')
      .toLowerCase()
      .includes('university');
    if (!isUni) {
      throw new ForbiddenException(
        'Only University and CIEL PK Super Admin can run or publish Community Service Ruberix rankings. Partner / NGO can view published ranks only.',
      );
    }
    const pool = await this.communityAward.listForUniversity(
      req.user.organizationId,
    );
    const published = await this.npeRanking.publishedStandings(
      `university:${req.user.organizationId}`,
    );
    const data = await this.communityAward.notifyFromPool(
      pool,
      {
        ...dto,
        kind: 'uni',
        scopeLabel: dto.scopeLabel || `${org?.name} University Cohort`.trim(),
      },
      req.user.name,
      published?.standings ?? null,
    );
    return { success: true, data };
  }

  @Get('community-service/ranking/packages')
  async npeRankingPackages(@Request() req: PartnerRequest) {
    const actor = await this.assertUniversityRankingActor(req);
    const data = await this.npeRanking.listPackages(actor);
    return { success: true, data };
  }

  @Post('community-service/ranking/analyze')
  async npeRankingAnalyze(
    @Request() req: PartnerRequest,
    @Body() dto: NpeAnalyzeDto,
  ) {
    const actor = await this.assertUniversityRankingActor(req);
    const data = await this.npeRanking.analyze(actor, dto);
    return { success: true, data };
  }

  @Post('community-service/ranking/reviews')
  async npeRankingClearReview(
    @Request() req: PartnerRequest,
    @Body() dto: NpeClearReviewDto,
  ) {
    const actor = await this.assertUniversityRankingActor(req);
    const data = await this.npeRanking.clearReview(
      actor,
      dto.runId,
      dto.itemId,
    );
    return { success: true, data };
  }

  @Post('community-service/ranking/studio/preview')
  async npeStudioPreview(
    @Request() req: PartnerRequest,
    @Body() dto: NpeStudioDto,
  ) {
    const actor = await this.assertUniversityRankingActor(req);
    return { success: true, data: await this.npeStudio.preview(actor, dto) };
  }

  @Post('community-service/ranking/studio/publish')
  async npeStudioPublish(
    @Request() req: PartnerRequest,
    @Body() dto: NpeStudioDto,
  ) {
    const actor = await this.assertUniversityRankingActor(req);
    return { success: true, data: await this.npeStudio.publish(actor, dto) };
  }

  @Get('community-service/ranking/studio/history')
  async npeStudioHistory(@Request() req: PartnerRequest) {
    const actor = await this.assertUniversityRankingActor(req);
    return { success: true, data: await this.npeStudio.history(actor) };
  }

  @Get('community-service/ranking/studio/publications/:id')
  async npeStudioPublication(
    @Request() req: PartnerRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    const actor = await this.assertUniversityRankingActor(req);
    return {
      success: true,
      data: await this.npeStudio.getPublication(actor, id),
    };
  }

  @Get('community-service/ranking/studio/project/:reportId')
  async npeStudioProject(
    @Request() req: PartnerRequest,
    @Param('reportId', new ParseUUIDPipe()) reportId: string,
  ) {
    const actor = await this.assertUniversityRankingActor(req);
    return {
      success: true,
      data: await this.npeStudio.rankingsForProject(actor, reportId),
    };
  }

  @Post('community-service/ranking/publish')
  async npeRankingPublish(
    @Request() req: PartnerRequest,
    @Body() dto: NpePublishDto,
  ) {
    const actor = await this.assertUniversityRankingActor(req);
    const data = await this.npeRanking.publish(actor, dto.runId);
    return { success: true, data };
  }

  /** Blocked: independent AI analysis is an admin-only action (see admin/community-service). */
  // The DTO params below stay on the signatures so ValidationPipe still validates the body before the 403.
  @Post('community-service/reports/:id/independent-analysis')
  communityServiceIndependentAnalysis(
    @Body() body: RunIndependentAnalysisDto,
  ): Promise<never> {
    void body;
    return Promise.reject(new ForbiddenException(ANALYZER_ADMIN_ONLY));
  }

  /** Batch counterpart — run independent analysis across several reports from this university's
   * pool at once, so the resulting score/trend update lands on each affected student's My Impact
   * Wall in a single action instead of one report at a time. */
  @Post('community-service/reports/independent-analysis/batch')
  communityServiceIndependentAnalysisBatch(
    @Body() body: RunIndependentAnalysisBatchDto,
  ): Promise<never> {
    void body;
    return Promise.reject(new ForbiddenException(ANALYZER_ADMIN_ONLY));
  }

  /** Read-only CII v4.5 breakdown (section scores + verified highlights, never per-criterion
   * detail) for a single admin-approved report this org can already see via award-cards. */
  @Get('community-service/reports/:id/cii-v4-5')
  async communityServiceCiiV45Breakdown(
    @Request() req: PartnerRequest,
    @Param('id') id: string,
  ) {
    if (!req.user.organizationId) {
      throw new BadRequestException('User is not linked to an organization');
    }
    const org = await this.organizationsService.getMyOrganization(req.user.id);
    const isUni = String(org?.orgType || '')
      .toLowerCase()
      .includes('university');
    if (!isUni) {
      throw new ForbiddenException(
        'The analysis report is not shared with Partner / NGO organisations.',
      );
    }
    const data = await this.communityAward.getCiiV45BreakdownForOrg(
      id,
      req.user.organizationId,
      isUni,
    );
    if (!data) {
      throw new NotFoundException(
        'No admin-approved CII v4.5 record found for this report in your scope.',
      );
    }
    return { success: true, data };
  }

  @Get('community-service/faculty-representatives')
  async communityFacultyRepresentatives(@Request() req: PartnerRequest) {
    if (!req.user.organizationId) {
      throw new BadRequestException('User is not linked to an organization');
    }
    const org = await this.organizationsService.getMyOrganization(req.user.id);
    const isUni = String(org?.orgType || '')
      .toLowerCase()
      .includes('university');
    if (!isUni) {
      throw new ForbiddenException(
        'Faculty representatives are only available for university organizations.',
      );
    }
    const rows =
      await this.facultyUniversityScope.listForUniversityOrganization(
        req.user.organizationId,
      );
    return {
      success: true,
      data: rows.map((r) => ({
        id: r.id,
        faculty_user_id: r.facultyUser?.id,
        faculty_email: r.facultyUser?.email,
        faculty_name: r.facultyUser?.name,
        faculty_department:
          r.facultyUser?.faculty_department || r.facultyUser?.department,
        university_organization_name:
          r.universityOrganization?.name || org?.name,
        created_at: r.createdAt,
        status: 'authorized',
      })),
    };
  }

  /**
   * Faculty whose own profile names this university and who are not authorised anywhere yet —
   * the "awaiting authorisation" tab, so a university sees its faculty without knowing emails.
   */
  @Get('community-service/faculty-representatives/awaiting')
  async communityFacultyAwaitingAuthorisation(@Request() req: PartnerRequest) {
    if (!req.user.organizationId) {
      throw new BadRequestException('User is not linked to an organization');
    }
    const org = await this.organizationsService.getMyOrganization(req.user.id);
    if (!org || !this.facultyUniversityScope.isUniversityOrganization(org)) {
      throw new ForbiddenException(
        'Faculty representatives are only available for university organizations.',
      );
    }
    const faculty =
      await this.facultyUniversityScope.listFacultyAwaitingAuthorisation(
        req.user.organizationId,
      );
    return {
      success: true,
      data: faculty.map((f) => ({
        id: `awaiting-${f.id}`,
        faculty_user_id: f.id,
        faculty_email: f.email,
        faculty_name: f.name,
        faculty_department: f.faculty_department || f.department,
        status: 'awaiting',
      })),
    };
  }

  @Post('community-service/faculty-representatives')
  async allocateFacultyRepresentative(
    @Request() req: PartnerRequest,
    @Body() body: { faculty_email?: string },
  ) {
    if (!req.user.organizationId) {
      throw new BadRequestException('User is not linked to an organization');
    }
    const org = await this.organizationsService.getMyOrganization(req.user.id);
    const isUni = String(org?.orgType || '')
      .toLowerCase()
      .includes('university');
    if (!isUni) {
      throw new ForbiddenException(
        'Faculty representatives are only available for university organizations.',
      );
    }
    const saved = await this.facultyUniversityScope.assignByUniversityOperator({
      facultyEmail: String(body?.faculty_email || ''),
      universityOrganizationId: req.user.organizationId,
      operatorUserId: req.user.id,
    });
    return {
      success: true,
      data: {
        id: saved.id,
        faculty_user_id: saved.facultyUser?.id,
        faculty_email: saved.facultyUser?.email,
        faculty_name: saved.facultyUser?.name,
        status: 'authorized',
      },
    };
  }

  @Delete('community-service/faculty-representatives/:facultyUserId')
  async revokeFacultyRepresentative(
    @Request() req: PartnerRequest,
    @Param('facultyUserId') facultyUserId: string,
  ) {
    if (!req.user.organizationId) {
      throw new BadRequestException('User is not linked to an organization');
    }
    const org = await this.organizationsService.getMyOrganization(req.user.id);
    const isUni = String(org?.orgType || '')
      .toLowerCase()
      .includes('university');
    if (!isUni) {
      throw new ForbiddenException(
        'Faculty representatives are only available for university organizations.',
      );
    }
    await this.facultyUniversityScope.removeForUniversityOrganization(
      facultyUserId,
      req.user.organizationId,
    );
    return { success: true };
  }

  /** University-organization participation & verification analytics (403 for non-university orgs). */
  @Get('university/analytics')
  async getUniversityAnalytics(@Request() req: PartnerRequest) {
    const orgId = req.user.organizationId;
    if (!orgId) {
      throw new BadRequestException('User is not linked to an organization');
    }
    return this.organizationsService.getUniversityAnalytics(orgId);
  }

  /** Partner org: students assigned to this partner’s opportunities, mix and required hours. */
  @Get('students/analytics')
  async getPartnerStudentsAnalytics(@Request() req: PartnerRequest) {
    const orgId = req.user.organizationId;
    if (!orgId) {
      throw new BadRequestException('User is not linked to an organization');
    }
    return this.organizationsService.getPartnerStudentsAnalytics(orgId);
  }

  @Get('impact/metrics')
  async getImpactMetrics(@Request() req: PartnerRequest) {
    const orgId = req.user.organizationId;
    if (!orgId) {
      throw new BadRequestException('User is not linked to an organization');
    }
    return this.organizationsService.getPartnerImpactMetrics(orgId);
  }

  // Reports Endpoints
  /** NGO-only impact-form CRUD (legacy `Report` entity) — NOT the same feature as singular
   * `/partner/reports` on PartnerAliasController below, which returns community-service
   * StudentReport dossiers. See that controller's class comment for the full explanation. */
  @Get('reports')
  getReports(
    @Request() req: PartnerRequest,
    @Query() query: Record<string, unknown>,
  ) {
    return this.reportsService.findAllForPartner(
      req.user.organizationId as string,
      query,
    );
  }

  @Post('reports')
  createReport(@Request() req: PartnerRequest, @Body() dto: CreateReportDto) {
    return this.reportsService.createReport(
      req.user.organizationId as string,
      dto,
    );
  }

  @Put('reports/:id')
  updateReport(
    @Request() req: PartnerRequest,
    @Param('id') id: string,
    @Body() dto: UpdateReportDto,
  ) {
    return this.reportsService.updateReport(
      id,
      req.user.organizationId as string,
      dto,
    );
  }

  @Delete('reports/:id')
  deleteReport(@Request() req: PartnerRequest, @Param('id') id: string) {
    return this.reportsService.deleteReport(
      id,
      req.user.organizationId as string,
    );
  }

  // Get Applicants for an Opportunity
  @Post('opportunities/applicants')
  async getApplicants(
    @Request() req: PartnerRequest,
    @Body() dto: GetApplicantsDto,
  ) {
    if (!req.user.organizationId) {
      throw new BadRequestException('User is not linked to an organization');
    }

    const applicants =
      await this.opportunitiesService.getApplicantsForOpportunity(
        dto.id,
        req.user.organizationId,
      );
    return { success: true, data: applicants };
  }

  // Update Applicant Status
  @Post('opportunities/applicants/update')
  async updateApplicantStatus(
    @Request() req: PartnerRequest,
    @Body() dto: UpdateApplicantDto,
  ) {
    if (!req.user.organizationId) {
      throw new BadRequestException('User is not linked to an organization');
    }

    return this.opportunitiesService.updateApplicantStatus(
      dto.applicantId,
      dto.status,
      req.user.organizationId,
    );
  }

  /** Student join requests on this org's listings: faculty-approved → partner (if required) → CIEL admin. */
  @Get('opportunity-applications')
  listOpportunityApplications(
    @Request() req: PartnerRequest,
    @Query('status') status?: 'pending' | 'history',
  ) {
    if (!req.user.organizationId) {
      throw new BadRequestException('User is not linked to an organization');
    }
    return this.opportunityApplicationsService.partnerList(
      req.user.organizationId,
      status === 'history' ? 'history' : 'pending',
    );
  }

  @Post('opportunity-applications/:id/approve')
  approveOpportunityApplication(
    @Request() req: PartnerRequest,
    @Param('id') id: string,
  ) {
    if (!req.user.organizationId) {
      throw new BadRequestException('User is not linked to an organization');
    }
    return this.opportunityApplicationsService.partnerApprove(
      id,
      req.user.organizationId,
    );
  }

  @Post('opportunity-applications/:id/reject')
  rejectOpportunityApplication(
    @Request() req: PartnerRequest,
    @Param('id') id: string,
    @Body() body: { reason?: string },
  ) {
    if (!req.user.organizationId) {
      throw new BadRequestException('User is not linked to an organization');
    }
    return this.opportunityApplicationsService.partnerReject(
      id,
      req.user.organizationId,
      body?.reason || '',
    );
  }

  @Get('student-reports')
  async getStudentReports(
    @Request() req: PartnerRequest,
    @Query() query: Record<string, unknown>,
  ) {
    if (!req.user.organizationId) {
      throw new BadRequestException('User is not linked to an organization');
    }
    const org = await this.organizationsService.getMyOrganization(req.user.id);
    const isUniversity = Boolean(
      org && this.facultyUniversityScope.isUniversityOrganization(org),
    );
    return this.studentReportsService.findAll(
      {
        ...partnerReportListQuery(query),
        organizationId: req.user.organizationId,
      },
      {
        partnerView: !isUniversity,
        linkedOpportunityIds: isUniversity
          ? []
          : await this.opportunitiesService.resolvePartnerLinkedOpportunityIds(
              req.user.id,
            ),
      },
    );
  }

  @Get('student-reports/:id')
  async getStudentReportById(
    @Request() req: PartnerRequest,
    @Param('id') id: string,
  ) {
    return this.studentReportsService.findOneForPartner(
      id,
      req.user.organizationId as string,
      {
        viewerRole: req.user.role,
        partnerLinkedOpportunityIds:
          await this.opportunitiesService.resolvePartnerLinkedOpportunityIds(
            req.user.id,
          ),
      },
    );
  }

  @Patch('student-reports/:id/verify')
  @Post('student-reports/:id/verify')
  verifyStudentReport() {
    throw new ForbiddenException(
      'Report approval is handled by CIEL PK Admin only. Partners can open the published package read-only.',
    );
  }

  // Faculty are legitimate callers here: the Faculty Approvals dashboard routes
  // `partner_ack` rows to these endpoints when the faculty user's email matches the
  // opportunity's designated partner-reviewer email (see FacultyService). The service
  // still gates the action via assertPartnerCanReviewOpportunity's email/org match.
  @Roles(
    UserRole.UNIVERSITY,
    UserRole.NGO,
    UserRole.CORPORATE,
    UserRole.ORGANIZATION_ADMIN,
    UserRole.FACULTY,
  )
  @Post('approvals/:id/approve')
  async approveOpportunity(
    @Request() req: PartnerRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    const saved = await this.opportunitiesService.partnerDashboardApprove(id, {
      email: req.user.email || '',
      organizationId: req.user.organizationId || null,
      id: req.user.id,
      name: req.user.name,
    });
    return {
      success: true,
      message: 'Partner approval completed',
      data: {
        id: saved.id,
        partner_approval_status: saved.partnerApprovalStatus,
        workflow_stage: saved.workflowStage,
      },
    };
  }

  @Roles(
    UserRole.UNIVERSITY,
    UserRole.NGO,
    UserRole.CORPORATE,
    UserRole.ORGANIZATION_ADMIN,
    UserRole.FACULTY,
  )
  @Post('approvals/:id/reject')
  async rejectOpportunity(
    @Request() req: PartnerRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: { reason?: string },
  ) {
    const saved = await this.opportunitiesService.partnerDashboardReject(
      id,
      {
        email: req.user.email || '',
        organizationId: req.user.organizationId || null,
        id: req.user.id,
        name: req.user.name,
      },
      body?.reason,
    );
    return {
      success: true,
      message: 'Partner permanent rejection submitted',
      data: {
        id: saved.id,
        partner_approval_status: saved.partnerApprovalStatus,
        workflow_stage: saved.workflowStage,
      },
    };
  }

  @Roles(
    UserRole.UNIVERSITY,
    UserRole.NGO,
    UserRole.CORPORATE,
    UserRole.ORGANIZATION_ADMIN,
    UserRole.FACULTY,
  )
  @Post('approvals/:id/revise')
  async reviseOpportunity(
    @Request() req: PartnerRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: { reason?: string },
  ) {
    const saved = await this.opportunitiesService.partnerDashboardRevise(
      id,
      {
        email: req.user.email || '',
        organizationId: req.user.organizationId || null,
        id: req.user.id,
        name: req.user.name,
      },
      body?.reason,
    );
    return {
      success: true,
      message: 'Partner revision request submitted',
      data: {
        id: saved.id,
        partner_approval_status: saved.partnerApprovalStatus,
        workflow_stage: saved.workflowStage,
      },
    };
  }

  private async assertUniversityRankingActor(req: {
    user: { id: string; organizationId?: string };
  }) {
    if (!req.user.organizationId) {
      throw new BadRequestException('User is not linked to an organization');
    }
    const org = await this.organizationsService.getMyOrganization(req.user.id);
    const isUni = String(org?.orgType || '')
      .toLowerCase()
      .includes('university');
    if (!isUni) {
      throw new ForbiddenException(
        'Only University and CIEL PK Super Admin can run or publish national rankings. Partner / NGO can view published ranks only.',
      );
    }
    return {
      userId: req.user.id,
      role: 'university' as const,
      organizationId: req.user.organizationId,
      organizationName: org?.name || null,
    };
  }
}

// Explicit alias controller for singular /partner routes.
// NOTE: `reports` below is NOT actually an alias of PartnersController's plural `/partners/reports`
// — despite the class-level comment, the two intentionally serve different, unrelated features:
// this one returns community-service StudentReport dossiers (university/partner report review),
// while plural `/partners/reports` backs the separate NGO-only impact-form CRUD (legacy `Report`
// entity, see ReportsService). Do not "fix" one to match the other without confirming with product
// which feature a given caller actually wants — the frontend deliberately calls both for different
// screens (see partners/reports/page.tsx and components/partners/ReportForm.tsx).
@Controller('partner')
@UseGuards(JwtAuthGuard, RolesGuard, MembershipActiveGuard)
@Roles(
  UserRole.UNIVERSITY,
  UserRole.NGO,
  UserRole.CORPORATE,
  UserRole.ORGANIZATION_ADMIN,
)
export class PartnerAliasController {
  constructor(
    private readonly studentReportsService: StudentReportsService,
    private readonly opportunitiesService: OpportunitiesService,
    private readonly opportunityApplicationsService: OpportunityApplicationsService,
    private readonly organizationsService: OrganizationsService,
    private readonly facultyUniversityScope: FacultyUniversityScopeService,
  ) {}

  /** Community-service StudentReport dossiers for this partner org — NOT the same feature as
   * plural `/partners/reports` (NGO impact-form CRUD, legacy `Report` entity). See class comment. */
  @Get('reports')
  async getReports(
    @Request() req: PartnerRequest,
    @Query() query: Record<string, unknown>,
  ) {
    if (!req.user.organizationId) {
      throw new BadRequestException('User is not linked to an organization');
    }
    const org = await this.organizationsService.getMyOrganization(req.user.id);
    if (org && this.facultyUniversityScope.isUniversityOrganization(org)) {
      const access = await this.facultyUniversityScope.universityReportAccess(
        org.id,
      );
      return this.studentReportsService.findAllByOpportunityIds(
        access.opportunityIds,
        partnerReportListQuery(query),
        { restrictTo: access.restrictTo },
      );
    }
    return this.studentReportsService.findAll(
      {
        ...partnerReportListQuery(query),
        organizationId: req.user.organizationId,
      },
      {
        partnerView: true,
        linkedOpportunityIds:
          await this.opportunitiesService.resolvePartnerLinkedOpportunityIds(
            req.user.id,
          ),
      },
    );
  }

  @Get('opportunity-applications')
  listOpportunityApplications(
    @Request() req: PartnerRequest,
    @Query('status') status?: 'pending' | 'history',
  ) {
    if (!req.user.organizationId) {
      throw new BadRequestException('User is not linked to an organization');
    }
    return this.opportunityApplicationsService.partnerList(
      req.user.organizationId,
      status === 'history' ? 'history' : 'pending',
    );
  }

  @Post('opportunity-applications/:id/approve')
  approveOpportunityApplication(
    @Request() req: PartnerRequest,
    @Param('id') id: string,
  ) {
    if (!req.user.organizationId) {
      throw new BadRequestException('User is not linked to an organization');
    }
    return this.opportunityApplicationsService.partnerApprove(
      id,
      req.user.organizationId,
    );
  }

  @Post('opportunity-applications/:id/reject')
  rejectOpportunityApplication(
    @Request() req: PartnerRequest,
    @Param('id') id: string,
    @Body() body: { reason?: string },
  ) {
    if (!req.user.organizationId) {
      throw new BadRequestException('User is not linked to an organization');
    }
    return this.opportunityApplicationsService.partnerReject(
      id,
      req.user.organizationId,
      body?.reason || '',
    );
  }

  @Get('reports/:id')
  async getReportById(@Request() req: PartnerRequest, @Param('id') id: string) {
    // The university dashboard lists reports on every institution-linked opportunity (see
    // getReports above), so the same scope must be readable here — read-only, not reviewable.
    let universityScopeOpportunityIds: string[] = [];
    let universityReportScope:
      | ((report: { studentId?: string | null }) => Promise<boolean>)
      | undefined;
    let partnerLinkedOpportunityIds: string[] = [];
    if (req.user.organizationId) {
      const org = await this.organizationsService.getMyOrganization(
        req.user.id,
      );
      if (org && this.facultyUniversityScope.isUniversityOrganization(org)) {
        const access = await this.facultyUniversityScope.universityReportAccess(
          org.id,
        );
        universityScopeOpportunityIds = access.opportunityIds;
        universityReportScope = access.includes;
      } else {
        partnerLinkedOpportunityIds =
          await this.opportunitiesService.resolvePartnerLinkedOpportunityIds(
            req.user.id,
          );
      }
    }
    return this.studentReportsService.findOneForPartner(
      id,
      req.user.organizationId as string,
      {
        universityScopeOpportunityIds,
        universityReportScope,
        partnerLinkedOpportunityIds,
        viewerRole: req.user.role,
      },
    );
  }

  @Patch('reports/:id/verify')
  @Post('reports/:id/verify')
  verifyReport() {
    throw new ForbiddenException(
      'Report approval is handled by CIEL PK Admin only. Partners can open the published package read-only.',
    );
  }

  @Post('opportunities/applicants')
  async getApplicants(
    @Request() req: PartnerRequest,
    @Body() dto: GetApplicantsDto,
  ) {
    if (!req.user.organizationId) {
      throw new BadRequestException('User is not linked to an organization');
    }

    const applicants =
      await this.opportunitiesService.getApplicantsForOpportunity(
        dto.id,
        req.user.organizationId,
      );
    return { success: true, data: applicants };
  }

  @Post('opportunities/applicants/update')
  async updateApplicantStatus(
    @Request() req: PartnerRequest,
    @Body() dto: UpdateApplicantDto,
  ) {
    if (!req.user.organizationId) {
      throw new BadRequestException('User is not linked to an organization');
    }

    return this.opportunitiesService.updateApplicantStatus(
      dto.applicantId,
      dto.status,
      req.user.organizationId,
    );
  }

  // Faculty are legitimate callers here: the Faculty Approvals dashboard routes
  // `partner_ack` rows to these endpoints when the faculty user's email matches the
  // opportunity's designated partner-reviewer email (see FacultyService). The service
  // still gates the action via assertPartnerCanReviewOpportunity's email/org match.
  @Roles(
    UserRole.UNIVERSITY,
    UserRole.NGO,
    UserRole.CORPORATE,
    UserRole.ORGANIZATION_ADMIN,
    UserRole.FACULTY,
  )
  @Post('approvals/:id/approve')
  async approveOpportunity(
    @Request() req: PartnerRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    const saved = await this.opportunitiesService.partnerDashboardApprove(id, {
      email: req.user.email || '',
      organizationId: req.user.organizationId || null,
      id: req.user.id,
      name: req.user.name,
    });
    return {
      success: true,
      message: 'Partner approval completed',
      data: {
        id: saved.id,
        partner_approval_status: saved.partnerApprovalStatus,
        workflow_stage: saved.workflowStage,
      },
    };
  }

  @Roles(
    UserRole.UNIVERSITY,
    UserRole.NGO,
    UserRole.CORPORATE,
    UserRole.ORGANIZATION_ADMIN,
    UserRole.FACULTY,
  )
  @Post('approvals/:id/reject')
  async rejectOpportunity(
    @Request() req: PartnerRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: { reason?: string },
  ) {
    const saved = await this.opportunitiesService.partnerDashboardReject(
      id,
      {
        email: req.user.email || '',
        organizationId: req.user.organizationId || null,
        id: req.user.id,
        name: req.user.name,
      },
      body?.reason,
    );
    return {
      success: true,
      message: 'Partner permanent rejection submitted',
      data: {
        id: saved.id,
        partner_approval_status: saved.partnerApprovalStatus,
        workflow_stage: saved.workflowStage,
      },
    };
  }

  @Roles(
    UserRole.UNIVERSITY,
    UserRole.NGO,
    UserRole.CORPORATE,
    UserRole.ORGANIZATION_ADMIN,
    UserRole.FACULTY,
  )
  @Post('approvals/:id/revise')
  async reviseOpportunity(
    @Request() req: PartnerRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: { reason?: string },
  ) {
    const saved = await this.opportunitiesService.partnerDashboardRevise(
      id,
      {
        email: req.user.email || '',
        organizationId: req.user.organizationId || null,
        id: req.user.id,
        name: req.user.name,
      },
      body?.reason,
    );
    return {
      success: true,
      message: 'Partner revision request submitted',
      data: {
        id: saved.id,
        partner_approval_status: saved.partnerApprovalStatus,
        workflow_stage: saved.workflowStage,
      },
    };
  }
}
