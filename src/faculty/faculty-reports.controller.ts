import { Controller, Post, Get, Body, Param, UseGuards, Request } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { FacultyReportsService } from '../reports/faculty-reports.service';

@Controller('faculty/reports')
@UseGuards(JwtAuthGuard)
export class FacultyReportsController {
    constructor(private readonly facultyReportsService: FacultyReportsService) { }

    @Get()
    async getAssignedReports(@Request() req) {
        return await this.facultyReportsService.findAll(req.user.id);
    }

    @Get(':id')
    async getReportById(@Request() req, @Param('id') id: string) {
        return await this.facultyReportsService.findOne(id, req.user.id);
    }

    @Post(':id/action')
    async handleAction(
        @Request() req,
        @Param('id') id: string,
        @Body() body: { status: 'approved' | 'rejected'; remarks?: string }
    ) {
        return await this.facultyReportsService.updateAction(
            id,
            req.user.id,
            body.status,
            body.remarks
        );
    }
}
