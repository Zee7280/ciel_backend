import { Body, Controller, Get, Patch, Post, Request, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { S3Service } from '../common/s3.service';
import { assertStudentReportUploadMeta, studentReportPresignExpiresInSeconds } from '../common/student-report-file-upload';
import { PathsService } from './paths.service';
import { UpdateCourseProjectDto } from './dto/update-course-project.dto';
import { AddFypDeliverableDto, UpdateFypDto } from './dto/update-fyp.dto';
import { SetVentureVisibilityDto, UpdateVentureDto } from './dto/update-venture.dto';

@Controller('paths')
@UseGuards(JwtAuthGuard)
export class PathsController {
    constructor(
        private readonly pathsService: PathsService,
        private readonly s3Service: S3Service,
    ) { }

    /** JSON-only presign shared by all path workspaces' evidence/material uploads. */
    @Post('evidence/presign')
    async presignEvidence(
        @Request() req,
        @Body() body: { filename?: string; contentType?: string; size?: number | string },
    ) {
        const meta = assertStudentReportUploadMeta(body);
        const signed = await this.s3Service.presignPutObject({
            folder: `paths-evidence/${req.user.id}`,
            originalName: meta.filename,
            contentType: meta.contentType,
            expiresInSeconds: studentReportPresignExpiresInSeconds(meta.size),
        });
        return { success: true, data: { ...signed, url: signed.publicUrl } };
    }

    // ---------- Course Project ----------

    @Get('course-project')
    async getCourseProject(@Request() req) {
        const data = await this.pathsService.getCourseProject(req.user.id);
        return { success: true, data };
    }

    @Patch('course-project')
    async updateCourseProject(@Request() req, @Body() dto: UpdateCourseProjectDto) {
        const data = await this.pathsService.upsertCourseProject(req.user.id, dto);
        return { success: true, data };
    }

    // ---------- FYP / Thesis ----------

    @Get('fyp-thesis')
    async getFyp(@Request() req) {
        const data = await this.pathsService.getFyp(req.user.id);
        return { success: true, data };
    }

    @Patch('fyp-thesis')
    async updateFyp(@Request() req, @Body() dto: UpdateFypDto) {
        const data = await this.pathsService.upsertFyp(req.user.id, dto);
        return { success: true, data };
    }

    @Post('fyp-thesis/deliverables')
    async addFypDeliverable(@Request() req, @Body() dto: AddFypDeliverableDto) {
        const data = await this.pathsService.addFypDeliverable(req.user.id, dto);
        return { success: true, data };
    }

    // ---------- Startup / Business ----------

    @Get('startup-business')
    async getVenture(@Request() req) {
        const data = await this.pathsService.getVenture(req.user.id);
        return { success: true, data };
    }

    @Patch('startup-business')
    async updateVenture(@Request() req, @Body() dto: UpdateVentureDto) {
        const data = await this.pathsService.upsertVenture(req.user.id, dto);
        return { success: true, data };
    }

    @Patch('startup-business/visibility')
    async setVentureVisibility(@Request() req, @Body() dto: SetVentureVisibilityDto) {
        const result = await this.pathsService.setVentureVisibility(req.user.id, dto.isVisible);
        if (result.error) {
            return { success: false, ...result };
        }
        return { success: true, data: result.data };
    }
}
