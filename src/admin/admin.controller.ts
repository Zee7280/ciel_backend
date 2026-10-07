import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  UseGuards,
  Query,
  Request,
  UseInterceptors,
  Res,
  NotFoundException,
  BadRequestException,
  ParseUUIDPipe,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { Response } from 'express';
import { AdminMutationAuditInterceptor } from '../audit-logs/admin-mutation-audit.interceptor';
import { UsersService } from '../users/users.service';
import { AdminCreateUserDto } from '../users/dto/admin-create-user.dto';
import { UpdateUserDto } from '../users/dto/update-user.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { UserRole } from '../users/enums/user-role.enum';

import { AdminService } from './admin.service';
import { AdminProjectEvidenceService } from './admin-project-evidence.service';
import { MasterAnalyticsQueryDto } from './dto/master-analytics-query.dto';
import { SetSettingDto } from './dto/set-setting.dto';
import { AdminReasonDto } from './dto/admin-reason.dto';
import { AdminReportVerifyDto } from './dto/admin-report-verify.dto';
import { RemindZeroHoursDto } from './dto/remind-zero-hours.dto';
import { AuthService } from '../auth/auth.service';
import { OpportunitiesService } from '../opportunities/opportunities.service';
import { StudentReportsService } from '../reports/student-reports.service';
import { CommunityAwardService } from '../reports/community-award.service';
import { NotifyCommunityAwardDto } from '../reports/dto/notify-community-award.dto';
import { AdminMergeReportsDto } from '../reports/dto/admin-merge-reports.dto';
import { AdminDeleteReportDto } from '../reports/dto/admin-delete-report.dto';
import { SetAttendanceEditableDto } from './dto/set-attendance-editable.dto';
import { AdminDedupeStudentSeatsDto } from './dto/admin-dedupe-student-seats.dto';
import { OpportunityApplicationsService } from '../opportunities/opportunity-applications.service';
import { IssueLogsService } from '../issue-logs/issue-logs.service';
import type { IssueLogListQuery } from '../issue-logs/issue-logs.service';
import { PlatformJobsService } from '../jobs/platform-jobs.service';
import { FacultyReportsService } from '../reports/faculty-reports.service';
import { RunIndependentAnalysisDto } from '../faculty/dto/run-independent-analysis.dto';
import { RunIndependentAnalysisBatchDto } from '../faculty/dto/run-independent-analysis-batch.dto';
import { ApproveCiiV45Dto } from '../faculty/dto/approve-cii-v4-5.dto';
import { NpeRankingService } from '../ranking/npe-ranking.service';
import {
  NpeAnalyzeDto,
  NpeClearReviewDto,
  NpePublishDto,
} from '../ranking/dto/npe-ranking.dto';

/** Never echo credential material (password hash / deprecated password record) back to the browser. */
function stripUserSecrets<T>(user: T): T {
  if (!user || typeof user !== 'object') return user;
  const {
    password: _password,
    passwordRecord: _record,
    passwordResetToken: _token,
    passwordResetExpiry: _expiry,
    ...safe
  } = user as Record<string, unknown>;
  return safe as T;
}

@Controller('admin')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.SUPER_ADMIN)
@UseInterceptors(AdminMutationAuditInterceptor)
export class AdminController {
  constructor(
    private readonly usersService: UsersService,
    private readonly adminService: AdminService,
    private readonly opportunitiesService: OpportunitiesService,
    private readonly studentReportsService: StudentReportsService,
    private readonly communityAward: CommunityAwardService,
    private readonly npeRanking: NpeRankingService,
    private readonly opportunityApplicationsService: OpportunityApplicationsService,
    private readonly issueLogsService: IssueLogsService,
    private readonly adminProjectEvidenceService: AdminProjectEvidenceService,
    private readonly platformJobsService: PlatformJobsService,
    private readonly facultyReportsService: FacultyReportsService,
    private readonly moduleRef: ModuleRef,
  ) {}

  @Post('jobs/attendance-sla')
  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  runAttendanceSlaJob() {
    return this.platformJobsService.runAttendanceSlaNow();
  }

  @Post('jobs/enrollment-reconcile')
  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  runEnrollmentReconcileJob() {
    return this.platformJobsService.runEnrollmentReconcileNow();
  }

