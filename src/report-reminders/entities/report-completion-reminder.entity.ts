import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * One row per "Complete your report ASAP" message a student was sent for an opportunity. The
 * unique (opportunity, email, kind) key makes every automatic cadence step and every manual
 * "remind now" (one per person per day) exactly-once, even when two job runs overlap.
 */
@Entity('report_completion_reminders')
@Index(['opportunityId', 'email', 'kind'], { unique: true })
export class ReportCompletionReminder {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'uuid' })
  opportunityId: string;

  @Index()
  @Column({ type: 'varchar', length: 64, nullable: true })
  studentUserId: string | null;

  @Column({ type: 'varchar', length: 255 })
  email: string;

  /** `after_end_d0`, `after_end_d1`, … (every 3 days), `not_started_14d`, `manual_YYYY-MM-DD`. */
  @Column({ type: 'varchar', length: 48 })
  kind: string;

  @Column({ type: 'varchar', length: 16, default: 'auto' })
  channel: 'auto' | 'manual';

  /** Who pressed "Remind now" (role + email), null for the nightly job. */
  @Column({ type: 'varchar', length: 255, nullable: true })
  triggeredBy: string | null;

  @Column({ default: false })
  emailSent: boolean;

  @Column({ default: false })
  notified: boolean;

  @Column({ type: 'text', nullable: true })
  error: string | null;

  @CreateDateColumn()
  createdAt: Date;
}
