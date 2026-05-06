import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/** Community Engagement Program / CEPK experience survey (quantitative + short qualitative). */
@Entity('cep_survey_responses')
export class CepSurveyResponse {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Index()
    @Column({ type: 'uuid' })
    userId: string;

    @Column({ type: 'varchar', length: 32 })
    userRole: string;

    /** Bump when questionnaire changes (e.g. cep_report_v2). */
    @Column({ type: 'varchar', length: 32, default: 'cep_report_v1' })
    surveyVersion: string;

    @Column({ type: 'int' })
    overallRating: number;

    /** very_easy | easy | neutral | difficult | very_difficult */
    @Column({ type: 'varchar', length: 24 })
    sectionsEase: string;

    /** yes | partially | no */
    @Column({ type: 'varchar', length: 16 })
    reflectImpact: string;

    @Column({ type: 'text', nullable: true })
    mostUsefulText: string | null;

    @Column({ type: 'text', nullable: true })
    improvementText: string | null;

    @CreateDateColumn()
    createdAt: Date;
}
