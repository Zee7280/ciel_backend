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

    @ManyToOne(() => Opportunity, { nullable: true })
    @JoinColumn({ name: 'opportunityId' })
    opportunity: Opportunity;

    @Column({ nullable: true })
    opportunityId: string;

    @Column({ nullable: true })
    project_id: string;

    @Column({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
    submission_date: Date;

    @Column({ default: 'draft' })
    status: string; // 'draft', 'submitted', 'partner_verified', 'verified', 'rejected'

    @Column({ default: 'pending' })
    partner_status: string; // 'pending', 'approved', 'rejected'

    @Column({ default: 'pending' })
    admin_status: string; // 'pending', 'approved', 'rejected'

    // Section 1: Context
    @Column({ type: 'jsonb', nullable: true })
    section1: {
        problem_statement: string;
        privacy_consent: boolean;
    };

    // Section 2: Team
    @Column({ type: 'jsonb', nullable: true })
    section2: {
        participation_type: 'individual' | 'team';
        team_lead: {
            name: string;
            cnic: string;
            mobile: string;
            email: string;
            university: string;
            degree: string;
            year: string;
        };
        team_members?: Array<{
            name: string;
            cnic: string;
            mobile: string;
            university: string;
            program: string;
            role: string;
            hours: number;
        }>;
        privacy_consent: boolean;
    };

    // Section 3: SDG Mapping
    @Column({ type: 'jsonb', nullable: true })
    section3: {
        primary_sdg_explanation: string;
        secondary_sdgs: Array<{
            sdg_id: string;
            target_id?: string;
            indicator_id?: string;
            justification: string;
            evidence_files: string[]; // File paths
        }>;
    };

    // Section 4: Activities
    @Column({ type: 'jsonb', nullable: true })
    section4: {
        activity_description: string;
        has_financial_resources: 'yes' | 'no';
        personal_funds?: number;
        personal_funds_purpose?: string[];
        raised_funds?: number;
        raised_funds_source?: string[];
        evidence_files: string[];
    };

    // Section 5: Outcomes
    @Column({ type: 'jsonb', nullable: true })
    section5: {
        observed_change: string;
        metrics: Array<{
            metric: string;
            baseline: string;
            endline: string;
            unit: string;
        }>;
    };

    // Section 6: Resources
    @Column({ type: 'jsonb', nullable: true })
    section6: {
        used_resources: 'yes' | 'no';
        resources?: Array<{
            type: string;
            amount: string;
            source: string;
            purpose: string;
        }>;
        evidence_files: string[];
    };

    // Section 7: Partnerships
    @Column({ type: 'jsonb', nullable: true })
    section7: {
        has_partners: 'yes' | 'no';
        partners?: Array<{
            name: string;
            type: string;
            role: string;
            contribution: string;
        }>;
        formalization?: string[];
        formalization_files: string[];
    };

    // Section 8: Evidence
    @Column({ type: 'jsonb', nullable: true })
    section8: {
        evidence_types: string[];
        evidence_files: string[];
        description: string;
        media_usage: 'public' | 'limited' | 'internal';
        consent_authentic: boolean;
        consent_informed: boolean;
        consent_no_harm: boolean;
        partner_verified: boolean;
        partner_verification_files: string[];
    };

    // Section 10: Reflection
    @Column({ type: 'jsonb', nullable: true })
    section10: {
        personal_learning: string;
        sustainability_status: 'yes' | 'partially' | 'no';
        sustainability_plan: string;
    };

    // Section 12: Declaration
    @Column({ type: 'jsonb', nullable: true })
    section12: {
        student_declaration: boolean;
        partner_verification: boolean;
        partner_verification_files: string[];
    };

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
