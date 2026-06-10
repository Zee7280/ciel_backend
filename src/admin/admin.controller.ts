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
} from '@nestjs/common';
import type { Response } from 'express';
import { AdminMutationAuditInterceptor } from '../audit-logs/admin-mutation-audit.interceptor';
import { UsersService } from '../users/users.service';
import { CreateUserDto } from '../users/dto/create-user.dto';
import { UpdateUserDto } from '../users/dto/update-user.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { UserRole } from '../users/enums/user-role.enum';

import { AdminService } from './admin.service';
import { AdminProjectEvidenceService } from './admin-project-evidence.service';
import { MasterAnalyticsQueryDto } from './dto/master-analytics-query.dto';
import { OpportunitiesService } from '../opportunities/opportunities.service';
import { StudentReportsService } from '../reports/student-reports.service';
import { AdminMergeReportsDto } from '../reports/dto/admin-merge-reports.dto';
import { OpportunityApplicationsService } from '../opportunities/opportunity-applications.service';
import { IssueLogsService } from '../issue-logs/issue-logs.service';
import type { IssueLogListQuery } from '../issue-logs/issue-logs.service';

@Controller('admin')
@UseGuards(JwtAuthGuard)
@UseInterceptors(AdminMutationAuditInterceptor)
export class AdminController {
    constructor(
        private readonly usersService: UsersService,
        private readonly adminService: AdminService,
        private readonly opportunitiesService: OpportunitiesService,
        private readonly studentReportsService: StudentReportsService,
        private readonly opportunityApplicationsService: OpportunityApplicationsService,
        private readonly issueLogsService: IssueLogsService,
        private readonly adminProjectEvidenceService: AdminProjectEvidenceService,
    ) { }

    @Get('dashboard')
    getDashboard() {
        return this.adminService.getDashboardStats();
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
        @Body() body: { reason: string },
    ) {
        return this.opportunityApplicationsService.adminReject(id, req.user.id, body?.reason || '');
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
    rejectApplication(@Request() req, @Param('id') id: string, @Body() body: { reason: string }) {
        return this.adminService.rejectApplication(id, body.reason || '', req.user.id);
    }

    // Opportunity approval routes (duplicate here to handle routing conflicts)
    @Post('opportunities/:id/approve')
    async approveOpportunity(@Param('id') id: string) {
        await this.opportunitiesService.approve(id);
        return { success: true, data: {} };
    }

    @Patch('opportunities/:id/approve')
    async approveOpportunityPatch(@Param('id') id: string) {
        await this.opportunitiesService.approve(id);
        return { success: true, data: {} };
    }

    @Post('opportunities/:id/reject')
    async rejectOpportunity(@Param('id') id: string, @Body() body: { reason: string }) {
        await this.opportunitiesService.reject(id, body.reason);
        return { success: true, data: {} };
    }

    @Post('opportunities/:id/revise')
    async reviseOpportunity(@Param('id') id: string, @Body() body: { reason: string }) {
        const saved = await this.opportunitiesService.revise(id, body.reason);
        return {
            success: true,
            data: {
                id: saved.id,
                workflow_stage: saved.workflowStage,
                admin_approval_status: saved.adminApprovalStatus,
            },
        };
    }

    @Delete('opportunities/:id')
    removeOpportunity(@Param('id') id: string) {
        return this.opportunitiesService.remove(id);
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
        return this.adminProjectEvidenceService.streamProjectEvidenceZip(opportunityId, res);
    }

    @Get('projects')
    getProjects(@Query('student_email') studentEmail?: string) {
        return this.adminService.getProjects(studentEmail);
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
    ) {
        const pg = Number.parseInt(page ?? '', 10);
        const lim = Number.parseInt(limit ?? '', 10);
        return this.adminService.getAuditLogs(
            Number.isFinite(pg) ? pg : undefined,
            Number.isFinite(lim) ? lim : undefined,
        );
    }

    @Get('issue-logs')
    getIssueLogs(@Query() query: IssueLogListQuery) {
        return this.issueLogsService.findAll(query);
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
    updateSetting(@Body() body: { key: string, value: string }) {
        return this.adminService.updateSetting(body.key, body.value);
    }

    @Get('reports')
    getReports(@Query() query: any) {
        // Fallback for existing system reports logic
        if (query.type === 'system') {
            return this.adminService.getReports();
        }
        // As per new spec, this endpoint now serves student reports
        return this.studentReportsService.findAll(query);
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
        @Param('id') id: string,
        @Body() body: { action: 'approve' | 'reject' | 'unlock'; reason?: string; feedback?: string }
    ) {
        return this.studentReportsService.verifyReport(id, body.action, 'admin', body.reason || body.feedback);
    }

    @Get('reports/:id/ai-evaluation-payload')
    getReportAiEvaluationPayload(@Param('id') id: string) {
        return this.studentReportsService.buildAiEvaluationPayload(id);
    }

    @Patch('reports/:id/ai-score')
    updateReportAiScore(
        @Param('id') id: string,
        @Body() body: { section11?: Record<string, unknown>; cii_index?: Record<string, unknown> },
    ) {
        return this.studentReportsService.updateReportAiScore(id, body);
    }

    @Delete('reports/:id')
    removeReport(@Param('id') id: string) {
        return this.studentReportsService.removeReport(id);
    }

    @Post('users')
    create(@Body() createUserDto: CreateUserDto) {
        return this.usersService.create(createUserDto);
    }

    @Get('users')
    async findAll(@Request() req: { user?: { role?: string } }) {
        const revealPasswords = req.user?.role === UserRole.SUPER_ADMIN;
        const users = await this.usersService.findAllForAdmin(revealPasswords);
        return { success: true, data: users };
    }

    @Get('users/:id')
    findOne(@Param('id') id: string) {
        return this.usersService.findOne(id);
    }

    @Post('users/:id') // Spec says POST for update
    update(@Param('id') id: string, @Body() updateUserDto: UpdateUserDto) {
        return this.usersService.update(id, updateUserDto);
    }

    @Delete('users/:id')
    remove(@Param('id') id: string) {
        return this.usersService.remove(id);
    }

    @Get('student-reports')
    getStudentReports(@Query() query: any) {
        return this.studentReportsService.findAll(query);
    }

    @Patch('student-reports/:id/verify')
    verifyStudentReport(
        @Param('id') id: string,
        @Body() body: { action: 'approve' | 'reject' | 'unlock'; reason?: string; feedback?: string }
    ) {
        return this.studentReportsService.verifyReport(id, body.action, 'admin', body.reason || body.feedback);
    }
}
