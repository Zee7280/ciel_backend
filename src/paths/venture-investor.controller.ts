import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { SubscriptionActiveGuard } from '../student-subscription/subscription-active.guard';
import { UserRole } from '../users/enums/user-role.enum';
import {
  FounderIntroDecisionDto,
  RecordVentureSignalDto,
} from './dto/venture-investor-signal.dto';
import { VentureInvestorSignalsService } from './venture-investor-signals.service';

type AuthenticatedRequest = {
  user: { id: string; email: string; role: string; status?: string };
};

/**
 * Investor ↔ founder signals on the CIEL Investor Hub: views, saves, interest and introduction
 * requests, stored once (never in the investor's own settings) so founders, faculty,
 * universities and CIEL PK all read the same numbers.
 */
@Controller('paths/startup-business')
@UseGuards(JwtAuthGuard, SubscriptionActiveGuard)
export class VentureInvestorController {
  constructor(private readonly signals: VentureInvestorSignalsService) {}

  /** Everything this investor did, to hydrate the Hub (saved / interest / intro state). */
  @Get('investor-hub/signals')
  @UseGuards(RolesGuard)
  @Roles(UserRole.INVESTOR)
  async mine(@Request() req: AuthenticatedRequest) {
    const data = await this.signals.mine(req.user.id);
    return { success: true, data };
  }

  @Post('investor-hub/:ventureId/signals')
  @UseGuards(RolesGuard)
  @Roles(UserRole.INVESTOR)
  async record(
    @Request() req: AuthenticatedRequest,
    @Param('ventureId', ParseUUIDPipe) ventureId: string,
    @Body() dto: RecordVentureSignalDto,
  ) {
    const data = await this.signals.record(
      { id: req.user.id, status: req.user.status },
      ventureId,
      dto.kind,
      dto.note,
    );
    return { success: true, data };
  }

  @Delete('investor-hub/:ventureId/signals/save')
  @UseGuards(RolesGuard)
  @Roles(UserRole.INVESTOR)
  async unsave(
    @Request() req: AuthenticatedRequest,
    @Param('ventureId', ParseUUIDPipe) ventureId: string,
  ) {
    const data = await this.signals.remove(req.user.id, ventureId, 'save');
    return { success: true, data };
  }

  /** Founder view: interest and introduction requests on their own venture. */
  @Get('investor-signals')
  @UseGuards(RolesGuard)
  @Roles(UserRole.STUDENT, UserRole.FACULTY)
  async forFounder(@Request() req: AuthenticatedRequest) {
    const data = await this.signals.forFounder(req.user.id);
    return { success: true, data };
  }

  /** Gate 2: the founder accepts or declines a CIEL PK-screened introduction. */
  @Patch('investor-signals/:id')
  @UseGuards(RolesGuard)
  @Roles(UserRole.STUDENT, UserRole.FACULTY)
  async founderDecide(
    @Request() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: FounderIntroDecisionDto,
  ) {
    const data = await this.signals.founderDecide(
      req.user.id,
      id,
      dto.decision,
    );
    return { success: true, data };
  }
}
