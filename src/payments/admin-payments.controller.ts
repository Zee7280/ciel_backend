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
import { PaymentStatus } from './entities/payment.entity';

@Controller('admin/payments')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.SUPER_ADMIN)
export class AdminPaymentsController {
    constructor(private readonly paymentsService: PaymentsService) { }

    @Get('pending')
    async getPendingPayments() {
        return {
            success: true,
            data: await this.paymentsService.findAllPendingManual(),
        };
    }

    @Patch(':id/verify')
    async verifyPayment(
        @Param('id') id: string,
        @Body() body: { status: PaymentStatus, feedback?: string },
    ) {
        if (!body.status || !Object.values(PaymentStatus).includes(body.status)) {
            throw new BadRequestException('Invalid status');
        }

        return await this.paymentsService.verifyManualPayment(id, body.status, body.feedback);
    }
}
