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
import { ReportEvidenceDownloadDto } from './dto/report-evidence-download.dto';
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
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { IssueLogListQuery } from '../issue-logs/issue-logs.service';
import { PlatformJobsService } from '../jobs/platform-jobs.service';
import { FacultyReportsService } from '../reports/faculty-reports.service';
import { RunIndependentAnalysisDto } from '../faculty/dto/run-independent-analysis.dto';
import { RunIndependentAnalysisBatchDto } from '../faculty/dto/run-independent-analysis-batch.dto';
import {
  AddSupplementalEvidenceDto,
  SupplementalEvidencePresignDto,
} from './dto/supplemental-evidence.dto';
import {
  ApproveCiiV45Dto,
  CiiL6QualificationDto,
  ModerateCiiV45Dto,
} from '../faculty/dto/approve-cii-v4-5.dto';
import { NpeRankingService } from '../ranking/npe-ranking.service';
import { NpeStudioService } from '../ranking/npe-studio.service';
import { NpeGovernanceService } from '../ranking/npe-governance.service';
import {
  NpeAnalyzeDto,
  NpeChallengeDto,
  NpeClearReviewDto,
  NpeOverrideDto,
  NpePublishDto,
  NpeResolveChallengeDto,
  NpeRevokeOverrideDto,
  NpeStudioDto,
} from '../ranking/dto/npe-ranking.dto';

/** Never echo credential material (password hash / deprecated password record) back to the browser. */
function stripUserSecrets<T>(user: T): T {
  if (!user || typeof user !== 'object') return user;
  const safe: Record<string, unknown> = {
    ...(user as Record<string, unknown>),
  };
  delete safe.password;
  delete safe.passwordRecord;
  delete safe.passwordResetToken;
  delete safe.passwordResetExpiry;
  return safe as T;
}

