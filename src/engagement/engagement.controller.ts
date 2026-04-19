import { Controller, Post, Get, Patch, Delete, Body, Param, Query, UseGuards, Request, UseInterceptors, UploadedFile, NotFoundException } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { EngagementService } from './engagement.service';
import { RegisterParticipantDto } from './dto/register-participant.dto';
import { CreateAttendanceLogDto } from './dto/create-attendance-log.dto';
import { PatchAttendanceApprovalDto } from './dto/patch-attendance-approval.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

@Controller('engagement')
@UseGuards(JwtAuthGuard)
export class EngagementController {
    constructor(private readonly engagementService: EngagementService) { }

    @Get('my')
    async getMy(@Request() req) {
        const result = await this.engagementService.getMyParticipants(req.user.id);
        return {
            success: true,
            data: result,
        };
    }

    @Get('me/latest')
    async getMyLatest(@Request() req) {
        const result = await this.engagementService.getLatestParticipation(req.user.id);
        return {
            success: true,
            data: result,
        };
    }

    /** Partner/NGO (creator) or CIEL admin: pending attendance queue (server-side routing; no client-supplied approver). */
    @Get('attendance/pending')
    async listPendingAttendance(@Request() req, @Query('projectId') projectId?: string) {
        const result = await this.engagementService.listPendingAttendanceLogs(req.user.id, req.user.role, projectId);
        return {
            success: true,
            data: result,
        };
    }

    @Patch('attendance/:logId')
    async patchAttendanceApproval(
        @Request() req,
        @Param('logId') logId: string,
        @Body() dto: PatchAttendanceApprovalDto,
    ) {
        const result = await this.engagementService.patchAttendanceApproval(req.user.id, req.user.role, logId, dto);
        return {
            success: true,
            data: result,
            message: 'Attendance approval updated',
        };
    }

    @Post('register')
    async register(@Request() req, @Body() dto: RegisterParticipantDto) {
        const result = await this.engagementService.registerParticipant(req.user.id, dto);
        return {
            success: true,
            data: result,
            message: 'Participation registered successfully',
        };
    }

    @Post(':id/attendance')
    @UseInterceptors(FileInterceptor('evidence'))
    async addAttendance(
        @Request() req,
        @Param('id') id: string,
        @Body() dto: CreateAttendanceLogDto,
        @UploadedFile() file: Express.Multer.File
    ) {
        const result = await this.engagementService.addAttendanceLog(req.user.id, id, dto, file);
        return {
            success: true,
            data: result,
            message: 'Attendance logged successfully',
        };
    }

    @Get(':id/attendance')
    async getAttendance(@Param('id') id: string) {
        const result = await this.engagementService.getAttendanceLogs(id);
        return {
            success: true,
            data: result,
        };
    }

    @Delete(':id/attendance/:logId')
    async deleteAttendance(@Request() req, @Param('id') id: string, @Param('logId') logId: string) {
        const result = await this.engagementService.deleteAttendanceLog(req.user.id, id, logId);
        return {
            success: true,
            data: result,
            message: 'Attendance log deleted successfully',
        };
    }

    @Get(':id/metrics')
    async getMetrics(@Param('id') id: string) {
        const result = await this.engagementService.getEngagementMetrics(id);
        return {
            success: true,
            data: result,
        };
    }

    @Get(':id/summary')
    async getSummary(@Param('id') id: string) {
        const result = await this.engagementService.generateSummary(id);
        return {
            success: true,
            data: result,
        };
    }

    @Post(':id/finalize')
    async finalize(@Request() req, @Param('id') id: string) {
        const result = await this.engagementService.finalizeEngagement(req.user.id, id);
        return {
            success: true,
            data: result,
            message: 'Engagement finalized successfully',
        };
    }

    @Post(':id/faculty-approve')
    async facultyApprove(@Param('id') id: string, @Body('status') status: string) {
        const result = await this.engagementService.facultyApprove(id, status);
        return {
            success: true,
            data: result,
            message: `Participation ${status} by faculty`,
        };
    }

    @Get('project/:projectId/team')
    async getProjectTeam(@Param('projectId') projectId: string) {
        const result = await this.engagementService.getProjectTeam(projectId);
        return {
            success: true,
            data: result,
        };
    }

    @Get('project/:projectId/attendance-logs')
    async getProjectAttendance(@Param('projectId') projectId: string) {
        const result = await this.engagementService.getProjectAttendanceLogs(projectId);
        return {
            success: true,
            data: result,
        };
    }

    @Delete(':id')
    async deleteParticipant(@Param('id') id: string) {
        await this.engagementService.deleteParticipant(id);
        return {
            success: true,
            message: 'Member removed from project participation',
        };
    }
}
