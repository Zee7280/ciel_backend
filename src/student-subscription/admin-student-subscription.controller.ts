import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Request,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { UserRole } from '../users/enums/user-role.enum';
import { AdminMutationAuditInterceptor } from '../audit-logs/admin-mutation-audit.interceptor';
import { StudentSubscriptionService } from './student-subscription.service';

@Controller('admin/student-subscriptions')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.SUPER_ADMIN)
@UseInterceptors(AdminMutationAuditInterceptor)
export class AdminStudentSubscriptionController {
  constructor(private readonly subscriptionService: StudentSubscriptionService) {}

  @Get('pending')
  async listPending() {
    return { success: true, data: await this.subscriptionService.listPendingReview() };
  }

  @Get('history')
  async listHistory(@Query('page') page?: string, @Query('limit') limit?: string) {
    const result = await this.subscriptionService.listHistoryPaged({ page, limit });
    return {
      success: true,
      data: result.rows,
      total: result.total,
      pagination: { total: result.total, page: result.page, limit: result.limit },
    };
  }

  @Post(':id/approve')
  async approve(
    @Request() req: any,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body?: { allowAmountMismatch?: boolean },
  ) {
    const row = await this.subscriptionService.approveSubmission(id, req.user.id, {
      allowAmountMismatch: body?.allowAmountMismatch === true,
    });
    return {
      success: true,
      message: 'Subscription approved; student account activated',
      data: { id: row.id, userId: row.userId, status: row.status },
    };
  }

  @Post(':id/reject')
  async reject(
    @Request() req: any,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: { feedback?: string },
  ) {
    const row = await this.subscriptionService.rejectSubmission(id, req.user.id, body?.feedback);
    return {
      success: true,
      message: 'Submission rejected; student may submit again',
      data: { id: row.id, userId: row.userId, status: row.status },
    };
  }
}
