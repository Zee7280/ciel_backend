import {
  Body,
  Controller,
  ForbiddenException,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RateLimit, RateLimitGuard } from '../common/rate-limit/rate-limit.guard';
import { UserRole } from '../users/enums/user-role.enum';
import { AiService } from './ai.service';
import { SummarizeAiDto } from './dto/summarize-ai.dto';

/**
 * Evaluator sections produce institutional scores / verdicts. Only CIEL PK Admin may trigger them
 * (the dedicated admin analyse routes already do, server-side, bound to a real report). Students,
 * faculty and org users must not be able to run the final analyzer with a self-written payload.
 */
const ADMIN_ONLY_SECTIONS = new Set([
  'section11_master_rubric',
  'cii_v2_evaluation',
  'fyp_ai_evaluation',
]);

@Controller('ai')
@UseGuards(JwtAuthGuard, RateLimitGuard)
export class AiController {
  constructor(private readonly aiService: AiService) {}

  @Post('summarize')
  @RateLimit({
    name: 'ai-summarize',
    limit: 10,
    windowMs: 60_000,
    by: 'user',
    message: 'Too many AI requests. Please wait a minute and try again.',
  })
  async summarize(@Request() req, @Body() dto: SummarizeAiDto) {
    if (
      ADMIN_ONLY_SECTIONS.has(dto.section) &&
      req.user?.role !== UserRole.SUPER_ADMIN
    ) {
      throw new ForbiddenException(
        'This AI analysis can only be run by CIEL PK Admin.',
      );
    }
    return this.aiService.summarize(dto.section, dto.data);
  }
}
