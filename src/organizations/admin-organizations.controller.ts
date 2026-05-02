import { Controller, Get, Patch, Post, Delete, Body, Query, Param, UseGuards, Request, UseInterceptors } from '@nestjs/common';
import { OrganizationsService } from './organizations.service';
import { AdminRejectOrganizationDto } from './dto/organization.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { UserRole } from '../users/enums/user-role.enum';
import { AdminMutationAuditInterceptor } from '../audit-logs/admin-mutation-audit.interceptor';

@Controller('admin/organizations')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.SUPER_ADMIN)
@UseInterceptors(AdminMutationAuditInterceptor)
export class AdminOrganizationsController {
    constructor(private readonly organizationsService: OrganizationsService) { }

    @Get()
    async findAll() {
        const data = await this.organizationsService.findAllForAdmin();
        return { success: true, data };
    }

    @Get(':id')
    async findOne(@Param('id') id: string) {
        const data = await this.organizationsService.getAdminOrganizationDetails(id);
        return { success: true, data };
    }

    @Patch(':id/approve')
    approve(@Param('id') id: string, @Request() req) {
        return this.organizationsService.approveOrganization(id, req.user.id);
    }

    @Patch(':id/reject')
    reject(@Param('id') id: string, @Request() req, @Body() dto: AdminRejectOrganizationDto) {
        return this.organizationsService.rejectOrganization(id, req.user.id, dto);
    }

    @Patch(':id/block')
    block(@Param('id') id: string) {
        return this.organizationsService.blockOrganization(id);
    }

    @Post('status')
    updateStatus(@Body() body: { id: string, status: string }) {
        return this.organizationsService.updateStatus(body.id, body.status);
    }

    @Post('create')
    create(@Body() body: any, @Request() req) {
        return this.organizationsService.createForAdmin(body, req.user.id);
    }

    /** Add another university operator account linked to an existing university organization. */
    @Post(':id/members')
    addUniversityMember(
        @Param('id') organizationId: string,
        @Body()
        body: {
            name: string;
            email: string;
            password: string;
            role?: UserRole.UNIVERSITY | UserRole.ORGANIZATION_ADMIN;
        },
    ) {
        return this.organizationsService.addStaffMemberToUniversityOrganization(organizationId, body);
    }

    @Delete(':id')
    remove(@Param('id') id: string) {
        return this.organizationsService.remove(id);
    }
}
