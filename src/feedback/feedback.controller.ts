import {
  Body,
  Controller,
  Get,
  Post,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { FeedbackService } from './feedback.service';
import { CreateCepSurveyResponseDto } from './dto/create-cep-survey-response.dto';

@Controller('feedback')
@UseGuards(JwtAuthGuard)
export class FeedbackController {
  constructor(private readonly feedbackService: FeedbackService) {}

  /** Result-package gate: has the signed-in user already given feedback for this report? */
  @Get('cep-experience/status')
  async cepStatus(
    @Request() req: { user: { id: string } },
    @Query('reportId') reportId?: string,
  ) {
    const submitted = await this.feedbackService.hasSubmittedForReport(
      req.user.id,
      reportId || '',
    );
    return { success: true, submitted };
  }

  /** CEP / Community Engagement report experience (student-focused; any logged-in role may submit). */
  @Post('cep-experience')
  async submitCep(
    @Request() req: { user: { id: string; role?: string } },
    @Body() dto: CreateCepSurveyResponseDto,
  ) {
    return this.feedbackService.submitCepExperience(
      req.user.id,
      req.user.role || '',
      dto,
    );
  }
}
