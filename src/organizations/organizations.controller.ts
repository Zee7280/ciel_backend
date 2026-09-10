import { Controller, Get, Patch, Post, Body, UseGuards, Request, Query } from '@nestjs/common';
import { OrganizationsService } from './organizations.service';
import { UpdateOrganizationDto, AcknowledgePolicyDto } from './dto/organization.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { UserRole } from '../users/enums/user-role.enum';

@Controller('organisation')
@UseGuards(JwtAuthGuard)
export class OrganizationsController {
    constructor(private readonly organizationsService: OrganizationsService) { }

    @Get('profile')
    getMyOrganization(@Request() req) {
        return this.organizationsService.getMyOrganization(req.user.id);
    }

    @Post('profile')
    createOrUpdateMyOrganization(@Request() req, @Body() updateDto: UpdateOrganizationDto) {
        return this.organizationsService.updateMyOrganization(req.user.id, updateDto);
    }

    @Post('profile/detail')
    getDetail(@Request() req, @Body() body: any) {
        // `userId` in the body is only honoured as an admin override; everyone else reads their own org.
        const isAdminCaller = req.user?.role === UserRole.SUPER_ADMIN;
        const requestedUserId = body?.userId ? String(body.userId) : null;
        // Non-admins always read their own organisation — a stale/spoofed body id is ignored.
        const targetUserId = isAdminCaller && requestedUserId ? requestedUserId : req.user.id;
        return this.organizationsService.getMyOrganization(targetUserId);
    }

    @Get('profile/detail')
    getDetailGet(@Request() req) {
        return this.organizationsService.getMyOrganization(req.user.id);
    }

    @Post('profile/acknowledge')
    acknowledgePolicies(@Request() req, @Body() dto: AcknowledgePolicyDto) {
        return this.organizationsService.acknowledgePolicies(req.user.id, dto);
    }
}
