import { Controller, Post, Get, Body, Param, UseGuards, Request } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { UserRole } from '../users/enums/user-role.enum';
import { FacultyReportsService } from '../reports/faculty-reports.service';
import { FacultyReportActionDto } from './dto/faculty-report-action.dto';
import { ApproveCiiV2Dto } from './dto/approve-cii-v2.dto';

@Controller('faculty/reports')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.FACULTY)
export class FacultyReportsController {
    constructor(private readonly facultyReportsService: FacultyReportsService) { }

    @Get()
    async getAssignedReports(@Request() req) {
        return await this.facultyReportsService.findAll(req.user.id, req.user.email);
    }

    @Get(':id')
    async getReportById(@Request() req, @Param('id') id: string) {
        return await this.facultyReportsService.findOne(id, req.user.id, req.user.email);
    }

    @Post(':id/action')
    async handleAction(
        @Request() req,
        @Param('id') id: string,
        @Body() body: FacultyReportActionDto
    ) {
        return await this.facultyReportsService.updateAction(
            id,
            req.user.id,
            req.user.email,
            body.status,
            body.remarks
        );
    }

    @Post(':id/cii-v2/analyse')
    async analyseCiiV2(@Request() req, @Param('id') id: string) {
        return await this.facultyReportsService.runCiiV2Analysis(id, req.user.id, req.user.email);
    }

    @Post(':id/cii-v2/approve')
    async approveCiiV2(
        @Request() req,
        @Param('id') id: string,
        @Body() body: ApproveCiiV2Dto,
    ) {
        return await this.facultyReportsService.approveCiiV2(id, req.user.id, req.user.email, body.note);
    }
}
