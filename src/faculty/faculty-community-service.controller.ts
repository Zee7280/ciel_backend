import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { UserRole } from '../users/enums/user-role.enum';
import { FacultyReportsService } from '../reports/faculty-reports.service';
import { CommunityAwardService } from '../reports/community-award.service';
import { NotifyCommunityAwardDto } from '../reports/dto/notify-community-award.dto';

@Controller('faculty/community-service')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.FACULTY)
export class FacultyCommunityServiceController {
  constructor(
    private readonly facultyReportsService: FacultyReportsService,
    private readonly communityAward: CommunityAwardService,
  ) {}

  /** Read-only pool for linked projects. Faculty cannot run or publish Ruberix ranking. */
  @Get('award-cards')
  async awardCards(@Request() req) {
    const reports = await this.facultyReportsService.listAssignedReports(
      req.user.id,
      req.user.email,
    );
    return {
      success: true,
      data: this.communityAward.cardsFrom(reports, true),
    };
  }

  @Post('award-notify')
  async awardNotify(@Request() _req, @Body() _dto: NotifyCommunityAwardDto) {
    throw new ForbiddenException(
      'Only University and CIEL PK Super Admin can run or publish Community Service Ruberix rankings.',
    );
  }
}
