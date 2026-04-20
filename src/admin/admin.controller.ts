import { Controller, Get, Post, Body, Patch, Param, Delete, UseGuards, Query, Request } from '@nestjs/common';
import { UsersService } from '../users/users.service';
import { CreateUserDto } from '../users/dto/create-user.dto';
import { UpdateUserDto } from '../users/dto/update-user.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { UserRole } from '../users/enums/user-role.enum';

import { AdminService } from './admin.service';
import { OpportunitiesService } from '../opportunities/opportunities.service';
import { StudentReportsService } from '../reports/student-reports.service';
import { OpportunityApplicationsService } from '../opportunities/opportunity-applications.service';

@Controller('admin')
@UseGuards(JwtAuthGuard)
export class AdminController {
    constructor(
        private readonly usersService: UsersService,
        private readonly adminService: AdminService,
        private readonly opportunitiesService: OpportunitiesService,
        private readonly studentReportsService: StudentReportsService,
        private readonly opportunityApplicationsService: OpportunityApplicationsService,
    ) { }

    @Get('dashboard')
    getDashboard() {
        return this.adminService.getDashboardStats();
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
    approveApplication(@Param('id') id: string) {
        return this.adminService.approveApplication(id);
    }

    @Post('users/:id/reject')
    rejectApplication(@Param('id') id: string, @Body() body: { reason: string }) {
        return this.adminService.rejectApplication(id, body.reason);
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

    @Delete('opportunities/:id')
    removeOpportunity(@Param('id') id: string) {
        return this.opportunitiesService.remove(id);
    }

    @Get('projects')
    getProjects() {
        return this.adminService.getProjects();
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
    getAuditLogs() {
        return this.adminService.getAuditLogs();
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

    @Delete('reports/:id')
    removeReport(@Param('id') id: string) {
        return this.studentReportsService.removeReport(id);
    }

    @Post('users')
    create(@Body() createUserDto: CreateUserDto) {
        return this.usersService.create(createUserDto);
    }

    @Get('users')
    async findAll() {
        const users = await this.usersService.findAll();
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
