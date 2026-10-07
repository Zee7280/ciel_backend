import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Post,
  Request,
  UseGuards,
  BadRequestException,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { UserRole } from '../users/enums/user-role.enum';
import { FacultyReportsService } from '../reports/faculty-reports.service';
import { CommunityAwardService } from '../reports/community-award.service';
import { NpeRankingService } from '../ranking/npe-ranking.service';
import { NotifyCommunityAwardDto } from '../reports/dto/notify-community-award.dto';
import { OpportunitiesService } from '../opportunities/opportunities.service';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Opportunity } from '../opportunities/entities/opportunity.entity';

@Controller('faculty/community-service')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.FACULTY)
export class FacultyCommunityServiceController {
  constructor(
    private readonly facultyReportsService: FacultyReportsService,
    private readonly communityAward: CommunityAwardService,
    private readonly npeRanking: NpeRankingService,
    private readonly opportunitiesService: OpportunitiesService,
    @InjectRepository(Opportunity)
    private readonly opportunitiesRepository: Repository<Opportunity>,
  ) {}

  /**
   * Assigned students on opportunities this faculty supervises: live hours, last activity,
   * and report progress. Does not expose student phone numbers.
   */
  @Get('tracking')
  async tracking(@Request() req) {
    return this.facultyReportsService.listProjectTracking(
      req.user.id,
      req.user.email,
    );
  }

  /** Read-only pool for linked projects. Faculty cannot run or publish Ruberix ranking. */
  @Get('award-cards')
  async awardCards(@Request() req) {
    const reports = await this.facultyReportsService.listAssignedReports(
      req.user.id,
      req.user.email,
    );
    return {
      success: true,
      data: await this.npeRanking.decorateAwardCards(
        this.communityAward.cardsFrom(reports, true),
      ),
    };
  }

  @Post('award-notify')
  async awardNotify(@Request() _req, @Body() _dto: NotifyCommunityAwardDto) {
    throw new ForbiddenException(
      'Only University and CIEL PK Super Admin can run or publish Community Service Ruberix rankings.',
    );
  }

  /** Exceptional: reopen reporting window for an opportunity this faculty owns or supervises. */
  @Post('opportunities/:id/reopen-reporting-window')
  async reopenReportingWindow(
    @Request() req,
    @Param('id') id: string,
    @Body() body: { until?: string; reporting_window_reopened_until?: string },
  ) {
    const until = body.until || body.reporting_window_reopened_until;
    if (!until) {
      throw new BadRequestException(
        'Body must include until (YYYY-MM-DD) for the new reporting close date.',
      );
    }
    const opp = await this.opportunitiesRepository.findOne({ where: { id } });
    if (!opp) throw new NotFoundException('Opportunity not found');
    const facultyId = String(req.user.id || '');
    const email = String(req.user.email || '')
      .trim()
      .toLowerCase();
    const supervision = opp.supervision as
      | { contact?: string }
      | null
      | undefined;
    const contact = String(supervision?.contact || '')
      .trim()
      .toLowerCase();
    const owns =
      opp.creatorId === facultyId ||
      opp.facultyId === facultyId ||
      (email && contact && email === contact);
    if (!owns) {
      throw new ForbiddenException(
        'You can only reopen reporting for opportunities you created or supervise.',
      );
    }
    const data = await this.opportunitiesService.reopenReportingWindow(id, until);
    return { success: true, data };
  }
}
