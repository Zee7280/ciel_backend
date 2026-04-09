import { Controller, Get, Post, Body, Query, Param, UseGuards, Request } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { FacultyService } from './faculty.service';
import { OpportunitiesService } from '../opportunities/opportunities.service';

@Controller('faculty/approvals')
@UseGuards(JwtAuthGuard)
export class FacultyController {
    constructor(
        private readonly facultyService: FacultyService,
        private readonly opportunitiesService: OpportunitiesService,
    ) {}

    @Get()
    async getApprovals(@Request() req, @Query('status') status?: string) {
        return this.facultyService.getApprovals(req.user.id, req.user.email || '', status);
    }

    /** Full student project (opportunity) detail + linked reports for this faculty supervisor */
    @Get(':id')
    async getProjectDetail(@Request() req, @Param('id') id: string) {
        return this.facultyService.getProjectDetail(req.user.id, req.user.email || '', id);
    }

    @Post(':id/approve')
    async approve(@Request() req, @Param('id') id: string) {
        const saved = await this.opportunitiesService.facultyDashboardApprove(
            id,
            req.user.id,
            req.user.email || '',
        );
        return {
            success: true,
            data: {
                id: saved.id,
                status: saved.status,
                workflow_stage: saved.workflowStage,
            },
        };
    }

    @Post(':id/reject')
    async reject(@Request() req, @Param('id') id: string, @Body() body: { reason?: string }) {
        const saved = await this.opportunitiesService.facultyDashboardReject(
            id,
            req.user.id,
            req.user.email || '',
            body?.reason,
        );
        return {
            success: true,
            data: {
                id: saved.id,
                status: saved.status,
                workflow_stage: saved.workflowStage,
            },
        };
    }
}
