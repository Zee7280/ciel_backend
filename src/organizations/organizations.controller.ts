import { Controller, Get, Patch, Post, Body, UseGuards, Request, Query } from '@nestjs/common';
import { OrganizationsService } from './organizations.service';
import { UpdateOrganizationDto, AcknowledgePolicyDto } from './dto/organization.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

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
        // Use passed userId or fallback to logged-in user
        const targetUserId = body?.userId || req.user.id;
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
