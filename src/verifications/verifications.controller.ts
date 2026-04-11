import {
    Controller,
    Get,
    Post,
    Body,
    Param,
    UseGuards,
    Request,
    Query,
    HttpException,
    HttpStatus,
    Header,
} from '@nestjs/common';
import { VerificationsService } from './verifications.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { VerificationVerifyAuthGuard } from '../auth/verification-verify-auth.guard';
import { OpportunitiesService } from '../opportunities/opportunities.service';

@Controller()
export class VerificationsController {
    constructor(
        private readonly verificationsService: VerificationsService,
        private readonly opportunitiesService: OpportunitiesService,
    ) {}

    @UseGuards(JwtAuthGuard)
    @Get('partners/verifications')
    async findAll(@Request() req, @Query('status') status) {
        // ignoring status param for now as service defaults to pending or I can pass it
        const data = await this.verificationsService.findAllPending(req.user.id);
        return { success: true, data };
    }

    @UseGuards(VerificationVerifyAuthGuard)
    @Get('verifications/verify')
    @Header('Cache-Control', 'no-store, no-cache, must-revalidate, private')
    @Header('Pragma', 'no-cache')
    async verifyOpportunity(@Request() req, @Query('token') token: string) {
        const t = typeof token === 'string' ? token.trim() : '';
        if (!t) {
            throw new HttpException(
                { success: false, message: 'Token is required' },
                HttpStatus.BAD_REQUEST,
            );
        }
        return this.opportunitiesService.verifyOpportunityToken(t, req.user);
    }

    @UseGuards(VerificationVerifyAuthGuard)
    @Post('verifications/verify')
    @Header('Cache-Control', 'no-store, no-cache, must-revalidate, private')
    @Header('Pragma', 'no-cache')
    async verifyOpportunityPost(@Request() req, @Body() body: { token?: string }) {
        const t = typeof body?.token === 'string' ? body.token.trim() : '';
        if (!t) {
            throw new HttpException(
                { success: false, message: 'Token is required' },
                HttpStatus.BAD_REQUEST,
            );
        }
        return this.opportunitiesService.verifyOpportunityToken(t, req.user);
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
