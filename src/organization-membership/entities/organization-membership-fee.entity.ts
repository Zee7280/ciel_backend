import {
    Entity,
    Column,
    PrimaryGeneratedColumn,
    CreateDateColumn,
    ManyToOne,
    JoinColumn,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';

export type OrganizationMembershipFeeStatus = 'pending_review' | 'approved' | 'rejected';

@Entity('organization_membership_fees')
export class OrganizationMembershipFee {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @ManyToOne(() => User, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'user_id' })
    user: User;

    @Column({ name: 'user_id', type: 'uuid' })
    userId: string;

    /** Optional denormalized org id at submission time (no FK — keeps entity simple). */
    @Column({ name: 'organization_id', type: 'uuid', nullable: true })
    organizationId: string | null;

    @Column({ type: 'int', name: 'paid_amount_pkr' })
    paidAmountPkr: number;

    @Column({ type: 'text', name: 'proof_url' })
    proofUrl: string;

    @Column({ type: 'varchar', length: 32, default: 'pending_review' })
    status: OrganizationMembershipFeeStatus;

    @Column({ type: 'text', nullable: true })
    adminFeedback: string | null;

    @Column({ name: 'reviewed_by_user_id', type: 'uuid', nullable: true })
    reviewedByUserId: string | null;

    @Column({ type: 'timestamptz', nullable: true })
    reviewedAt: Date | null;

    @CreateDateColumn()
    createdAt: Date;
}
