import {
    BadRequestException,
    Controller,
    ForbiddenException,
    Get,
    Post,
    Body,
    Param,
    HttpException,
    UseGuards,
    Request,
    Query,
    HttpStatus,
    Header,
    NotFoundException,
    UnauthorizedException,
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

    private async performOpportunityVerification(
        token: string,
        user?: { id?: string; email?: string; role?: string },
    ) {
        try {
            return await this.opportunitiesService.verifyOpportunityToken(token, user as any);
        } catch (error) {
            if (
                error instanceof BadRequestException ||
                error instanceof UnauthorizedException ||
                error instanceof ForbiddenException ||
                error instanceof NotFoundException
            ) {
                const response = error.getResponse();
                const message =
                    typeof response === 'string'
                        ? response
                        : (response as any)?.message || error.message;
                throw new HttpException(
                    {
                        success: false,
                        message: Array.isArray(message) ? message.join(', ') : message,
                    },
                    error.getStatus(),
                );
            }
            throw error;
        }
    }

    @UseGuards(JwtAuthGuard)
    @Get('partners/verifications')
    async findAll(@Request() req, @Query('status') status) {
        // ignoring status param for now as service defaults to pending or I can pass it
        const data = await this.verificationsService.findAllPending(req.user.id);
        return { success: true, data };
    }

    /** Fully public — no guard at all. The partner contact previews the opportunity before ever
     * having a CIEL account, so this never attempts JWT auth and never requires one. */
    @Get('verifications/partner-preview')
    @Header('Cache-Control', 'no-store, no-cache, must-revalidate, private')
    @Header('Pragma', 'no-cache')
    async getPartnerVerificationPreview(@Query('token') token: string) {
        const t = typeof token === 'string' ? token.trim() : '';
        if (!t) {
            throw new HttpException(
                { success: false, message: 'Token is required' },
                HttpStatus.BAD_REQUEST,
            );
        }
        try {
            const data = await this.opportunitiesService.getPublicPartnerVerificationPreview(t);
            return { success: true, data };
        } catch (error) {
            if (error instanceof NotFoundException) {
                throw new HttpException({ success: false, message: error.message }, HttpStatus.NOT_FOUND);
            }
            throw error;
        }
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
        return this.performOpportunityVerification(t, req.user);
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
        return this.performOpportunityVerification(t, req.user);
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
