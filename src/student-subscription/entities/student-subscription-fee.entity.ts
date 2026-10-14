import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';

export type StudentSubscriptionFeeStatus = 'pending_review' | 'approved' | 'rejected';

/** One bank-transfer proof submitted by a student for the subscription fee. */
@Entity('student_subscription_fees')
export class StudentSubscriptionFee {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  /** University the student declared at signup, captured at submission time for the admin queue. */
  @Column({ name: 'university_name', type: 'varchar', length: 255, nullable: true })
  universityName: string | null;

  @Column({ type: 'int', name: 'paid_amount_pkr' })
  paidAmountPkr: number;

  /** Fee that was configured when the student submitted — kept so a later fee change does not re-flag old rows. */
  @Column({ type: 'int', name: 'expected_amount_pkr', nullable: true })
  expectedAmountPkr: number | null;

  @Column({ type: 'text', name: 'proof_url' })
  proofUrl: string;

  @Column({ type: 'varchar', length: 32, default: 'pending_review' })
  status: StudentSubscriptionFeeStatus;

  @Column({ type: 'text', nullable: true })
  adminFeedback: string | null;

  @Column({ name: 'reviewed_by_user_id', type: 'uuid', nullable: true })
  reviewedByUserId: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  reviewedAt: Date | null;

  @CreateDateColumn()
  createdAt: Date;
}
