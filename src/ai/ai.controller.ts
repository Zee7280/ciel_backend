import {
  Body,
  Controller,
  ForbiddenException,
  Optional,
  PayloadTooLargeException,
  Post,
  Request,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import {
  RateLimit,
  RateLimitGuard,
} from '../common/rate-limit/rate-limit.guard';
import { UserRole } from '../users/enums/user-role.enum';
import { AiService } from './ai.service';
import { SummarizeAiDto } from './dto/summarize-ai.dto';
import { OpportunityDraftDto } from './dto/opportunity-draft.dto';
import { PlatformSettingsService } from '../settings/platform-settings.service';

/** Roles that create opportunities through the guided wizard and may ask AI for a draft. */
const OPPORTUNITY_DRAFT_ROLES = new Set<UserRole | undefined>([
  UserRole.STUDENT,
  UserRole.FACULTY,
  UserRole.SUPER_ADMIN,
]);

/**
 * Evaluator sections produce institutional scores / verdicts. Only CIEL PK Admin may trigger them
 * (the dedicated admin analyse routes already do, server-side, bound to a real report). Students,
 * faculty and org users must not be able to run the final analyzer with a self-written payload.
 */
const ADMIN_ONLY_SECTIONS = new Set([
  'cii_v4_5_evaluation',
  'fyp_ai_evaluation',
  // Reasoning model + server-side evidence downloads; the ranking studio runs it server-side.
  'npe_ranking_evaluation',
]);

/** A wizard section is a few KB of text; a larger payload is only prompt-cost abuse. */
const MAX_SUMMARIZE_DATA_CHARS = 300_000;

/** The request as populated by JwtAuthGuard (JwtStrategy.validate). */
interface AuthenticatedRequest {
  user?: { id?: string; role?: UserRole };
}

@Controller('ai')
@UseGuards(JwtAuthGuard, RateLimitGuard)
export class AiController {
  constructor(
    private readonly aiService: AiService,
    @Optional()
    private readonly platformSettings?: PlatformSettingsService,
  ) {}

  /** Drafts editable opportunity text from a student's brainstorm. Never sets approvals or contacts. */
  @Post('opportunity-draft')
  @RateLimit(
    {
      name: 'ai-opportunity-draft',
      limit: 3,
      windowMs: 60_000,
      by: 'user',
      message: 'Too many AI drafts. Please wait a minute and try again.',
    },
    {
      name: 'ai-opportunity-draft-daily',
      limit: 30,
      windowMs: 24 * 60 * 60_000,
      by: 'user',
      message:
        'Daily AI draft limit reached. Please continue editing the form yourself.',
    },
  )
  async opportunityDraft(
    @Request() req: AuthenticatedRequest,
    @Body() dto: OpportunityDraftDto,
  ) {
    if (!OPPORTUNITY_DRAFT_ROLES.has(req.user?.role)) {
      throw new ForbiddenException(
        'AI drafting is not available for this account.',
      );
    }
    const enabled = this.platformSettings
      ? await this.platformSettings.isAiOpportunityDraftEnabled()
      : false;
    if (!enabled) {
      throw new ServiceUnavailableException(
        'AI drafting is not available right now.',
      );
    }
    const result = await this.aiService.generateOpportunityDraft(dto);
    return { success: true, data: result };
  }

  @Post('summarize')
  @RateLimit({
    name: 'ai-summarize',
    limit: 10,
    windowMs: 60_000,
    by: 'user',
    message: 'Too many AI requests. Please wait a minute and try again.',
  })
  async summarize(
    @Request() req: AuthenticatedRequest,
    @Body() dto: SummarizeAiDto,
  ) {
    if (
      ADMIN_ONLY_SECTIONS.has(dto.section) &&
      req.user?.role !== UserRole.SUPER_ADMIN
    ) {
      throw new ForbiddenException(
        'This AI analysis can only be run by CIEL PK Admin.',
      );
    }
    if (
      req.user?.role !== UserRole.SUPER_ADMIN &&
      (JSON.stringify(dto.data ?? null)?.length ?? 0) > MAX_SUMMARIZE_DATA_CHARS
    ) {
      throw new PayloadTooLargeException(
        'This section is too large to summarize. Shorten the text and try again.',
      );
    }
    return this.aiService.summarize(dto.section, dto.data);
  }
}
