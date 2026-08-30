import {
    Controller,
    Post,
    Get,
    Patch,
    Body,
    Param,
    Query,
    UseGuards,
    Request,
    UseInterceptors,
    UploadedFiles,
    BadRequestException,
    HttpException,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import {
    studentReportMulterFileFilter,
    studentReportUploadMulterLimits,
} from '../common/student-report-file-upload';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { StudentReportsService } from '../reports/student-reports.service';
import { UserRole } from '../users/enums/user-role.enum';

@Controller('students/reports')
@UseGuards(JwtAuthGuard)
export class StudentReportsController {
    constructor(private readonly studentReportsService: StudentReportsService) { }

    @Post()
    @UseInterceptors(FilesInterceptor('files', 50, {
        limits: studentReportUploadMulterLimits(),
        fileFilter: studentReportMulterFileFilter,
    }))
    async submitReport(
        @Request() req,
        @Body() body: any,
        @UploadedFiles() files: any[]
    ) {
        try {
            return await this.studentReportsService.createReport(
                req.user.id,
                body,
                files
            );
        } catch (error) {
            if (error instanceof HttpException) {
                const s = error.getStatus();
                if (s === 403 || s === 401) throw error;
            }
            if (error.response && error.response.message) {
                throw new BadRequestException({
                    success: false,
                    message: 'Validation failed',
                    errors: Array.isArray(error.response.message)
                        ? error.response.message.map(msg => ({
                            field: msg.property,
                            message: Object.values(msg.constraints || {}).join(', '),
                        }))
                        : [{ message: error.response.message }],
                });
            }
            throw error;
        }
    }

    @Post(':projectId/submit')
    @UseInterceptors(FilesInterceptor('files', 50, {
        limits: studentReportUploadMulterLimits(),
        fileFilter: studentReportMulterFileFilter,
    }))
    async submitReportSpecific(
        @Request() req,
        @Param('projectId') projectId: string,
        @Body() body: any,
        @UploadedFiles() files: any[]
    ) {
        // Ensure projectId is in the body for the service logic
        body.projectId = projectId;
        body.opportunityId = projectId;
        
        return await this.studentReportsService.createReport(
            req.user.id,
            body,
            files,
            true,
        );
    }

    @Post('draft')
    @UseInterceptors(FilesInterceptor('files', 50, {
        limits: studentReportUploadMulterLimits(),
        fileFilter: studentReportMulterFileFilter,
    }))
    async saveDraft(
        @Request() req,
        @Body() body: any,
        @UploadedFiles() files: any[]
    ) {
        return await this.studentReportsService.saveDraft(
            req.user.id,
            body,
            files
        );
    }

    @Get()
    async getAllReports(@Query() query: any) {
        return await this.studentReportsService.findAll(query);
    }

    @Get('check')
    async checkReportStatus(@Request() req, @Query() query: { studentId?: string; opportunityId?: string }) {
        const studentId = (query.studentId || '').trim() || req.user.id;
        if (studentId !== req.user.id && req.user.role !== UserRole.SUPER_ADMIN) {
            throw new BadRequestException('Unauthorized to query report status for another student');
        }
        return await this.studentReportsService.checkReportStatus(studentId, query.opportunityId);
    }

    @Get(':id')
    async getReportById(@Request() req, @Param('id') id: string) {
        if (req.user?.organizationId && ['partner', 'ngo', 'corporate', 'organization_admin'].includes(req.user?.role)) {
            return await this.studentReportsService.findOneForPartner(id, req.user.organizationId);
        }
        // Match /student/reports/:id — accept report UUID or opportunity (project) id for the JWT student.
        return await this.studentReportsService.findOneByOpportunityOrId(id, req.user.id);
    }

    /** Not called by any frontend (admin/partner review goes through their own dedicated routes) —
     * guarded rather than removed, in case something outside this repo still depends on it. */
    @Patch(':id/verify')
    @UseGuards(RolesGuard)
    @Roles(UserRole.SUPER_ADMIN)
    async verifyReport(
        @Request() req,
        @Param('id') id: string,
        @Body() body: { action: 'approve' | 'reject'; reason?: string; feedback?: string; verified_by?: string }
    ) {
        return await this.studentReportsService.verifyReport(
            id,
            body.action,
            req.user.role,
            body.reason || body.feedback,
            req.user.organizationId
        );
    }
}
