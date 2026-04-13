import {
    Entity,
    Column,
    PrimaryGeneratedColumn,
    CreateDateColumn,
    UpdateDateColumn,
    ManyToOne,
    JoinColumn,
} from 'typeorm';
import { Opportunity } from './opportunity.entity';
import { User } from '../../users/entities/user.entity';

export type OpportunityApplicationInternalStatus =
    | 'pending_faculty'
    | 'pending_admin'
    | 'approved'
    | 'faculty_rejected'
    | 'admin_rejected';

@Entity('opportunity_applications')
export class OpportunityApplication {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ name: 'opportunity_id', type: 'uuid' })
    opportunityId: string;

    @ManyToOne(() => Opportunity, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'opportunity_id' })
    opportunity: Opportunity;

    @Column({ name: 'student_user_id', type: 'uuid' })
    studentUserId: string;

    @ManyToOne(() => User, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'student_user_id' })
    studentUser: User;

    @Column({ name: 'internal_status', type: 'varchar', length: 32 })
    internalStatus: OpportunityApplicationInternalStatus;

    @Column({ name: 'primary_faculty_email', type: 'varchar', length: 320 })
    primaryFacultyEmail: string;

    @Column({ name: 'secondary_faculty_email', type: 'varchar', length: 320, nullable: true })
    secondaryFacultyEmail: string | null;

    @Column({ name: 'apply_payload', type: 'jsonb' })
    applyPayload: Record<string, unknown>;

    @Column({ name: 'faculty_decided_at', type: 'timestamp', nullable: true })
    facultyDecidedAt: Date | null;

    @Column({ name: 'faculty_decided_by', type: 'uuid', nullable: true })
    facultyDecidedBy: string | null;

    @Column({ name: 'faculty_comment', type: 'text', nullable: true })
    facultyComment: string | null;

    @Column({ name: 'admin_decided_at', type: 'timestamp', nullable: true })
    adminDecidedAt: Date | null;

    @Column({ name: 'admin_decided_by', type: 'uuid', nullable: true })
    adminDecidedBy: string | null;

    @Column({ name: 'admin_comment', type: 'text', nullable: true })
    adminComment: string | null;

    @Column({ name: 'withdrawn_at', type: 'timestamp', nullable: true })
    withdrawnAt: Date | null;

    @CreateDateColumn({ name: 'created_at' })
    createdAt: Date;

    @UpdateDateColumn({ name: 'updated_at' })
    updatedAt: Date;
}
