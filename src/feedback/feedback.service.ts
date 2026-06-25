import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { CepSurveyResponse } from './entities/cep-survey-response.entity';
import { CreateCepSurveyResponseDto } from './dto/create-cep-survey-response.dto';
import { User } from '../users/entities/user.entity';

@Injectable()
export class FeedbackService {
    constructor(
        @InjectRepository(CepSurveyResponse)
        private readonly cepRepo: Repository<CepSurveyResponse>,
        @InjectRepository(User)
        private readonly userRepo: Repository<User>,
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

    /** Admin list: post-report CEP experience survey submissions. */
    async listCepExperienceForAdmin(page = 1, limit = 20) {
        const p = Math.max(1, Math.floor(page) || 1);
        const l = Math.min(100, Math.max(1, Math.floor(limit) || 20));
        const skip = (p - 1) * l;

        const [rows, total] = await this.cepRepo.findAndCount({
            order: { createdAt: 'DESC' },
            skip,
            take: l,
        });

        const userIds = [...new Set(rows.map((r) => r.userId).filter(Boolean))];
        const users =
            userIds.length > 0
                ? await this.userRepo.find({
                      where: { id: In(userIds) },
                      select: ['id', 'name', 'email', 'role'],
                  })
                : [];
        const userById = new Map(users.map((u) => [u.id, u]));

        return {
            success: true,
            data: rows.map((row) => {
                const user = userById.get(row.userId);
                return {
                    id: row.id,
                    user_id: row.userId,
                    user_name: user?.name ?? null,
                    user_email: user?.email ?? null,
                    user_role: row.userRole,
                    account_role: user?.role ?? null,
                    survey_version: row.surveyVersion,
                    overall_rating: row.overallRating,
                    sections_ease: row.sectionsEase,
                    reflect_impact: row.reflectImpact,
                    most_useful_text: row.mostUsefulText,
                    improvement_text: row.improvementText,
                    created_at: row.createdAt,
                };
            }),
            meta: { page: p, limit: l, total },
        };
    }
}
