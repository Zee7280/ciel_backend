import {
    Controller,
    Get,
    Patch,
    Param,
    Body,
    UseGuards,
    BadRequestException,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { UserRole } from '../users/enums/user-role.enum';
import { PaymentsService } from './payments.service';

@Controller('admin/payments')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.SUPER_ADMIN)
export class AdminPaymentsController {
    constructor(private readonly paymentsService: PaymentsService) { }

    @Get('pending')
    async getPendingPayments() {
        return {
            success: true,
            data: await this.paymentsService.getPendingPayments(),
        };
    }

    @Patch(':id/verify')
    async verifyPayment(
        @Param('id') id: string,
        @Body() body: { action: 'approve' | 'reject', feedback?: string },
    ) {
        if (!body.action || !['approve', 'reject'].includes(body.action)) {
            throw new BadRequestException('Action must be either "approve" or "reject"');
        }

        return await this.paymentsService.verifyPayment(id, body.action, body.feedback);
    }
}
