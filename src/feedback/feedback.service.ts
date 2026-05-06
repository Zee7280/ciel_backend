import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CepSurveyResponse } from './entities/cep-survey-response.entity';
import { CreateCepSurveyResponseDto } from './dto/create-cep-survey-response.dto';

@Injectable()
export class FeedbackService {
    constructor(
        @InjectRepository(CepSurveyResponse)
        private readonly cepRepo: Repository<CepSurveyResponse>,
    ) {}

    async submitCepExperience(
        userId: string,
        userRole: string,
        dto: CreateCepSurveyResponseDto,
        surveyVersion = 'cep_report_v1',
    ) {
        const row = this.cepRepo.create({
            userId,
            userRole: (userRole || 'unknown').slice(0, 32),
            surveyVersion,
            overallRating: dto.overallRating,
            sectionsEase: dto.sectionsEase,
            reflectImpact: dto.reflectImpact,
            mostUsefulText: dto.mostUsefulText?.trim() || null,
            improvementText: dto.improvementText?.trim() || null,
        });
        const saved = await this.cepRepo.save(row);
        return { success: true, id: saved.id };
    }
}
