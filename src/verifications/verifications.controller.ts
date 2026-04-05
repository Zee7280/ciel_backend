import { Controller, Get, Post, Body, Param, UseGuards, Request, Query } from '@nestjs/common';
import { VerificationsService } from './verifications.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { OpportunitiesService } from '../opportunities/opportunities.service';

@Controller()
export class VerificationsController {
    constructor(
        private readonly verificationsService: VerificationsService,
        private readonly opportunitiesService: OpportunitiesService
    ) { }

    @UseGuards(JwtAuthGuard)
    @Get('partners/verifications')
    async findAll(@Request() req, @Query('status') status) {
        // ignoring status param for now as service defaults to pending or I can pass it
        const data = await this.verificationsService.findAllPending(req.user.id);
        return { success: true, data };
    }

    @Get('verifications/verify')
    async verifyOpportunity(@Query('token') token: string) {
        if (!token) {
            return { success: false, message: 'Token is required' };
        }
        return this.opportunitiesService.verifyOpportunityToken(token);
    }

    @UseGuards(JwtAuthGuard)
    @Post('verifications/:id/approve')
    async approve(@Param('id') id: string, @Body() body: { feedback?: string }) {
        await this.verificationsService.approve(id, body.feedback);
        return { success: true, data: {} };
    }

    @UseGuards(JwtAuthGuard)
    @Post('verifications/:id/reject')
    async reject(@Param('id') id: string, @Body() body: { reason: string }) {
        await this.verificationsService.reject(id, body.reason);
        return { success: true, data: {} };
    }
}
