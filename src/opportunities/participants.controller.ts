import { Controller, Post, Body, UseGuards, Request, BadRequestException } from '@nestjs/common';
import { OpportunitiesService } from './opportunities.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { OrganizationsService } from '../organizations/organizations.service';
import { UserRole } from '../users/enums/user-role.enum';

@Controller('participants')
@UseGuards(JwtAuthGuard)
export class ParticipantsController {
    constructor(
        private readonly opportunitiesService: OpportunitiesService,
        private readonly organizationsService: OrganizationsService
    ) { }

    @Post()
    async findAll(@Request() req, @Body() body: { id: string }) {
        // The frontend passes 'id' in the body, which is the partner's userId. It is only honoured
        // as an admin override — otherwise it leaks another organisation's participant roster.
        const isAdminCaller = req.user?.role === UserRole.SUPER_ADMIN;
        const requestedUserId = body?.id ? String(body.id) : null;
        // Non-admins always read their own organisation's roster — a stale/spoofed body id is ignored.
        const targetUserId = isAdminCaller && requestedUserId ? requestedUserId : req.user.id;

        const org = await this.organizationsService.getMyOrganization(targetUserId);
        if (!org) {
            throw new BadRequestException('User is not linked to an organization');
        }

        const data = await this.opportunitiesService.getOrganizationParticipants(org.id);
        return { success: true, data };
    }
}
