import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn, ManyToOne, JoinColumn } from 'typeorm';
import { Organization } from '../../organizations/entities/organization.entity';

@Entity('opportunities')
export class Opportunity {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column()
    title: string;

    @Column("text", { array: true, nullable: true })
    types: string[]; // "Training", "Community Service"

    @Column({ nullable: true })
    mode: string; // "On site", "Remote"

    @Column({ type: 'jsonb', nullable: true })
    location: any; // { city, venue, pin }

    @Column({ type: 'jsonb', nullable: true })
    timeline: any; // { type, start_date, end_date, expected_hours, volunteers_required }

    @Column({ type: 'jsonb', nullable: true })
    sdg_info: any; // { sdg_id, target_id, indicator_id }

    @Column({ type: 'jsonb', nullable: true })
    secondary_sdgs: any[]; // Array of { sdg_id, target_id, indicator_id, justification }

    @Column({ type: 'jsonb', nullable: true })
    objectives: any; // { description, beneficiaries_count, beneficiaries_type }

    @Column({ type: 'jsonb', nullable: true })
    activity_details: any; // { student_responsibilities, skills_gained }

    @Column({ type: 'jsonb', nullable: true })
    supervision: any; // { supervisor_name, role, contact, safe_environment, supervised }

    @Column("text", { array: true, nullable: true })
    verification_method: string[];

    @Column({ default: 'public' })
    visibility: string;

    @Column({ default: 'pending_approval' })
    status: string; // active, closed, draft, pending_approval, rejected

    @ManyToOne(() => Organization, { nullable: true })
    @JoinColumn({ name: 'organizationId' })
    organization: Organization;

    @Column({ nullable: true })
    organizationId: string;

    @Column()
    sdg: string; // Keeping for backward compatibility if needed, or remove? Spec says sdg_info. I'll keep it as optional or remove if unused. Let's keep it but maybe nullable.

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