/** Shape of `req.user` as returned by JwtStrategy.validate. */
interface AdminRequest {
  user: {
    id: string;
    email?: string;
    name?: string;
    role?: UserRole;
  };
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
    private readonly npeStudio: NpeStudioService,
    private readonly npeGovernance: NpeGovernanceService,
    private readonly opportunityApplicationsService: OpportunityApplicationsService,
    private readonly issueLogsService: IssueLogsService,
    private readonly auditLogsService: AuditLogsService,
    private readonly adminProjectEvidenceService: AdminProjectEvidenceService,
    private readonly platformJobsService: PlatformJobsService,
    private readonly facultyReportsService: FacultyReportsService,
    private readonly moduleRef: ModuleRef,
  ) {}

  /** Same run as the 02:00 PKT Vercel Cron; result is also written to the audit log. */
  @Post('jobs/nightly')
  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  runNightlyJobs() {
    return this.platformJobsService.runNightlyJobsNow('admin-manual');
  }

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
  approveOpportunityApplication(
    @Request() req: AdminRequest,
    @Param('id') id: string,
  ) {
    return this.opportunityApplicationsService.adminApprove(id, req.user.id);
  }

  @Post('applications/:id/reject')
  rejectOpportunityApplication(
    @Request() req: AdminRequest,
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
  approveApplication(@Request() req: AdminRequest, @Param('id') id: string) {
    return this.adminService.approveApplication(id, req.user.id);
  }

  @Post('users/:id/reject')
  rejectApplication(
    @Request() req: AdminRequest,
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
    @Request() req: AdminRequest,
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

  /** Super Admin: one report's evidence originals as a ZIP (Impact Package "Download all"). */
  @Post('reports/:id/evidence/download')
  downloadReportEvidence(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: ReportEvidenceDownloadDto,
    @Res() res: Response,
  ) {
    return this.adminProjectEvidenceService.streamReportEvidenceZip(
      id,
      body?.urls,
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

  /** One click: approve + enrol every application still waiting on CIEL admin for this project. */
  @Post('projects/:opportunityId/enroll-pending')
  enrollPendingApplications(
    @Request() req: AdminRequest,
    @Param('opportunityId') opportunityId: string,
  ) {
    return this.adminService.enrollPendingApplications(
      opportunityId,
      req.user.id,
    );
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
    @Query('outcome') outcome?: string,
    @Query('method') method?: string,
    @Query('targetType') targetType?: string,
    @Query('userRole') userRole?: string,
    @Query('search') search?: string,
  ) {
    const pg = Number.parseInt(page ?? '', 10);
    const lim = Number.parseInt(limit ?? '', 10);
    return this.adminService.getAuditLogs(
      Number.isFinite(pg) ? pg : undefined,
      Number.isFinite(lim) ? lim : undefined,
      {
        userEmail,
        path,
        dateFrom,
        dateTo,
        outcome,
        method,
        targetType,
        userRole,
        search,
      },
    );
  }

  @Get('audit-logs/summary')
  async getAuditLogsSummary() {
    return { success: true, data: await this.auditLogsService.summary() };
  }

  @Get('audit-logs/export')
  async exportAuditLogs(
    @Query() q: Record<string, string>,
    @Res() res: Response,
  ) {
    const csv = await this.auditLogsService.exportCsv({
      userEmail: q.userEmail,
      path: q.path,
      dateFrom: q.dateFrom,
      dateTo: q.dateTo,
      outcome: q.outcome,
      method: q.method,
      targetType: q.targetType,
      userRole: q.userRole,
      search: q.search,
    });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="audit-logs-${new Date().toISOString().slice(0, 10)}.csv"`,
    );
    res.send(csv);
  }

  @Get('audit-logs/:id')
  async getAuditLogById(@Param('id', ParseUUIDPipe) id: string) {
    return { success: true, data: await this.auditLogsService.findOne(id) };
  }

  /** Deleting the trail is audited by the interceptor like every other admin mutation. */
  @Delete('audit-logs')
  async deleteAuditLogs(
    @Body() body: { ids?: string[]; olderThanDays?: number },
  ) {
    const r = await this.auditLogsService.deleteMany({
      ids: Array.isArray(body?.ids) ? body.ids : [],
      olderThanDays: body?.olderThanDays,
    });
    return { success: true, ...r };
  }

  @Delete('audit-logs/:id')
  async deleteAuditLog(@Param('id', ParseUUIDPipe) id: string) {
    return { success: true, ...(await this.auditLogsService.deleteOne(id)) };
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

  @Get('issue-logs/summary')
  async getIssueLogsSummary() {
    return { success: true, data: await this.issueLogsService.summary() };
  }

  @Get('issue-logs/export')
  async exportIssueLogs(
    @Query() query: IssueLogListQuery,
    @Res() res: Response,
  ) {
    const csv = await this.issueLogsService.exportCsv(query);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="issue-logs-${new Date().toISOString().slice(0, 10)}.csv"`,
    );
    res.send(csv);
  }

  @Post('issue-logs/resolve')
  resolveIssueLogs(
    @Request() req: AdminRequest,
    @Body() body: { ids?: string[] },
  ) {
    return this.issueLogsService
      .resolve(Array.isArray(body?.ids) ? body.ids : [], req.user?.id ?? null)
      .then((r) => ({ success: true, ...r }));
  }

  @Delete('issue-logs')
  async deleteIssueLogs(
    @Body()
    body: {
      ids?: string[];
      resolvedOnly?: boolean;
      olderThanDays?: number;
    },
  ) {
    const r = await this.issueLogsService.deleteMany({
      ids: Array.isArray(body?.ids) ? body.ids : [],
      resolvedOnly: body?.resolvedOnly === true,
      olderThanDays: body?.olderThanDays,
    });
    return { success: true, ...r };
  }

  @Delete('issue-logs/:id')
  async deleteIssueLog(@Param('id', ParseUUIDPipe) id: string) {
    return { success: true, ...(await this.issueLogsService.deleteOne(id)) };
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
  updateSetting(@Request() req: AdminRequest, @Body() body: SetSettingDto) {
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
  async npeRankingPackages(@Request() req: AdminRequest) {
    const data = await this.npeRanking.listPackages({
      userId: req.user.id,
      role: 'ciel_admin',
    });
    return { success: true, data };
  }

  @Post('community-service/ranking/analyze')
  async npeRankingAnalyze(
    @Request() req: AdminRequest,
    @Body() dto: NpeAnalyzeDto,
  ) {
    const data = await this.npeRanking.analyze(
      { userId: req.user.id, role: 'ciel_admin' },
      dto,
    );
    return { success: true, data };
  }

  @Post('community-service/ranking/reviews')
  async npeRankingClearReview(
    @Request() req: AdminRequest,
    @Body() dto: NpeClearReviewDto,
  ) {
    const data = await this.npeRanking.clearReview(
      { userId: req.user.id, role: 'ciel_admin' },
      dto.runId,
      dto.itemId,
    );
    return { success: true, data };
  }

  /** Ranking Studio: standings for any angle (lens × comparison × filters). Writes nothing. */
  @Post('community-service/ranking/studio/preview')
  async npeStudioPreview(
    @Request() req: AdminRequest,
    @Body() dto: NpeStudioDto,
  ) {
    const data = await this.npeStudio.preview(
      { userId: req.user.id, role: 'ciel_admin' },
      dto,
    );
    return { success: true, data };
  }

  /** Publishes the studio ranking exactly as the server recomputes it (never the client's rows). */
  @Post('community-service/ranking/studio/publish')
  async npeStudioPublish(
    @Request() req: AdminRequest,
    @Body() dto: NpeStudioDto,
  ) {
    const data = await this.npeStudio.publish(
      { userId: req.user.id, role: 'ciel_admin' },
      dto,
    );
    return { success: true, data };
  }

  @Get('community-service/ranking/studio/history')
  async npeStudioHistory(@Request() req: AdminRequest) {
    const data = await this.npeStudio.history({
      userId: req.user.id,
      role: 'ciel_admin',
    });
    return { success: true, data };
  }

  @Get('community-service/ranking/studio/publications/:id')
  async npeStudioPublication(
    @Request() req: AdminRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    const data = await this.npeStudio.getPublication(
      { userId: req.user.id, role: 'ciel_admin' },
      id,
    );
    return { success: true, data };
  }

  /** Published rankings that include one project (Impact Wall preview). */
  @Get('community-service/ranking/studio/project/:reportId')
  async npeStudioProject(
    @Request() req: AdminRequest,
    @Param('reportId', new ParseUUIDPipe()) reportId: string,
  ) {
    const data = await this.npeStudio.rankingsForProject(
      { userId: req.user.id, role: 'ciel_admin' },
      reportId,
    );
    return { success: true, data };
  }

  @Post('community-service/ranking/publish')
  async npeRankingPublish(
    @Request() req: AdminRequest,
    @Body() dto: NpePublishDto,
  ) {
    const data = await this.npeRanking.publish(
      { userId: req.user.id, role: 'ciel_admin' },
      dto.runId,
    );
    return { success: true, data };
  }

  // ---- NPE-1.3 governance: feed status, corrections, audit trail, challenges, rank history ----

  /** "Check automatic feed": what the My Impact Wall connector can see for this scope. Writes nothing. */
  @Get('community-service/ranking/studio/feed')
  async npeStudioFeed(@Request() req: AdminRequest) {
    const data = await this.npeGovernance.feed({
      userId: req.user.id,
      role: 'ciel_admin',
    });
    return { success: true, data };
  }

  @Get('community-service/ranking/studio/audit')
  async npeStudioAudit(@Request() req: AdminRequest) {
    const data = await this.npeGovernance.audit({
      userId: req.user.id,
      role: 'ciel_admin',
    });
    return { success: true, data };
  }

  @Get('community-service/ranking/studio/overrides')
  async npeStudioOverrides(
    @Request() req: AdminRequest,
    @Query('reportId') reportId?: string,
  ) {
    const data = await this.npeGovernance.listOverrides(
      { userId: req.user.id, role: 'ciel_admin' },
      reportId || undefined,
    );
    return { success: true, data };
  }

  /** Admin criterion correction: evidence locator and reason required; the AI judgment stays on record. */
  @Post('community-service/ranking/studio/overrides')
  async npeStudioSaveOverride(
    @Request() req: AdminRequest,
    @Body() dto: NpeOverrideDto,
  ) {
    const data = await this.npeGovernance.saveOverride(
      { userId: req.user.id, role: 'ciel_admin' },
      dto,
    );
    return { success: true, data };
  }

  @Post('community-service/ranking/studio/overrides/:id/revoke')
  async npeStudioRevokeOverride(
    @Request() req: AdminRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: NpeRevokeOverrideDto,
  ) {
    const data = await this.npeGovernance.revokeOverride(
      { userId: req.user.id, role: 'ciel_admin' },
      id,
      dto?.reason,
    );
    return { success: true, data };
  }

  @Get('community-service/ranking/studio/challenges')
  async npeStudioChallenges(@Request() req: AdminRequest) {
    const data = await this.npeGovernance.listChallenges({
      userId: req.user.id,
      role: 'ciel_admin',
    });
    return { success: true, data };
  }

  @Post('community-service/ranking/studio/challenges')
  async npeStudioOpenChallenge(
    @Request() req: AdminRequest,
    @Body() dto: NpeChallengeDto,
  ) {
    const data = await this.npeGovernance.openChallenge(
      { userId: req.user.id, role: 'ciel_admin' },
      dto,
    );
    return { success: true, data };
  }

  @Post('community-service/ranking/studio/challenges/:id/resolve')
  async npeStudioResolveChallenge(
    @Request() req: AdminRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: NpeResolveChallengeDto,
  ) {
    const data = await this.npeGovernance.resolveChallenge(
      { userId: req.user.id, role: 'ciel_admin' },
      id,
      dto,
    );
    return { success: true, data };
  }

  /** Every published revision that placed one project (rank progression for the flashcard trend). */
  @Get('community-service/ranking/studio/project/:reportId/history')
  async npeStudioProjectHistory(
    @Request() req: AdminRequest,
    @Param('reportId', new ParseUUIDPipe()) reportId: string,
  ) {
    const data = await this.npeGovernance.projectRankHistory(
      { userId: req.user.id, role: 'ciel_admin' },
      reportId,
    );
    return { success: true, data };
  }

  @Post('community-service/award-notify')
  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  async communityAwardNotify(
    @Request() req: AdminRequest,
    @Body() dto: NotifyCommunityAwardDto,
  ) {
    const pool = await this.communityAward.listForAdmin();
    // After a national NPE ranking is published, medals carry THAT ranking (rank / cohort / score).
    const published = await this.npeRanking.publishedStandings('national');
    const data = await this.communityAward.notifyFromPool(
      pool,
      {
        ...dto,
        kind: 'ciel',
        scopeLabel:
          dto.scopeLabel ||
          (published ? 'CIEL PK National Ranking (NPE-1.1)' : 'CIEL PK'),
      },
      req.user.name,
      published?.standings ?? null,
    );
    return { success: true, data };
  }

  @Post('community-service/reports/:id/cii-v4-5/analyse')
  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  async communityServiceCiiV45Analyse(
    @Param('id') id: string,
    @Body() body?: { force?: boolean },
  ) {
    return await this.facultyReportsService.runCiiV45AnalysisForAdmin(id, {
      force: body?.force === true,
    });
  }

  @Post('community-service/reports/:id/cii-v4-5/approve')
  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  async communityServiceCiiV45Approve(
    @Request() req: AdminRequest,
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
      body.l6Qualification,
    );
  }

  /** R3: Admin's labelled supplemental evidence for a report (never visible to students/faculty). */
  @Get('community-service/reports/:id/supplemental-evidence')
  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  async communityServiceListSupplementalEvidence(@Param('id') id: string) {
    return await this.facultyReportsService.listSupplementalEvidenceForAdmin(
      id,
    );
  }

  @Post('community-service/reports/:id/supplemental-evidence/presign')
  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  async communityServiceSupplementalEvidencePresign(
    @Param('id') id: string,
    @Body() body: SupplementalEvidencePresignDto,
  ) {
    return await this.facultyReportsService.presignSupplementalEvidenceForAdmin(
      id,
      body,
    );
  }

  @Post('community-service/reports/:id/supplemental-evidence')
  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  async communityServiceAddSupplementalEvidence(
    @Request() req: AdminRequest,
    @Param('id') id: string,
    @Body() body: AddSupplementalEvidenceDto,
  ) {
    return await this.facultyReportsService.addSupplementalEvidenceForAdmin(
      id,
      req.user.id,
      body,
    );
  }

  @Delete('community-service/reports/:id/supplemental-evidence/:evidenceId')
  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  async communityServiceRemoveSupplementalEvidence(
    @Request() req: AdminRequest,
    @Param('id') id: string,
    @Param('evidenceId') evidenceId: string,
  ) {
    return await this.facultyReportsService.removeSupplementalEvidenceForAdmin(
      id,
      req.user.id,
      evidenceId,
    );
  }

  /** R3: Admin reviews AI criterion marks before approval (append-only log, AI baseline kept). */
  @Post('community-service/reports/:id/cii-v4-5/moderate')
  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  async communityServiceCiiV45Moderate(
    @Request() req: AdminRequest,
    @Param('id') id: string,
    @Body() body: ModerateCiiV45Dto,
  ) {
    return await this.facultyReportsService.moderateCiiV45ForAdmin(
      id,
      req.user.id,
      {
        dimension: body.dimension,
        criterionEdits: body.criterionEdits,
        reason: body.reason ?? '',
        sourceRef: body.sourceRef,
        expectedRevision: body.expectedRevision,
      },
    );
  }

  /** R3: awards a pending L6 after approval once the sourced confirmations are recorded. */
  @Post('community-service/reports/:id/cii-v4-5/l6-qualification')
  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  async communityServiceCiiV45QualifyL6(
    @Request() req: AdminRequest,
    @Param('id') id: string,
    @Body() body: CiiL6QualificationDto,
  ) {
    return await this.facultyReportsService.qualifyCiiV45L6ForAdmin(
      id,
      req.user.id,
      body,
    );
  }

  /** CIEL PK runs an additional AI analysis on an already admin-approved report — same engine as
   * faculty's independent-analysis action, unrestricted (platform-wide), and never overwrites the
   * admin-approved score. */
  @Post('community-service/reports/:id/independent-analysis')
  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  async communityServiceIndependentAnalysis(
    @Request() req: AdminRequest,
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
    @Request() req: AdminRequest,
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
    @Request() req: AdminRequest,
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
    @Request() req: AdminRequest,
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
  async findOne(@Param('id') id: string) {
    // findOne() loads the raw entity (login hash, reset token) — never let that reach a client.
    const user = await this.usersService.findOne(id);
    if (!user) throw new NotFoundException('User not found');
    return stripUserSecrets(user);
  }

  @Post('users/:id') // Spec says POST for update
  async update(
    @Request() req: AdminRequest,
    @Param('id') id: string,
    @Body() updateUserDto: UpdateUserDto,
  ) {
    return stripUserSecrets(
      await this.usersService.update(id, updateUserDto, req.user.id),
    );
  }

  @Delete('users/:id')
  remove(@Request() req: AdminRequest, @Param('id') id: string) {
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
    @Request() req: AdminRequest,
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
