import { proofUploadOptions } from '../common/safe-upload';
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
  Request,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { UserRole } from '../users/enums/user-role.enum';
import { S3Service } from '../common/s3.service';
import { StudentSubscriptionService } from './student-subscription.service';

/** `req.user` as populated by JwtStrategy.validate(). */
type AuthenticatedRequest = { user: { id: string } };

/** Student side of the subscription fee. Deliberately NOT behind SubscriptionActiveGuard. */
@Controller('student/subscription')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.STUDENT, UserRole.SUPER_ADMIN)
export class StudentSubscriptionController {
  constructor(
    private readonly subscriptionService: StudentSubscriptionService,
    private readonly s3Service: S3Service,
  ) {}

  @Get('status')
  async status(@Request() req: AuthenticatedRequest) {
    return {
      success: true,
      data: await this.subscriptionService.getStatusForStudent(req.user.id),
    };
  }

  @Post('submit-proof')
  @UseInterceptors(FileInterceptor('proof', proofUploadOptions))
  async submitProof(
    @Request() req: AuthenticatedRequest,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() body: { paid_amount?: string },
  ) {
    if (!file) {
      throw new BadRequestException(
        'Proof file is required (field name: proof)',
      );
    }
    const proofUrl = await this.s3Service.uploadFile(
      file,
      'subscription-proofs',
    );
    return this.subscriptionService.submitProof(
      req.user.id,
      proofUrl,
      body?.paid_amount,
    );
  }
}
