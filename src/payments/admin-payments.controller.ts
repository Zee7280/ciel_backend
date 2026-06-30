import {
    Controller,
    Get,
    Post,
    Patch,
    Param,
    Body,
    Query,
    Request,
    UseGuards,
    BadRequestException,
    MethodNotAllowedException,
    UseInterceptors,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { UserRole } from '../users/enums/user-role.enum';
import { PaymentsService } from './payments.service';
import { PaymentStatus } from './entities/payment.entity';

import { AdminMutationAuditInterceptor } from '../audit-logs/admin-mutation-audit.interceptor';

@Controller('admin/payments')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.SUPER_ADMIN)
@UseInterceptors(AdminMutationAuditInterceptor)
export class AdminPaymentsController {
    constructor(private readonly paymentsService: PaymentsService) { }

    @Get('pending')
    async getPendingPayments() {
        return {
            success: true,
            data: await this.paymentsService.findAllPendingManual(),
        };
    }

    @Get(':paymentId/submissions')
    async getPaymentSubmissions(@Param('paymentId') paymentId: string) {
        return {
            success: true,
            data: await this.paymentsService.getSubmissionHistoryByPaymentId(paymentId),
        };
    }

    @Get()
    async listByStatus(@Query('status') status?: string) {
        if (!status) {
            throw new BadRequestException('Query parameter status is required (approved or rejected)');
        }
        const normalized = status.trim().toLowerCase();
        if (normalized === 'approved') {
            return {
                success: true,
                data: await this.paymentsService.findManualPaymentsByStatus(PaymentStatus.APPROVED),
            };
        }
        if (normalized === 'rejected') {
            return {
                success: true,
                data: await this.paymentsService.findManualPaymentsByStatus(PaymentStatus.REJECTED),
            };
        }
        throw new BadRequestException('status must be approved or rejected');
    }

    @Post(':paymentId/verify')
    async verifyPayment(
        @Param('paymentId') paymentId: string,
        @Body() body: { status: PaymentStatus; feedback?: string },
    ) {
        const allowed = [PaymentStatus.APPROVED, PaymentStatus.REJECTED];
        if (!body.status || !allowed.includes(body.status)) {
            throw new BadRequestException('status must be "approved" or "rejected"');
        }
        if (body.status === PaymentStatus.REJECTED) {
            if (typeof body.feedback !== 'string' || !body.feedback.trim()) {
                throw new BadRequestException('feedback is required when rejecting');
            }
        }

        return await this.paymentsService.verifyManualPayment(paymentId, body.status, body.feedback);
    }

    @Patch(':paymentId/verify')
    verifyPaymentDeprecated() {
        throw new MethodNotAllowedException(
            'PATCH is no longer supported. Use POST /api/v1/admin/payments/:paymentId/verify with body { "status": "approved" | "rejected", "feedback"?: string }.',
        );
    }

    @Post(':paymentId/revert')
    async revertPayment(
        @Request() req: { user: { id: string; email?: string } },
        @Param('paymentId') paymentId: string,
        @Body() body: { reason?: string },
    ) {
        return await this.paymentsService.revertManualPaymentApproval(
            paymentId,
            { id: req.user.id, email: req.user.email },
            body?.reason,
        );
    }
}
