import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Request,
  Res,
  ServiceUnavailableException,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request as ExpressRequest, Response } from 'express';
import {
  isMailWebhookAuthorized,
  normalizeMailWebhookEvents,
} from './followup.util';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { UserRole } from '../users/enums/user-role.enum';
import {
  RateLimit,
  RateLimitGuard,
} from '../common/rate-limit/rate-limit.guard';
import { FollowUpsService } from './followups.service';
import {
  AdminActivateFollowUpDto,
  AdminFollowUpActionDto,
  AdminFollowUpListQueryDto,
  AdminFollowUpQuestionsDto,
  DeclineFollowUpDto,
  SubmitFollowUpResponseDto,
} from './dto/follow-up.dto';

interface AuthedRequest {
  user: { id: string; email?: string; name?: string; role?: string };
}

const actorOf = (req: AuthedRequest) => ({
  id: req.user?.id,
  name: req.user?.name,
  email: req.user?.email,
});

/** CIEL PK admin: review questions, schedule, dispatch history and the partner's answers. */
@Controller('admin/reports')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.SUPER_ADMIN)
export class AdminFollowUpsController {
  constructor(private readonly followUps: FollowUpsService) {}

  @Get(':id/followup')
  get(@Param('id') id: string) {
    return this.followUps.getForAdmin(id);
  }

  @Post(':id/followup/activate')
  activate(
    @Request() req: AuthedRequest,
    @Param('id') id: string,
    @Body() body?: AdminActivateFollowUpDto,
  ) {
    return this.followUps.activateByAdmin(id, actorOf(req), body);
  }

  @Get(':id/followup/audit')
  audit(@Param('id') id: string) {
    return this.followUps.auditTrail(id);
  }

  @Patch(':id/followup/questions')
  updateQuestions(
    @Request() req: AuthedRequest,
    @Param('id') id: string,
    @Body() body: AdminFollowUpQuestionsDto,
  ) {
    return this.followUps.updateQuestions(id, body, actorOf(req));
  }

  @Post(':id/followup/regenerate')
  regenerate(@Request() req: AuthedRequest, @Param('id') id: string) {
    return this.followUps.regenerateQuestions(id, actorOf(req));
  }

  @Post(':id/followup/send-now')
  sendNow(@Request() req: AuthedRequest, @Param('id') id: string) {
    return this.followUps.sendNow(id, actorOf(req));
  }

  @Post(':id/followup/cancel')
  cancel(
    @Request() req: AuthedRequest,
    @Param('id') id: string,
    @Body() body: AdminFollowUpActionDto,
  ) {
    return this.followUps.cancelByAdmin(id, body?.reason, actorOf(req));
  }

  @Post(':id/followup/mark-reviewed')
  markReviewed(@Request() req: AuthedRequest, @Param('id') id: string) {
    return this.followUps.markReviewed(id, actorOf(req));
  }
}

/** CIEL PK admin: the tracker across every report (list, stats, pending decisions, CSV). */
@Controller('admin/followups')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.SUPER_ADMIN)
export class AdminFollowUpTrackerController {
  constructor(private readonly followUps: FollowUpsService) {}

  @Get()
  list(@Query() query: AdminFollowUpListQueryDto) {
    return this.followUps.listForAdmin(query);
  }

  @Get('opt-outs')
  optOuts() {
    return this.followUps.listOptOuts();
  }

  @Delete('opt-outs/:email')
  removeOptOut(@Request() req: AuthedRequest, @Param('email') email: string) {
    return this.followUps.removeOptOut(email, actorOf(req));
  }

  @Get('export.csv')
  async exportCsv(
    @Query() query: AdminFollowUpListQueryDto,
    @Res() res: Response,
  ) {
    const csv = await this.followUps.exportCsv(query);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="ciel-pk-follow-ups-${new Date().toISOString().slice(0, 10)}.csv"`,
    );
    res.send(csv);
  }
}

/**
 * Mail provider delivery webhook (delivered / deferred / bounced / complained). Authorised by
 * `MAIL_WEBHOOK_SECRET`: `Authorization: Bearer <secret>` or `x-ciel-signature: sha256=<HMAC of
 * the raw body>`. Fails closed when the secret is not configured. Accepts the generic CIEL event
 * shape, Resend and SES notifications (see normalizeMailWebhookEvents).
 */
@Controller('mail')
@UseGuards(RateLimitGuard)
export class MailWebhookController {
  constructor(
    private readonly followUps: FollowUpsService,
    private readonly configService: ConfigService,
  ) {}

  @Post('provider-webhook')
  @HttpCode(200)
  @RateLimit({ name: 'mail-webhook', limit: 600, windowMs: 60 * 60_000 })
  async webhook(
    @Req() req: ExpressRequest & { rawBody?: Buffer },
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-ciel-signature') signature: string | undefined,
    @Body() body: unknown,
  ) {
    const secret = this.configService.get<string>('MAIL_WEBHOOK_SECRET');
    if (!secret || secret.trim().length < 16) {
      throw new ServiceUnavailableException(
        'MAIL_WEBHOOK_SECRET is not configured; delivery webhooks are disabled.',
      );
    }
    if (
      !isMailWebhookAuthorized({
        secret,
        authorization,
        signature,
        rawBody: req.rawBody ?? null,
      })
    ) {
      throw new UnauthorizedException('Invalid webhook credentials.');
    }
    return this.followUps.recordMailEvents(normalizeMailWebhookEvents(body));
  }
}

/** Report owner: status of the follow-up they planned in 9.5 (answers after admin review). */
@Controller('students/reports')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.STUDENT, UserRole.SUPER_ADMIN)
export class StudentFollowUpsController {
  constructor(private readonly followUps: FollowUpsService) {}

  @Get(':id/followup')
  get(@Request() req: AuthedRequest, @Param('id') id: string) {
    return this.followUps.getForStudent(
      id,
      req.user.id,
      String(req.user.role || ''),
    );
  }
}

/**
 * Partner / responsible person, no login: possession of the emailed token is the credential
 * (same design as verifications/verify). Rate limited so link scanners cannot hammer it.
 */
@Controller('public/followups')
@UseGuards(RateLimitGuard)
export class PublicFollowUpsController {
  constructor(private readonly followUps: FollowUpsService) {}

  @Get(':token')
  @RateLimit({ name: 'followup-view', limit: 60, windowMs: 60 * 60_000 })
  view(@Param('token') token: string) {
    return this.followUps.getPublicByToken(token);
  }

  @Post(':token/response')
  @RateLimit({ name: 'followup-respond', limit: 10, windowMs: 60 * 60_000 })
  respond(
    @Param('token') token: string,
    @Body() body: SubmitFollowUpResponseDto,
  ) {
    return this.followUps.submitResponse(token, body);
  }

  @Post(':token/decline')
  @RateLimit({ name: 'followup-decline', limit: 10, windowMs: 60 * 60_000 })
  decline(@Param('token') token: string, @Body() body: DeclineFollowUpDto) {
    return this.followUps.decline(token, body?.reason, body?.optOut);
  }
}
