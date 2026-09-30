import { Controller, Get, Post, Body, Query, Param, UseGuards, UseInterceptors, Request, ParseUUIDPipe } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { UserRole } from '../users/enums/user-role.enum';
import { FacultyService } from './faculty.service';
import { OpportunitiesService } from '../opportunities/opportunities.service';
import { buildOpportunityApprovalTracker } from '../opportunities/opportunity-approval-tracker.util';
import { RedactOpportunitySecretsInterceptor } from '../opportunities/redact-opportunity-secrets.interceptor';

@Controller('faculty/approvals')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.FACULTY)
@UseInterceptors(RedactOpportunitySecretsInterceptor)
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
    async getProjectDetail(@Request() req, @Param('id', new ParseUUIDPipe()) id: string) {
        return this.facultyService.getProjectDetail(req.user.id, req.user.email || '', id);
    }

    @Post(':id/approve')
    async approve(@Request() req, @Param('id', new ParseUUIDPipe()) id: string) {
        const saved = await this.opportunitiesService.facultyDashboardApprove(
            id,
            req.user.id,
            req.user.email || '',
            req.user.name,
        );
        const tracker = buildOpportunityApprovalTracker(saved);
        return {
            success: true,
            message: 'Faculty approval completed',
            data: {
                id: saved.id,
                status:
                    saved.workflowStage === 'live' && saved.admin_approved
                        ? 'live'
                        : ['pending_faculty', 'pending_partner', 'pending_admin'].includes(saved.workflowStage || '') ||
                            (saved.workflowStage === 'live' && !saved.admin_approved)
                            ? 'pending_verification'
                            : saved.workflowStage === 'rejected'
                                ? 'rejected'
                                : saved.workflowStage === 'revision'
                                    ? 'revision'
                                    : saved.status,
                workflow_stage: saved.workflowStage,
                currently_with: tracker.currently_with,
                currently_with_role: tracker.currently_with_role,
                next_step: tracker.next_step,
                public_code: tracker.public_code,
            },
        };
    }

    @Post(':id/reject')
    async reject(
        @Request() req,
        @Param('id', new ParseUUIDPipe()) id: string,
        @Body() body: { reason?: string; comment?: string },
    ) {
        const saved = await this.opportunitiesService.facultyDashboardReject(
            id,
            req.user.id,
            req.user.email || '',
            body?.reason ?? body?.comment,
            req.user.name,
        );
        return {
            success: true,
            message: 'Faculty permanent rejection submitted',
            data: {
                id: saved.id,
                status:
                    saved.workflowStage === 'live' && saved.admin_approved
                        ? 'live'
                        : ['pending_faculty', 'pending_partner', 'pending_admin'].includes(saved.workflowStage || '') ||
                            (saved.workflowStage === 'live' && !saved.admin_approved)
                            ? 'pending_verification'
                            : saved.workflowStage === 'rejected'
                                ? 'rejected'
                                : saved.workflowStage === 'revision'
                                    ? 'revision'
                                    : saved.status,
                workflow_stage: saved.workflowStage,
            },
        };
    }

    @Post(':id/revise')
    async revise(
        @Request() req,
        @Param('id', new ParseUUIDPipe()) id: string,
        @Body() body: { reason?: string; comment?: string },
    ) {
        const saved = await this.opportunitiesService.facultyDashboardRevise(
            id,
            req.user.id,
            req.user.email || '',
            body?.reason ?? body?.comment,
            req.user.name,
        );
        return {
            success: true,
            message: 'Faculty revision request submitted',
            data: {
                id: saved.id,
                status:
                    saved.workflowStage === 'revision'
                        ? 'revision'
                        : saved.workflowStage === 'rejected'
                            ? 'rejected'
                            : saved.status,
                workflow_stage: saved.workflowStage,
            },
        };
    }
}
