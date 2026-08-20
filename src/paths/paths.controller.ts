import { Body, Controller, Delete, Get, Param, Patch, Post, Request, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { UserRole } from '../users/enums/user-role.enum';
import { S3Service } from '../common/s3.service';
import { assertStudentReportUploadMeta, studentReportPresignExpiresInSeconds } from '../common/student-report-file-upload';
import { PathsService } from './paths.service';
import { UpdateCourseProjectDto } from './dto/update-course-project.dto';
import { AddFypDeliverableDto, UpdateFypDto } from './dto/update-fyp.dto';
import { AddVentureDocumentDto, SetVentureVisibilityDto, UpdateVentureDto } from './dto/update-venture.dto';

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

    /** A student's full coursework deck — every report they've submitted or drafted, plus any
     * teammate's submitted report they were named on in step 1. */
    @Get('course-projects')
    async listCourseProjects(@Request() req) {
        const data = await this.pathsService.listCourseProjects(req.user.id, req.user.email);
        return { success: true, data };
    }

    @Post('course-projects')
    async createCourseProject(@Request() req) {
        const data = await this.pathsService.createCourseProject(req.user.id);
        return { success: true, data };
    }

    /** Cards from students who named this teacher as their supervisor — the faculty deck. */
    @Get('course-projects/supervised')
    @UseGuards(RolesGuard)
    @Roles(UserRole.FACULTY)
    async listSupervisedCourseProjects(@Request() req) {
        const data = await this.pathsService.listCourseProjectsForTeacher(req.user.email);
        return { success: true, data };
    }

    /** Cards from students linked to this university partner org — the university showcase deck. */
    @Get('course-projects/university')
    @UseGuards(RolesGuard)
    @Roles(UserRole.UNIVERSITY, UserRole.ORGANIZATION_ADMIN)
    async listUniversityCourseProjects(@Request() req) {
        const data = await this.pathsService.listCourseProjectsForUniversity(req.user.organizationId);
        return { success: true, data };
    }

    @Get('course-projects/:id')
    async getCourseProjectById(@Request() req, @Param('id') id: string) {
        const data = await this.pathsService.getCourseProjectByIdForUser(req.user.id, req.user.email, id);
        return { success: true, data };
    }

    @Patch('course-projects/:id')
    async updateCourseProjectById(@Request() req, @Param('id') id: string, @Body() dto: UpdateCourseProjectDto) {
        const data = await this.pathsService.updateCourseProjectByIdForUser(req.user.id, id, dto);
        return { success: true, data };
    }

    @Delete('course-projects/:id')
    async deleteCourseProjectById(@Request() req, @Param('id') id: string) {
        await this.pathsService.deleteCourseProjectByIdForUser(req.user.id, id);
        return { success: true };
    }

    // ---------- FYP / Thesis ----------

    @Get('fyp-thesis')
    async getFyp(@Request() req) {
        const data = await this.pathsService.getFyp(req.user.id, req.user.email);
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

    /** Records from students who named this teacher as their supervisor — the faculty deck. */
    @Get('fyp-thesis/supervised')
    @UseGuards(RolesGuard)
    @Roles(UserRole.FACULTY)
    async listSupervisedFyp(@Request() req) {
        const data = await this.pathsService.listFypForTeacher(req.user.email);
        return { success: true, data };
    }

    /** Records from students formally linked to this university partner org — the university showcase deck. */
    @Get('fyp-thesis/university')
    @UseGuards(RolesGuard)
    @Roles(UserRole.UNIVERSITY, UserRole.ORGANIZATION_ADMIN)
    async listUniversityFyp(@Request() req) {
        const data = await this.pathsService.listFypForUniversity(req.user.organizationId);
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

    @Post('startup-business/documents')
    async addVentureDocument(@Request() req, @Body() dto: AddVentureDocumentDto) {
        const data = await this.pathsService.addVentureDocument(req.user.id, dto);
        return { success: true, data };
    }
}
