import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { UserRole } from '../users/enums/user-role.enum';
import { PathsService } from './paths.service';
import { SetVentureSpotlightDto } from './dto/update-venture.dto';

@Controller('admin/paths')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.SUPER_ADMIN)
export class AdminPathsController {
    constructor(private readonly pathsService: PathsService) { }

    /** All student course-project path entries (draft + submitted) for admin review.
     * Pass ?approvalStatus=approved to get the "Approved Coursework" wall enforced at the query
     * level — never rely on the caller to filter facultyApprovalStatus client-side. */
    @Get('course-projects')
    async listCourseProjects(
        @Query('status') status?: 'draft' | 'submitted',
        @Query('approvalStatus') approvalStatus?: 'pending' | 'approved' | 'rejected' | 'revision_requested',
    ) {
        const data = await this.pathsService.listCourseProjectsForAdmin(status, approvalStatus);
        return { success: true, data };
    }

    @Get('course-projects/:id')
    async getCourseProject(@Param('id', ParseUUIDPipe) id: string) {
        const data = await this.pathsService.getCourseProjectForAdmin(id);
        return { success: true, data };
    }

    /** All student FYP / thesis path entries for admin review.
     * Pass ?approvalStatus=approved to get the "Approved FYP" wall enforced at the query level —
     * never rely on the caller to filter supervisorApprovalStatus client-side. */
    @Get('fyp-thesis')
    async listFyp(
        @Query('progress') progress?: 'complete' | 'in_progress',
        @Query('approvalStatus') approvalStatus?: 'pending' | 'approved' | 'rejected' | 'revision_requested',
    ) {
        const data = await this.pathsService.listFypForAdmin(progress, approvalStatus);
        return { success: true, data };
    }

    @Get('fyp-thesis/:id')
    async getFyp(@Param('id', ParseUUIDPipe) id: string) {
        const data = await this.pathsService.getFypForAdmin(id);
        return { success: true, data };
    }

    /** All student startup / venture path entries for admin review.
     * Pass ?approvalStatus=approved to get the approved-only wall enforced at the query level —
     * never rely on the caller to filter reviewPipeline.supervisorStatus client-side. */
    @Get('startup-business')
    async listVentures(
        @Query('visibility') visibility?: 'visible' | 'private',
        @Query('approvalStatus') approvalStatus?: 'not_started' | 'pending' | 'approved' | 'revisions_requested' | 'rejected',
    ) {
        const data = await this.pathsService.listVenturesForAdmin(visibility, approvalStatus);
        return { success: true, data };
    }

    /** CIEL PK Investor Hub spotlight — additive, does not change faculty review. */
    @Patch('startup-business/:id/spotlight')
    async setVentureSpotlight(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SetVentureSpotlightDto) {
        const data = await this.pathsService.setVentureSpotlight(id, dto.featured);
        return { success: true, data };
    }

    @Get('startup-business/:id')
    async getVenture(@Param('id', ParseUUIDPipe) id: string) {
        const data = await this.pathsService.getVentureForAdmin(id);
        return { success: true, data };
    }
}
