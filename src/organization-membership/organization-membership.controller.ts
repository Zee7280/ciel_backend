import {
    BadRequestException,
    Controller,
    Get,
    Post,
    Request,
    UploadedFile,
    UseGuards,
    UseInterceptors,
    Body,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { OrganizationMembershipService } from './organization-membership.service';
import { S3Service } from '../common/s3.service';
import { UserRole } from '../users/enums/user-role.enum';

@Controller('organization-membership')
@UseGuards(JwtAuthGuard)
export class OrganizationMembershipController {
    constructor(
        private readonly membershipService: OrganizationMembershipService,
        private readonly s3Service: S3Service,
    ) { }

    @Get('fee')
    async getMyFee(@Request() req: any) {
        const role = req.user.role as UserRole;
        if (role !== UserRole.UNIVERSITY && role !== UserRole.CORPORATE) {
            return {
                success: true,
                data: { applies: false, amount_pkr: null },
            };
        }
        const amount_pkr = await this.membershipService.getExpectedFeePkr(role);
        return {
            success: true,
            data: {
                applies: true,
                amount_pkr,
                role,
            },
        };
    }

    @Post('submit-proof')
    @UseInterceptors(FileInterceptor('proof'))
    async submitProof(
        @Request() req: any,
        @UploadedFile() file: any,
        @Body() body: { paid_amount?: string },
    ) {
        if (!file) {
            throw new BadRequestException('Proof file is required (field name: proof)');
        }
        const proofUrl = await this.s3Service.uploadFile(file, 'membership-proofs');
        return this.membershipService.submitProof(req.user.id, proofUrl, body?.paid_amount);
    }
}
