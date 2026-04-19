import {
    Controller,
    Get,
    Post,
    Body,
    Request,
    UseGuards,
    UseInterceptors,
    UploadedFile,
    BadRequestException,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { FileInterceptor } from '@nestjs/platform-express';
import { PaymentsService } from './payments.service';

@Controller('student')
@UseGuards(JwtAuthGuard)
export class StudentPaymentsController {
    constructor(private readonly paymentsService: PaymentsService) { }

    @Get('payment-info')
    async getPaymentInfo() {
        return {
            success: true,
            data: await this.paymentsService.getPaymentInfo(),
        };
    }

    @Post('payments/submit')
    @UseInterceptors(FileInterceptor('proof'))
    async submitPayment(
        @Request() req,
        @Body('projectId') projectId: string,
        @Body('paid_amount') paidAmount: string | number | undefined,
        @UploadedFile() file: any,
    ) {
        if (!file) {
            throw new BadRequestException('Payment proof file is required');
        }
        if (!projectId) {
            throw new BadRequestException('projectId is required');
        }

        return await this.paymentsService.submitManualPayment(
            req.user.id,
            projectId,
            file,
            paidAmount,
        );
    }
}