  @Get('dashboard')
  getDashboard() {
    return this.adminService.getDashboardStats();
  }

  /** Sidebar badge counts — COUNT queries only, same definitions as the admin list pages. */
  @Get('pending-counts')
  async getPendingCounts() {
    return { success: true, data: await this.adminService.getPendingCounts() };
  }

  /** CIEL Master: platform-wide participants, verification, university diversity, participation mix, required hours, growth. Optional query params AND-filter the participation cohort. */
  @Get('master-analytics')
  getMasterAnalytics(@Query() query: MasterAnalyticsQueryDto) {
    return this.adminService.getMasterAnalytics(query);
  }

  @Get('applications')
  getOpportunityApplications(@Query('status') status?: string) {
    return this.opportunityApplicationsService.adminList(status);
  }

  @Post('applications/:id/approve')
  approveOpportunityApplication(@Request() req, @Param('id') id: string) {
    return this.opportunityApplicationsService.adminApprove(id, req.user.id);
  }

  @Post('applications/:id/reject')
  rejectOpportunityApplication(
    @Request() req,
    @Param('id') id: string,
    @Body() body: AdminReasonDto,
  ) {
    return this.opportunityApplicationsService.adminReject(
      id,
      req.user.id,
      body?.reason || '',
    );
  }

  @Get('users/pending')
  getPendingApplications() {
    return this.adminService.findPendingApplications();
  }

  @Post('users/:id/approve')
  approveApplication(@Request() req, @Param('id') id: string) {
    return this.adminService.approveApplication(id, req.user.id);
  }

  @Post('users/:id/reject')
  rejectApplication(
    @Request() req,
    @Param('id') id: string,
    @Body() body: AdminReasonDto,
  ) {
    return this.adminService.rejectApplication(
      id,
      body?.reason || '',
      req.user.id,
    );
  }

  // Opportunity approve / reject / revise / status live in AdminOpportunitiesController
  // (src/opportunities), which passes the acting admin. They were duplicated here without the actor.

  @Delete('opportunities/:id')
  removeOpportunity(
    @Request() req,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.opportunitiesService.remove(id, req.user.id);
  }

  @Get('projects/evidence-overview')
  getProjectsEvidenceOverview() {
    return this.adminProjectEvidenceService.getEvidenceOverview();
  }

  @Get('projects/:opportunityId/evidence/download')
  downloadProjectEvidence(
    @Param('opportunityId') opportunityId: string,
    @Res() res: Response,
  ) {
    return this.adminProjectEvidenceService.streamProjectEvidenceZip(
      opportunityId,
      res,
    );
  }

