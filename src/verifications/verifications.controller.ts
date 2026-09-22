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
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { UserRole } from '../users/enums/user-role.enum';
import { OpportunitiesService } from '../opportunities/opportunities.service';

/** Org-owning roles that can legitimately hold a verification item's organization — same set
 * PartnersController uses for its own org-scoped actions, plus SUPER_ADMIN who can act on any
 * item regardless of org (see VerificationsService.assertActorOwnsVerificationItem). */
const VERIFICATION_ACTOR_ROLES = [
    UserRole.SUPER_ADMIN,
    UserRole.UNIVERSITY,
    UserRole.NGO,
    UserRole.CORPORATE,
    UserRole.ORGANIZATION_ADMIN,
];

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

    @UseGuards(JwtAuthGuard, RolesGuard)
    @Roles(...VERIFICATION_ACTOR_ROLES)
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

    /** Fully public, same "possession of the emailed token is the credential" design as
     * verifications/verify above — the reject/request-revision counterpart on the partner
     * flashcard, so a partner/NGO reviewer isn't limited to "approve or ignore". */
    @Post('verifications/partner-decision')
    @Header('Cache-Control', 'no-store, no-cache, must-revalidate, private')
    @Header('Pragma', 'no-cache')
    async decideOpportunityViaPartnerToken(
        @Body() body: { token?: string; action?: 'reject' | 'revision'; reason?: string },
    ) {
        const t = typeof body?.token === 'string' ? body.token.trim() : '';
        if (!t) {
            throw new HttpException(
                { success: false, message: 'Token is required' },
                HttpStatus.BAD_REQUEST,
            );
        }
        if (body?.action !== 'reject' && body?.action !== 'revision') {
            throw new HttpException(
                { success: false, message: 'action must be "reject" or "revision"' },
                HttpStatus.BAD_REQUEST,
            );
        }
        try {
            return await this.opportunitiesService.decideOpportunityViaPartnerToken(
                t,
                body.action,
                typeof body?.reason === 'string' ? body.reason : undefined,
            );
        } catch (error) {
            if (
                error instanceof BadRequestException ||
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

    /** Fully public faculty preview. The emailed faculty token is the credential. */
    @Get('verifications/faculty-preview')
    @Header('Cache-Control', 'no-store, no-cache, must-revalidate, private')
    @Header('Pragma', 'no-cache')
    async getFacultyVerificationPreview(@Query('token') token: string) {
        const t = typeof token === 'string' ? token.trim() : '';
        if (!t) {
            throw new HttpException(
                { success: false, message: 'Token is required' },
                HttpStatus.BAD_REQUEST,
            );
        }
        try {
            const data = await this.opportunitiesService.getPublicFacultyVerificationPreview(t);
            return { success: true, data };
        } catch (error) {
            if (error instanceof NotFoundException) {
                throw new HttpException({ success: false, message: error.message }, HttpStatus.NOT_FOUND);
            }
            throw error;
        }
    }

    /** Public faculty reject / request-revision. Approve stays on POST verifications/verify. */
    @Post('verifications/faculty-decision')
    @Header('Cache-Control', 'no-store, no-cache, must-revalidate, private')
    @Header('Pragma', 'no-cache')
    async decideOpportunityViaFacultyToken(
        @Body() body: { token?: string; action?: 'reject' | 'revision'; reason?: string },
    ) {
        const t = typeof body?.token === 'string' ? body.token.trim() : '';
        if (!t) {
            throw new HttpException(
                { success: false, message: 'Token is required' },
                HttpStatus.BAD_REQUEST,
            );
        }
        if (body?.action !== 'reject' && body?.action !== 'revision') {
            throw new HttpException(
                { success: false, message: 'action must be "reject" or "revision"' },
                HttpStatus.BAD_REQUEST,
            );
        }
        try {
            return await this.opportunitiesService.decideOpportunityViaFacultyToken(
                t,
                body.action,
                typeof body?.reason === 'string' ? body.reason : undefined,
            );
        } catch (error) {
            if (
                error instanceof BadRequestException ||
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

    /** Partner queue actions — the caller must own the organization the item was submitted to
     * (same scope as `GET partners/verifications`); admins may act on any item. Role-gated
     * defense-in-depth on top of that org-ownership check — previously only JwtAuthGuard, so a
     * student/faculty account with no organization was rejected downstream by the org lookup, but
     * the route itself had no role boundary (fragile: any future path that gives such an account
     * an organizationId would have silently gained access to approve/reject any item). */
    @UseGuards(JwtAuthGuard, RolesGuard)
    @Roles(...VERIFICATION_ACTOR_ROLES)
    @Post('verifications/:id/approve')
    async approve(@Request() req, @Param('id') id: string, @Body() body: { feedback?: string }) {
        await this.verificationsService.approve(id, body.feedback, {
            id: req.user?.id,
            role: req.user?.role,
        });
        return { success: true, data: {} };
    }

    @UseGuards(JwtAuthGuard, RolesGuard)
    @Roles(...VERIFICATION_ACTOR_ROLES)
    @Post('verifications/:id/reject')
    async reject(@Request() req, @Param('id') id: string, @Body() body: { reason: string }) {
        await this.verificationsService.reject(id, body.reason, {
            id: req.user?.id,
            role: req.user?.role,
        });
        return { success: true, data: {} };
    }
}
