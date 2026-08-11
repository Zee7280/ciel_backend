import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { UserRole } from '../users/enums/user-role.enum';
import { PathsService } from './paths.service';

@Controller('admin/paths')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.SUPER_ADMIN)
export class AdminPathsController {
    constructor(private readonly pathsService: PathsService) { }

    /** All student course-project path entries (draft + submitted) for admin review. */
    @Get('course-projects')
    async listCourseProjects(@Query('status') status?: 'draft' | 'submitted') {
        const data = await this.pathsService.listCourseProjectsForAdmin(status);
        return { success: true, data };
    }

    @Get('course-projects/:id')
    async getCourseProject(@Param('id') id: string) {
        const data = await this.pathsService.getCourseProjectForAdmin(id);
        return { success: true, data };
    }

    /** All student FYP / thesis path entries for admin review. */
    @Get('fyp-thesis')
    async listFyp(@Query('progress') progress?: 'complete' | 'in_progress') {
        const data = await this.pathsService.listFypForAdmin(progress);
        return { success: true, data };
    }

    @Get('fyp-thesis/:id')
    async getFyp(@Param('id') id: string) {
        const data = await this.pathsService.getFypForAdmin(id);
        return { success: true, data };
    }

    /** All student startup / venture path entries for admin review. */
    @Get('startup-business')
    async listVentures(@Query('visibility') visibility?: 'visible' | 'private') {
        const data = await this.pathsService.listVenturesForAdmin(visibility);
        return { success: true, data };
    }

    @Get('startup-business/:id')
    async getVenture(@Param('id') id: string) {
        const data = await this.pathsService.getVentureForAdmin(id);
        return { success: true, data };
    }
}