  @Get('projects')
  getProjects(
    @Query('student_email') studentEmail?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('fields') fields?: string,
  ) {
    return this.adminService.getProjects(studentEmail, {
      page: page ? parseInt(page, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
      fields: fields === 'lite' ? 'lite' : undefined,
    });
  }

  @Post('projects/remind-zero-hours')
  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  remindStudentsOnZeroHourProjects(@Body() body?: RemindZeroHoursDto) {
    return this.adminService.remindStudentsOnZeroHourProjects({
      dryRun: body?.dryRun === true,
    });
  }

  @Get('projects/:opportunityId/enrollments')
  getProjectEnrollments(@Param('opportunityId') opportunityId: string) {
    return this.adminService.getProjectEnrollments(opportunityId);
  }

  @Post('projects/:opportunityId/dedupe-student-seats')
  dedupeStudentParticipationSeats(
    @Param('opportunityId') opportunityId: string,
    @Body() body: AdminDedupeStudentSeatsDto,
  ) {
    return this.adminService.dedupeStudentParticipationSeats(
      opportunityId,
      body.student_user_id,
    );
  }

  @Post('projects/:opportunityId/reconcile-enrollments')
  reconcileOpportunityEnrollments(
    @Param('opportunityId') opportunityId: string,
  ) {
    return this.adminService.reconcileOpportunityEnrollments(opportunityId);
  }

  @Post('projects/:opportunityId/heal-team-enrollments')
  healOpportunityTeamEnrollments(
    @Param('opportunityId') opportunityId: string,
  ) {
    return this.adminService.healOpportunityTeamEnrollments(opportunityId);
  }

  @Patch('participations/:participationId/attendance-editable')
  setParticipationAttendanceEditable(
    @Param('participationId') participationId: string,
    @Body() body: SetAttendanceEditableDto,
  ) {
    return this.adminService.setParticipationAttendanceEditable(
      participationId,
      body.editable,
    );
  }

  @Get('analytics/impact-stakeholders')
  getImpactStakeholderAnalytics() {
    return this.adminService.getImpactStakeholderAnalytics();
  }

  @Get('analytics/impact')
  getAnalyticsImpact() {
    return this.adminService.getImpactAnalytics();
  }

  @Get('impact/analytics')
  getImpactAnalytics() {
    return this.adminService.getImpactAnalytics();
  }

  @Get('audit-logs')
  getAuditLogs(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('userEmail') userEmail?: string,
    @Query('path') path?: string,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
  ) {
    const pg = Number.parseInt(page ?? '', 10);
    const lim = Number.parseInt(limit ?? '', 10);
    return this.adminService.getAuditLogs(
      Number.isFinite(pg) ? pg : undefined,
      Number.isFinite(lim) ? lim : undefined,
      { userEmail, path, dateFrom, dateTo },
    );
  }

  /** Post-report CEP experience survey submissions (students after report + payment). */
  @Get('cep-feedback')
  getCepExperienceFeedback(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const pg = Number.parseInt(page ?? '', 10);
    const lim = Number.parseInt(limit ?? '', 10);
    return this.adminService.getCepExperienceFeedback(
      Number.isFinite(pg) ? pg : undefined,
      Number.isFinite(lim) ? lim : undefined,
    );
  }

  @Get('issue-logs')
  getIssueLogs(@Query() query: IssueLogListQuery) {
    return this.issueLogsService.findAll(query);
  }

  @Post('issue-logs/resolve')
  resolveIssueLogs(@Request() req, @Body() body: { ids?: string[] }) {
    return this.issueLogsService
      .resolve(Array.isArray(body?.ids) ? body.ids : [], req.user?.id ?? null)
      .then((r) => ({ success: true, ...r }));
  }

  @Get('issue-logs/:id')
  getIssueLogById(@Param('id') id: string) {
    return this.issueLogsService.findOne(id);
  }

  @Get('settings')
  getSettings() {
    return this.adminService.getSettings();
  }

  @Post('settings')
  updateSetting(@Request() req, @Body() body: SetSettingDto) {
    return this.adminService.updateSetting(body.key, body.value, {
      id: req.user?.id,
      email: req.user?.email,
    });
  }

  @Get('community-service/award-cards')
  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  async communityAwardCards() {
    const data = await this.communityAward.listForAdmin();
    return {
      success: true,
      data: await this.npeRanking.decorateAwardCards(data, {
        userId: '',
        role: 'ciel_admin',
      }),
    };
  }

  @Get('community-service/ranking/packages')
  async npeRankingPackages(@Request() req) {
    const data = await this.npeRanking.listPackages({
      userId: req.user.id,
      role: 'ciel_admin',
    });
    return { success: true, data };
  }

  @Post('community-service/ranking/analyze')
  async npeRankingAnalyze(@Request() req, @Body() dto: NpeAnalyzeDto) {
    const data = await this.npeRanking.analyze(
      { userId: req.user.id, role: 'ciel_admin' },
      dto,
    );
    return { success: true, data };
  }

  @Post('community-service/ranking/reviews')
  async npeRankingClearReview(@Request() req, @Body() dto: NpeClearReviewDto) {
    const data = await this.npeRanking.clearReview(
      { userId: req.user.id, role: 'ciel_admin' },
      dto.runId,
      dto.itemId,
    );
    return { success: true, data };
  }

  @Post('community-service/ranking/publish')
  async npeRankingPublish(@Request() req, @Body() dto: NpePublishDto) {
    const data = await this.npeRanking.publish(
      { userId: req.user.id, role: 'ciel_admin' },
      dto.runId,
    );
    return { success: true, data };
  }

  @Post('community-service/award-notify')
  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  async communityAwardNotify(
    @Request() req,
    @Body() dto: NotifyCommunityAwardDto,
  ) {
    const pool = await this.communityAward.listForAdmin();
    const data = await this.communityAward.notifyFromPool(
      pool,
      {
        ...dto,
        kind: 'ciel',
        scopeLabel: dto.scopeLabel || 'CIEL PK',
      },
      req.user.name,
    );
    return { success: true, data };
  }

  @Post('community-service/reports/:id/cii-v4-5/analyse')
  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  async communityServiceCiiV45Analyse(@Param('id') id: string) {
    return await this.facultyReportsService.runCiiV45AnalysisForAdmin(id);
  }

  @Post('community-service/reports/:id/cii-v4-5/approve')
  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  async communityServiceCiiV45Approve(
    @Request() req,
    @Param('id') id: string,
    @Body() body: ApproveCiiV45Dto,
  ) {
    return await this.facultyReportsService.approveCiiV45ForAdmin(
      id,
      req.user.id,
      body.note,
      body.adminAdjustedScore,
      body.scoreModerationReason,
      body.evidenceCriteria,
      body.exceptionalFeatureAdminVerified,
    );
  }

  /** CIEL PK runs an additional AI analysis on an already admin-approved report — same engine as
   * faculty's independent-analysis action, unrestricted (platform-wide), and never overwrites the
   * admin-approved score. */
  @Post('community-service/reports/:id/independent-analysis')
  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  async communityServiceIndependentAnalysis(
    @Request() req,
    @Param('id') id: string,
    @Body() body: RunIndependentAnalysisDto,
  ) {
    return await this.facultyReportsService.runIndependentAiAnalysis(
      id,
      req.user.id,
      'ciel_admin',
      req.user.name || req.user.email,
      body.note,
    );
  }

  /** Batch counterpart — run independent analysis across several reports at once (platform-wide,
   * unrestricted), so the resulting score/trend update lands on each affected student's My Impact
   * Wall in a single action instead of one report at a time. */
  @Post('community-service/reports/independent-analysis/batch')
  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  async communityServiceIndependentAnalysisBatch(
    @Request() req,
    @Body() body: RunIndependentAnalysisBatchDto,
  ) {
    return await this.facultyReportsService.runIndependentAiAnalysisBatch(
      body.reportIds,
      req.user.id,
      'ciel_admin',
      req.user.name || req.user.email,
      body.note,
    );
  }

  /** Read-only CII v4.5 breakdown (section scores + verified highlights, never per-criterion
   * detail) for a single faculty-approved report — platform-wide, unrestricted. */
  @Get('community-service/reports/:id/cii-v4-5')
  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  async communityServiceCiiV45Breakdown(@Param('id') id: string) {
    const data = await this.communityAward.getCiiV45BreakdownForAdmin(id);
    if (!data) {
      throw new NotFoundException(
        'No admin-approved CII v4.5 record found for this report.',
      );
    }
    return { success: true, data };
  }

  /** Exceptional: extend reporting window past project end + 60 days. */
  @Post('community-service/opportunities/:id/reopen-reporting-window')
  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  async reopenReportingWindow(
    @Param('id') id: string,
    @Body() body: { until?: string; reporting_window_reopened_until?: string },
  ) {
    const until = body.until || body.reporting_window_reopened_until;
    if (!until) {
      throw new BadRequestException(
        'Body must include until (YYYY-MM-DD) for the new reporting close date.',
      );
    }
    const data = await this.opportunitiesService.reopenReportingWindow(
      id,
      until,
    );
    return { success: true, data };
  }

  /** Always the real community-service report listing (StudentReport) — never forks on a query
   * param, so this URL can't silently return a completely different entity/shape depending on
   * what the caller passes. The legacy generic-Report listing lives at its own route below. */
  @Get('reports')
  getReports(@Query() query: any) {
    return this.studentReportsService.findAll(query);
  }

  /** The legacy, generic content-moderation `Report` entity — unrelated to community-service
   * StudentReports. Kept at its own explicit URL (previously a `?type=system` query param on
   * `/admin/reports` itself, which made the same URL return two unrelated shapes). */
  @Get('reports/legacy-system')
  getLegacySystemReports() {
    return this.adminService.getReports();
  }

  @Post('reports/merge')
  mergeReports(@Body() dto: AdminMergeReportsDto) {
    return this.studentReportsService.adminMergeReports(dto);
  }

  @Get('reports/:id')
  getReportById(@Param('id') id: string) {
    return this.studentReportsService.findOne(id);
  }

  @Patch('reports/:id/verify')
  verifyReport(
    @Request() req,
    @Param('id') id: string,
    @Body() body: AdminReportVerifyDto,
  ) {
    return this.studentReportsService.verifyReport(
      id,
      body.action,
      'admin',
      body.reason || body.feedback,
      undefined,
      body.force === true,
      { id: req.user?.id, name: req.user?.name },
    );
  }

  @Get('reports/:id/ai-evaluation-payload')
  getReportAiEvaluationPayload(@Param('id') id: string) {
    return this.studentReportsService.buildAiEvaluationPayload(id);
  }

  @Patch('reports/:id/ai-score')
  updateReportAiScore(
    @Param('id') id: string,
    @Body()
    body: {
      section11?: Record<string, unknown>;
      cii_index?: Record<string, unknown>;
    },
  ) {
    return this.studentReportsService.updateReportAiScore(id, body);
  }

  @Delete('reports/:id')
  removeReport(@Param('id') id: string, @Body() body: AdminDeleteReportDto) {
    return this.studentReportsService.removeReport(id, body);
  }

  @Post('users')
  async create(@Body() createUserDto: AdminCreateUserDto) {
    return stripUserSecrets(await this.usersService.create(createUserDto));
  }

  @Get('users')
  async findAll(
    @Request() req,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
    @Query('role') role?: string,
    @Query('status') status?: string,
    @Query('profile') profile?: string,
    @Query('joined_from') joinedFrom?: string,
    @Query('joined_to') joinedTo?: string,
    @Query('sortBy') sortBy?: string,
    @Query('sortDir') sortDir?: string,
    @Query('reveal_passwords') revealPasswords?: string,
  ) {
    const reveal =
      req.user?.role === UserRole.SUPER_ADMIN &&
      ['1', 'true', 'yes', 'on'].includes(
        String(revealPasswords || '')
          .trim()
          .toLowerCase(),
      );
    const result = await this.usersService.findAllForAdmin({
      sortBy,
      sortDir,
      page: page ? parseInt(page, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
      search,
      role,
      status,
      profile,
      joinedFrom,
      joinedTo,
      revealPasswordRecords: reveal,
    });
    return { success: true, ...result };
  }

  @Get('users/:id')
  findOne(@Param('id') id: string) {
    return this.usersService.findOne(id);
  }

  @Post('users/:id') // Spec says POST for update
  async update(
    @Request() req,
    @Param('id') id: string,
    @Body() updateUserDto: UpdateUserDto,
  ) {
    return stripUserSecrets(
      await this.usersService.update(id, updateUserDto, req.user.id),
    );
  }

  @Delete('users/:id')
  remove(@Request() req, @Param('id') id: string) {
    return this.usersService.remove(id, req.user.id);
  }

  /** Sends the user a password-reset link (admins never see or set the password). */
  @Post('users/:id/send-password-reset')
  async sendPasswordReset(@Param('id') id: string) {
    // Resolved lazily (strict:false) so AdminModule needn't import AuthModule (avoids a cycle).
    let auth: AuthService;
    try {
      auth = this.moduleRef.get(AuthService, { strict: false });
    } catch {
      throw new ServiceUnavailableException('Password reset is unavailable.');
    }
    await auth.adminSendPasswordReset(id);
    return { success: true };
  }

  @Get('student-reports')
  getStudentReports(@Query() query: any) {
    return this.studentReportsService.findAll(query);
  }

  @Patch('student-reports/:id/verify')
  verifyStudentReport(
    @Request() req,
    @Param('id') id: string,
    @Body() body: AdminReportVerifyDto,
  ) {
    return this.studentReportsService.verifyReport(
      id,
      body.action,
      'admin',
      body.reason || body.feedback,
      undefined,
      body.force === true,
      { id: req.user?.id, name: req.user?.name },
    );
  }
}
