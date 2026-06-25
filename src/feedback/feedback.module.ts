import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CepSurveyResponse } from './entities/cep-survey-response.entity';
import { FeedbackService } from './feedback.service';
import { FeedbackController } from './feedback.controller';
import { User } from '../users/entities/user.entity';

@Module({
    imports: [TypeOrmModule.forFeature([CepSurveyResponse, User])],
    controllers: [FeedbackController],
    providers: [FeedbackService],
    exports: [FeedbackService],
})
export class FeedbackModule {}
