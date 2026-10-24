import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  UseGuards,
  Request,
  UseInterceptors,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { UserRole } from '../users/enums/user-role.enum';
import { OrganizationMembershipService } from './organization-membership.service';
import { AdminMutationAuditInterceptor } from '../audit-logs/admin-mutation-audit.interceptor';

/** Shape of `req.user` as returned by JwtStrategy.validate. */
interface AdminMembershipRequest {
  user: { id: string };
}

@Controller('admin/org-membership')
@UseGuards(JwtAuthGuard)
@UseInterceptors(AdminMutationAuditInterceptor)
export class AdminOrganizationMembershipController {
  constructor(
    private readonly membershipService: OrganizationMembershipService,
  ) {}

  @Get('pending')
  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  async listPending() {
    const data = await this.membershipService.listPendingReview();
    return { success: true, data };
  }

  @Get('history')
  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  async listHistory(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const result = await this.membershipService.listHistoryPaged({
      page,
      limit,
    });
    return {
      success: true,
      data: result.rows,
      total: result.total,
      pagination: {
        total: result.total,
        page: result.page,
        limit: result.limit,
      },
    };
  }

  @Post(':id/approve')
  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  async approve(
    @Request() req: AdminMembershipRequest,
    @Param('id') id: string,
    @Body() body?: { allowAmountMismatch?: boolean },
  ) {
    const row = await this.membershipService.approveSubmission(
      id,
      req.user.id,
      {
        allowAmountMismatch: body?.allowAmountMismatch === true,
      },
    );
    return {
      success: true,
      message:
        'Membership fee approved. The account is active once its organization profile is approved.',
      data: { id: row.id, userId: row.userId, status: row.status },
    };
  }

  @Post(':id/reject')
  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  async reject(
    @Request() req: AdminMembershipRequest,
    @Param('id') id: string,
    @Body() body: { feedback?: string },
  ) {
    const row = await this.membershipService.rejectSubmission(
      id,
      req.user.id,
      body?.feedback,
    );
    return {
      success: true,
      message: 'Submission rejected; user may submit again',
      data: { id: row.id, userId: row.userId, status: row.status },
    };
  }
}
