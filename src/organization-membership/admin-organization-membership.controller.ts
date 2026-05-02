import { Controller, Get, Post, Body, Param, UseGuards, Request, UseInterceptors } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { UserRole } from '../users/enums/user-role.enum';
import { OrganizationMembershipService } from './organization-membership.service';
import { AdminMutationAuditInterceptor } from '../audit-logs/admin-mutation-audit.interceptor';

@Controller('admin/org-membership')
@UseGuards(JwtAuthGuard)
@UseInterceptors(AdminMutationAuditInterceptor)
export class AdminOrganizationMembershipController {
    constructor(private readonly membershipService: OrganizationMembershipService) { }

    @Get('pending')
    @UseGuards(RolesGuard)
    @Roles(UserRole.SUPER_ADMIN)
    async listPending() {
        const data = await this.membershipService.listPendingReview();
        return { success: true, data };
    }

    @Get('history')
    @UseGuards(RolesGuard)
    @Roles(UserRole.SUPER_ADMIN)
    async listHistory() {
        const data = await this.membershipService.listHistoryForAdmin();
        return { success: true, data };
    }

    @Post(':id/approve')
    @UseGuards(RolesGuard)
    @Roles(UserRole.SUPER_ADMIN)
    async approve(@Request() req: any, @Param('id') id: string) {
        const row = await this.membershipService.approveSubmission(id, req.user.id);
        return {
            success: true,
            message: 'Membership approved; account activated',
            data: { id: row.id, userId: row.userId, status: row.status },
        };
    }

    @Post(':id/reject')
    @UseGuards(RolesGuard)
    @Roles(UserRole.SUPER_ADMIN)
    async reject(
        @Request() req: any,
        @Param('id') id: string,
        @Body() body: { feedback?: string },
    ) {
        const row = await this.membershipService.rejectSubmission(id, req.user.id, body?.feedback);
        return {
            success: true,
            message: 'Submission rejected; user may submit again',
            data: { id: row.id, userId: row.userId, status: row.status },
        };
    }
}
