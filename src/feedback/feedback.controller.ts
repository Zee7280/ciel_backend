import { Body, Controller, Post, Request, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { FeedbackService } from './feedback.service';
import { CreateCepSurveyResponseDto } from './dto/create-cep-survey-response.dto';

@Controller('feedback')
@UseGuards(JwtAuthGuard)
export class FeedbackController {
    constructor(private readonly feedbackService: FeedbackService) {}

    /** CEP / Community Engagement report experience (student-focused; any logged-in role may submit). */
    @Post('cep-experience')
    async submitCep(@Request() req, @Body() dto: CreateCepSurveyResponseDto) {
        return this.feedbackService.submitCepExperience(req.user.id, req.user.role || '', dto);
    }
}
