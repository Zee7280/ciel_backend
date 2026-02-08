import { Controller, Get, Post, Body, Patch, Param, Delete, UseGuards } from '@nestjs/common';
import { UsersService } from '../users/users.service';
import { CreateUserDto } from '../users/dto/create-user.dto';
import { UpdateUserDto } from '../users/dto/update-user.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { UserRole } from '../users/enums/user-role.enum';

import { AdminService } from './admin.service';

@Controller('admin')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.SUPER_ADMIN)
export class AdminController {
    constructor(
        private readonly usersService: UsersService,
        private readonly adminService: AdminService
    ) { }

    @Get('dashboard')
    getDashboard() {
        return this.adminService.getDashboardStats();
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
    getReports() {
        return this.adminService.getReports();
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
}
