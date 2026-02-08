import { Controller, Post, Get, Patch, Body, Param, Query, UseGuards, Request, UseInterceptors, UploadedFiles, BadRequestException } from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { StudentReportsService } from '../reports/student-reports.service';

@Controller('students/reports')
@UseGuards(JwtAuthGuard)
export class StudentReportsController {
    constructor(private readonly studentReportsService: StudentReportsService) { }

    @Post()
    @UseInterceptors(FilesInterceptor('files', 50, {
        limits: {
            fileSize: 10 * 1024 * 1024, // 10 MB per file
        },
        fileFilter: (req, file, callback) => {
            const allowedExtensions = ['.jpg', '.jpeg', '.png', '.pdf', '.doc', '.docx'];
            const ext = file.originalname.toLowerCase().substring(file.originalname.lastIndexOf('.'));

            if (allowedExtensions.includes(ext)) {
                callback(null, true);
            } else {
                callback(new BadRequestException(`File type ${ext} is not allowed. Allowed types: ${allowedExtensions.join(', ')}`), false);
            }
        },
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

    @Post('draft')
    @UseInterceptors(FilesInterceptor('files', 50, {
        limits: {
            fileSize: 10 * 1024 * 1024,
        },
        fileFilter: (req, file, callback) => {
            const allowedExtensions = ['.jpg', '.jpeg', '.png', '.pdf', '.doc', '.docx'];
            const ext = file.originalname.toLowerCase().substring(file.originalname.lastIndexOf('.'));

            if (allowedExtensions.includes(ext)) {
                callback(null, true);
            } else {
                callback(new BadRequestException(`File type ${ext} is not allowed`), false);
            }
        },
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
    async checkReportStatus(@Query() query: { studentId: string; opportunityId?: string }) {
        return await this.studentReportsService.checkReportStatus(
            query.studentId,
            query.opportunityId
        );
    }

    @Get(':id')
    async getReportById(@Param('id') id: string) {
        return await this.studentReportsService.findOne(id);
    }

    @Patch(':id/verify')
    async verifyReport(
        @Param('id') id: string,
        @Body() body: { action: 'approve' | 'reject'; reason?: string }
    ) {
        return await this.studentReportsService.verifyReport(
            id,
            body.action,
            body.reason
        );
    }
}
