import { Controller, Post, Get, Delete, Body, Param, UseGuards, Request, UseInterceptors, UploadedFile } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { EngagementService } from './engagement.service';
import { RegisterParticipantDto } from './dto/register-participant.dto';
import { CreateAttendanceLogDto } from './dto/create-attendance-log.dto';
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

    @Post('register')
    async register(@Request() req, @Body() dto: RegisterParticipantDto) {
        const result = await this.engagementService.registerParticipant(req.user.id, dto);
        return {
            success: true,
            data: result,
            message: 'Participant registered successfully',
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
}
