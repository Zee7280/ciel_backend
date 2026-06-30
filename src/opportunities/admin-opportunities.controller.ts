import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  UseGuards,
  UseInterceptors,
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

import { AdminMutationAuditInterceptor } from '../audit-logs/admin-mutation-audit.interceptor';
import { AdminPatchTeamMemberDto } from './dto/admin-patch-team-member.dto';
import { AdminMergeTeamMembersDto } from './dto/admin-merge-team-members.dto';
import { SetAttendanceRoutingDto } from './dto/set-attendance-routing.dto';

@Controller('admin/opportunities')
@UseGuards(JwtAuthGuard)
@UseInterceptors(AdminMutationAuditInterceptor)
export class AdminOpportunitiesController {
  constructor(
    private readonly opportunitiesService: OpportunitiesService,
    private readonly usersService: UsersService,
    private readonly opportunityApplicationsService: OpportunityApplicationsService,
  ) {}

  private async enrichAdminQueueRows(
    opps: Awaited<ReturnType<OpportunitiesService['findAdminApprovalQueue']>>,
  ) {
    return Promise.all(
      opps.map(async (opp) => {
        let primaryContactId: string | null = null;
        if (opp.organizationId) {
          const primaryUser =
            await this.usersService.findOrganizationPrimaryUser(
              opp.organizationId,
            );
          primaryContactId = primaryUser?.id || null;
        }

        return {
          ...opp,
          partner_name: opp.organization?.name,
          submitted_at: opp.createdAt,
          primary_contact_id: primaryContactId,
        };
      }),
    );
  }

  @Get('pending')
  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  async findAllPending() {
    const opps = await this.opportunitiesService.findAllPending();
    const data = await this.enrichAdminQueueRows(opps);
    return {
      success: true,
      data,
    };
  }

  @Get('approval-queue')
  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  async findApprovalQueue(
    @Query('queue') queue?: string,
    @Query('limit') limit?: string,
  ) {
    const parsedLimit = Math.min(
      Math.max(parseInt(limit || '500', 10) || 500, 1),
      500,
    );
    const opps = await this.opportunitiesService.findAdminApprovalQueue(
      queue,
      parsedLimit,
    );
    const data = await this.enrichAdminQueueRows(opps);
    return {
      success: true,
      data,
      queue: queue?.trim().toLowerCase() || 'pending',
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

  @Post(':id/revise')
  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  async revise(@Param('id') id: string, @Body() body: { reason: string }) {
    const saved = await this.opportunitiesService.revise(id, body.reason);
    return {
      success: true,
      data: {
        id: saved.id,
        workflow_stage: saved.workflowStage,
        admin_approval_status: saved.adminApprovalStatus,
      },
    };
  }

  /** Same JWT guard stack as `GET /admin/projects` (class-level `JwtAuthGuard` only). */
  @Get(':opportunityId/incomplete-report-applicants')
  incompleteReportApplicants(@Param('opportunityId') opportunityId: string) {
    return this.opportunityApplicationsService.adminListIncompleteReportApplicants(
      opportunityId,
    );
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

  @Patch(':id/attendance-routing')
  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  async setAttendanceRouting(
    @Param('id') id: string,
    @Body() dto: SetAttendanceRoutingDto,
  ) {
    return this.opportunitiesService.setAttendanceRoutingOverride(
      id,
      dto.override,
    );
  }

  @Get(':id/teams')
  async listTeams(@Param('id') opportunityId: string) {
    return this.opportunityApplicationsService.adminListOpportunityTeams(
      opportunityId,
    );
  }

  @Post(':id/teams/merge')
  async mergeTeams(
    @Param('id') opportunityId: string,
    @Body() dto: AdminMergeTeamMembersDto,
  ) {
    return this.opportunityApplicationsService.adminMergeOpportunityTeamMembers(
      opportunityId,
      dto,
    );
  }

  @Delete(':id/teams/:teamId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteTeam(
    @Param('id') opportunityId: string,
    @Param('teamId') teamId: string,
  ) {
    await this.opportunityApplicationsService.adminDeleteOpportunityTeam(
      opportunityId,
      teamId,
    );
  }

  @Patch(':id/teams/:teamId/members/:memberId')
  async patchTeamMember(
    @Param('id') opportunityId: string,
    @Param('teamId') teamId: string,
    @Param('memberId') memberId: string,
    @Body() dto: AdminPatchTeamMemberDto,
  ) {
    return this.opportunityApplicationsService.adminPatchOpportunityTeamMember(
      opportunityId,
      teamId,
      memberId,
      dto,
    );
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
