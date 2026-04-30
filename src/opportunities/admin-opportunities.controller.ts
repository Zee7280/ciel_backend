import {
    Controller,
    Get,
    Post,
    Body,
    Param,
    UseGuards,
    Patch,
    Delete,
    HttpCode,
    HttpStatus,
} from '@nestjs/common';
import { OpportunitiesService } from './opportunities.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { UserRole } from '../users/enums/user-role.enum';
import { UsersService } from '../users/users.service';
import { OpportunityApplicationsService } from './opportunity-applications.service';

@Controller('admin/opportunities')
@UseGuards(JwtAuthGuard)
export class AdminOpportunitiesController {
    constructor(
        private readonly opportunitiesService: OpportunitiesService,
        private readonly usersService: UsersService,
        private readonly opportunityApplicationsService: OpportunityApplicationsService,
    ) { }

    @Get('pending')
    @UseGuards(RolesGuard)
    @Roles(UserRole.SUPER_ADMIN)
    async findAllPending() {
        const opps = await this.opportunitiesService.findAllPending();

        const data = await Promise.all(opps.map(async (opp) => {
            let primaryContactId: string | null = null;
            if (opp.organizationId) {
                const primaryUser = await this.usersService.findOrganizationPrimaryUser(opp.organizationId);
                primaryContactId = primaryUser?.id || null;
            }

            return {
                ...opp,
                partner_name: opp.organization?.name,
                submitted_at: opp.createdAt,
                primary_contact_id: primaryContactId
            };
        }));

        return {
            success: true,
            data
        };
    }

    @Post(':id/approve')
    @UseGuards(RolesGuard)
    @Roles(UserRole.SUPER_ADMIN)
    async approve(@Param('id') id: string) {
        await this.opportunitiesService.approve(id);
        return { success: true, data: {} };
    }

    @Patch(':id/approve')
    @UseGuards(RolesGuard)
    @Roles(UserRole.SUPER_ADMIN)
    async approvePatch(@Param('id') id: string) {
        await this.opportunitiesService.approve(id);
        return { success: true, data: {} };
    }

    @Post(':id/reject')
    @UseGuards(RolesGuard)
    @Roles(UserRole.SUPER_ADMIN)
    async reject(@Param('id') id: string, @Body() body: { reason: string }) {
        await this.opportunitiesService.reject(id, body.reason);
        return { success: true, data: {} };
    }

    /** Same JWT guard stack as `GET /admin/projects` (class-level `JwtAuthGuard` only). */
    @Get(':opportunityId/incomplete-report-applicants')
    incompleteReportApplicants(@Param('opportunityId') opportunityId: string) {
        return this.opportunityApplicationsService.adminListIncompleteReportApplicants(opportunityId);
    }

    @Delete(':opportunityId/applications/:applicationId')
    @HttpCode(HttpStatus.NO_CONTENT)
    async deleteApplicationForIncompleteReport(
        @Param('opportunityId') opportunityId: string,
        @Param('applicationId') applicationId: string,
    ) {
        await this.opportunityApplicationsService.adminDeleteApprovedApplicationForIncompleteReport(
            opportunityId,
            applicationId,
        );
    }

    @Get(':id/teams')
    async listTeams(@Param('id') opportunityId: string) {
        return this.opportunityApplicationsService.adminListOpportunityTeams(opportunityId);
    }

    @Delete(':id/teams/:teamId')
    @HttpCode(HttpStatus.NO_CONTENT)
    async deleteTeam(
        @Param('id') opportunityId: string,
        @Param('teamId') teamId: string,
    ) {
        await this.opportunityApplicationsService.adminDeleteOpportunityTeam(opportunityId, teamId);
    }

    @Delete(':id/teams/:teamId/members/:memberId')
    @HttpCode(HttpStatus.NO_CONTENT)
    async deleteTeamMember(
        @Param('id') opportunityId: string,
        @Param('teamId') teamId: string,
        @Param('memberId') memberId: string,
    ) {
        await this.opportunityApplicationsService.adminDeleteOpportunityTeamMember(
            opportunityId,
            teamId,
            memberId,
        );
    }
}

