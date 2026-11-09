import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

export type FollowUpOptOutSource =
  | 'partner_opt_out'
  | 'webhook_bounce'
  | 'webhook_complaint'
  | 'admin';

/**
 * Addresses CIEL PK must not mail follow-ups to any more: the person asked to stop, the provider
 * reported a hard bounce or a spam complaint, or an admin added them. Checked before every send.
 */
@Entity('report_follow_up_opt_outs')
export class FollowUpOptOut {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 255 })
  email: string;

  @Column({ type: 'varchar', length: 32 })
  source: FollowUpOptOutSource;

  @Column({ type: 'text', default: '' })
  reason: string;

  @Column({ type: 'uuid', nullable: true })
  followUpId: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
