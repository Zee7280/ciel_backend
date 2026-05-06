import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CepSurveyResponse } from './entities/cep-survey-response.entity';
import { FeedbackService } from './feedback.service';
import { FeedbackController } from './feedback.controller';

@Module({
    imports: [TypeOrmModule.forFeature([CepSurveyResponse])],
    controllers: [FeedbackController],
    providers: [FeedbackService],
})
export class FeedbackModule {}
