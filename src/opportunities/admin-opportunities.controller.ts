import { Controller, Get, Post, Body, Param, UseGuards } from '@nestjs/common';
import { OpportunitiesService } from './opportunities.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
// Import AdminGuard if it exists, for now assumed JwtAuthGuard is enough or add Role check

import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { UserRole } from '../users/enums/user-role.enum';

@Controller('admin/opportunities')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.SUPER_ADMIN)
export class AdminOpportunitiesController {
    constructor(private readonly opportunitiesService: OpportunitiesService) { }

    @Get('pending')
    async findAllPending() {
        const opps = await this.opportunitiesService.findAllPending();
        return {
            success: true,
            data: opps.map(opp => ({
                id: opp.id,
                partner_name: opp.organization?.name,
                title: opp.title,
                types: opp.types || [],
                submitted_at: opp.createdAt,
                status: opp.status
            }))
        };
    }

    @UseGuards(JwtAuthGuard)
    @Post(':id/approve')
    async approve(@Param('id') id: string) {
        await this.opportunitiesService.approve(id);
        return { success: true, data: {} };
    }

    @UseGuards(JwtAuthGuard)
    @Post(':id/reject')
    async reject(@Param('id') id: string, @Body() body: { reason: string }) {
        await this.opportunitiesService.reject(id, body.reason);
        return { success: true, data: {} };
    }
}
