import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn, ManyToOne, JoinColumn } from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { Opportunity } from '../../opportunities/entities/opportunity.entity';

@Entity('student_reports')
export class StudentReport {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @ManyToOne(() => User, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'studentId' })
    student: User;

    @Column()
    studentId: string;

    @ManyToOne(() => Opportunity, { nullable: true, onDelete: 'CASCADE' })
    @JoinColumn({ name: 'opportunityId' })
    opportunity: Opportunity;

    @Column({ nullable: true })
    opportunityId: string;

    @Column({ nullable: true })
    project_id: string;

    @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
    @JoinColumn({ name: 'facultyId' })
    faculty: User;

    @Column({ type: 'uuid', nullable: true })
    facultyId: string | null;

    @Column({ default: 'pending' })
    faculty_status: string; // 'pending', 'approved', 'rejected'

    @Column({ type: 'text', nullable: true })
    faculty_remarks: string;

    @Column({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
    submission_date: Date;

    @Column({ default: 'draft' })
    status: string; // 'draft', 'submitted', 'partner_verified', 'payment_pending' (legacy), 'payment_under_review', 'verified', 'rejected', 'paid'

    @Column({ default: 'pending' })
    partner_status: string; // 'pending', 'approved', 'rejected'

    @Column({ default: 'pending' })
    admin_status: string; // 'pending', 'approved', 'rejected'

    @Column({ type: 'text', nullable: true })
    admin_feedback: string;

    // Auto-Generated Summary Fields (Section 2 Context)
    @Column({ type: 'text', nullable: true })
    summary_text_generated: string;

    @Column({ nullable: true })
    problem_category: string;

    @Column({ nullable: true })
    primary_beneficiary: string;

    @Column({ nullable: true })
    baseline_evidence_source: string;

    @Column({ nullable: true })
    discipline_alignment: string;

    // Section 3: SDG Mapping Metadata
    @Column({ nullable: true })
    primary_sdg_goal: number;

    @Column({ nullable: true })
    primary_sdg_target: string;

    @Column({ nullable: true })
    primary_sdg_indicator: string;

    @Column({ type: 'text', nullable: true })
    contribution_intent_statement: string;

    @Column({ default: 'pending' })
    sdg_validation_status: string; // 'pending', 'validated', 'weak'

    @Column({ default: 'preliminary' })
    sdg_summary_stage: string; // 'preliminary', 'validated'

    // Section 1: Participation (Standardized 11-section structure)
    @Column({ type: 'jsonb', nullable: true })
    section1: {
        participation_type: 'individual' | 'team';
        faculty_supervisor_email?: string;
        team_lead: {
            name: string;
            fullName?: string;
            cnic: string;
            mobile: string;
            email: string;
            university: string;
            degree: string;
            year: string;
            role?: string;
            hours?: string;
            verified?: boolean;
        };
        team_members?: Array<{
            name: string;
            fullName?: string;
            cnic: string;
            mobile: string;
            university: string;
            program: string;
            role: string;
            hours: string;
            verified?: boolean;
        }>;
        attendance_logs: Array<{
            id: string;
            date: string;
            start_time: string;
            end_time: string;
            location: string;
            activity_type: string;
            description: string;
            hours: number;
            entryStatus?: string;
        }>;
        metrics: {
            total_verified_hours: number;
            total_active_days: number;
            engagement_span: number;
            attendance_frequency: number;
            weekly_continuity: number;
            eis_score: number;
            engagement_category: string;
            hec_compliance: string;
        };
        privacy_consent: boolean;
        verified_summary?: string;
        media_urls?: string[];
    };

    // Section 2: Project Context
    @Column({ type: 'jsonb', nullable: true })
    section2: {
        problem_statement: string;
        discipline: string;
        discipline_contribution: string;
        baseline_evidence: string;
        baseline_evidence_other?: string;
        problem_category?: string;
        primary_beneficiary?: string;
        summary_text?: string;
        media_urls?: string[];
    };

    // Section 3: SDG Contribution Mapping
    @Column({ type: 'jsonb', nullable: true })
    section3: {
        primary_sdg: {
            goal_number: number | null;
            goal_title: string;
            target_code: string;
            indicator_code: string;
        };
        contribution_intent_statement: string;
        secondary_sdgs: Array<{
            goal_number: number;
            justification_text: string;
            status: 'provisional' | 'validated' | 'rejected';
        }>;
        summary_text?: string;
        media_urls?: string[];
    };

    // Section 4: Activities (Expanded)
    @Column({ type: 'jsonb', nullable: true })
    section4: {
        activity_type: string;
        delivery_mode: string;
        total_sessions: string;
        duration_val: string;
        duration_unit: string;
        total_beneficiaries: string;
        my_role: string;
        my_hours: string;
        my_sessions: string;
        my_beneficiaries: string;
        my_output: string;
        beneficiary_categories: string[];
        media_urls?: string[];
    };

    // Section 5: Outcomes (Detailed Metrics)
    @Column({ type: 'jsonb', nullable: true })
    section5: {
        observed_change: string;
        outcome_area: string;
        metric: string;
        baseline: string;
        endline: string;
        unit: string;
        confidence_level: string;
        challenges: string;
        media_urls?: string[];
    };

    // Section 6: Resources (Structured)
    @Column({ type: 'jsonb', nullable: true })
    section6: {
        use_resources: 'yes' | 'no';
        resources: Array<{
            type: string;
            amount: string;
            unit: string;
            source: string;
            purpose: string;
            verification: string;
        }>;
        media_urls?: string[];
    };

    // Section 7: Partnerships (Structured)
    @Column({ type: 'jsonb', nullable: true })
    section7: {
        has_partners: 'yes' | 'no';
        partners: Array<{
            name: string;
            type: string;
            role: string;
            contribution: string[];
            verification: string;
        }>;
        formalization_status: string[];
        media_urls?: string[];
    };

    // Section 8: Evidence (Expanded)
    @Column({ type: 'jsonb', nullable: true })
    section8: {
        evidence_types: string[];
        description: string;
        media_visible: 'public' | 'limited' | 'internal';
        ethical_compliance: {
            authentic: boolean;
            informed_consent: boolean;
            no_harm: boolean;
            privacy_respected: boolean;
        };
        partner_verification: boolean;
        media_urls?: string[];
    };

    // Section 9: Reflection (Academic Integration)
    @Column({ type: 'jsonb', nullable: true })
    section9: {
        academic_integration: string;
        personal_learning: string;
        academic_application: string;
        sustainability_reflection: string;
        competency_scores: {
            cognitive: number;
            practical: number;
            social: number;
            transformative: number;
        };
        strongest_competency: string;
        media_urls?: string[];
    };

    // Section 10: Sustainability (Planning)
    @Column({ type: 'jsonb', nullable: true })
    section10: {
        continuation_status: 'yes' | 'partially' | 'no';
        continuation_details: string;
        mechanisms: string[];
        scaling_potential: string;
        policy_influence: string;
        media_urls?: string[];
    };

    // Section 11: Final Intelligence Summary
    @Column({ type: 'jsonb', nullable: true })
    section11: {
        ai_generated_impact_score?: number;
        institutional_alignment_score?: number;
        verified_narrative?: string;
    };

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
