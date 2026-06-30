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
    timeline: any; // { type, start_date, end_date, from_time, to_time, expected_hours, volunteers_required }

    @Column({ type: 'jsonb', nullable: true })
    sdg_info: any; // { sdg_id, target_id, indicator_id }

    @Column({ type: 'jsonb', nullable: true })
    secondary_sdgs: any[]; // Array of { sdg_id, target_id, indicator_id, justification }

    @Column({ type: 'jsonb', nullable: true })
    objectives: any; // { description, beneficiaries_count, beneficiaries_type }

    @Column({ type: 'jsonb', nullable: true })
    activity_details: any; // { student_responsibilities, skills_gained }

    @Column({ type: 'jsonb', nullable: true })
    supervision: any; // { supervisor_name, role, contact, safe_environment, supervised, partner_org_name, partner_contact_person, partner_email, information_accurate }

    @Column("text", { array: true, nullable: true })
    verification_method: string[];

    @Column("text", { array: true, nullable: true })
    restricted_universities: string[];

    @Column({ type: 'jsonb', nullable: true })
    executing_context: any; // { type: 'partner' | 'independent', ... }

    // Partner / faculty / student extended metadata
    @Column({ type: 'jsonb', nullable: true })
    executing_organization: any; // { name, contact_person_name, official_email }

    @Column({ type: 'jsonb', nullable: true })
    partner_organization: any; // optional { organization_name, contact_person_name, official_email }

    @Column({ type: 'jsonb', nullable: true })
    safety_supervision_declaration: any; // partner F3: booleans

    @Column({ type: 'jsonb', nullable: true })
    safety_declaration: any;

    @Column({ type: 'jsonb', nullable: true })
    submission_confirmations: any;

    @Column({ type: 'jsonb', nullable: true })
    participation_scope: any;

    @Column({ type: 'jsonb', nullable: true })
    visibility_and_academic_linkage: any; // { visibility_type, restricted_university_names, faculty_institutional_representative }

    @Column({ default: false })
    admin_approved: boolean;

    @Column({ default: false })
    admin_approval_required: boolean;

    @Column({ type: 'jsonb', nullable: true })
    external_partner_collaboration: any;

    @Column({ type: 'jsonb', nullable: true })
    academic_linkage: any;

    @Column({ nullable: true })
    student_contact: string;

    @Column({ nullable: true })
    faculty_verification_token: string;

    @Column({ default: 'pending_faculty' })
    faculty_verification_status: string; // pending_faculty | faculty_verified | rejected

    @Column({ default: false })
    faculty_verified: boolean;

    @Column({ type: 'uuid', nullable: true })
    execution_verification_token: string | null;

    @Column({ default: false })
    execution_verified: boolean;

    @Column({ default: 'pending_execution' })
    execution_verification_status: string; // pending_execution | execution_verified | rejected

    @Column({ default: 'public' })
    visibility: string;

    @Column({ default: 'pending_approval' })
    status: string; // active, closed, draft, pending_approval, rejected

    @ManyToOne(() => Organization, { nullable: true, onDelete: 'CASCADE' })
    @JoinColumn({ name: 'organizationId' })
    organization: Organization;

    @Column({ name: 'organizationId', type: 'uuid', nullable: true })
    organizationId: string | null;
    
    @Column({ default: 16 })
    requiredHours: number;

    @Column()
    sdg: string; // Keeping for backward compatibility if needed, or remove? Spec says sdg_info. I'll keep it as optional or remove if unused. Let's keep it but maybe nullable.

    @Column({ nullable: true })
    liaisonToken: string;

    @Column({ default: false })
    liaisonVerified: boolean;

    @Column({ nullable: true })
    partnerToken: string;

    @Column({ default: true })
    partnerVerified: boolean;

    @Column({ nullable: true })
    creatorId: string;

    @Column({ type: 'uuid', nullable: true })
    facultyId: string | null;

    /** Student-submitted opportunity; drives multi-step faculty → partner → admin workflow. */
    @Column({ default: false })
    isStudentCreated: boolean;

    @Column({ default: false })
    requiresPartnerApproval: boolean;

    /** Canonical stage for API / frontend (`pending_faculty`, `pending_partner`, `pending_admin`, `live`, …). */
    @Column({ type: 'varchar', length: 64, nullable: true })
    workflowStage: string | null;

    @Column({ type: 'varchar', length: 32, nullable: true })
    facultyApprovalStatus: string | null;

    @Column({ type: 'varchar', length: 32, nullable: true })
    partnerApprovalStatus: string | null;

    @Column({ type: 'varchar', length: 32, nullable: true })
    adminApprovalStatus: string | null;

    @Column({ type: 'text', nullable: true })
    rejectionReason: string | null;

    /** Admin override for attendance approver routing (`auto` | `partner` | `faculty`). */
    @Column({ type: 'varchar', length: 16, default: 'auto' })
    attendanceRoutingOverride: 'auto' | 'partner' | 'faculty';

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
