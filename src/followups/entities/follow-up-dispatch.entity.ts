import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { ReportFollowUp } from './report-follow-up.entity';

export const FOLLOW_UP_DISPATCH_KINDS = [
  'initial',
  'reminder1',
  'reminder2',
  'manual',
] as const;
export type FollowUpDispatchKind = (typeof FOLLOW_UP_DISPATCH_KINDS)[number];

export type FollowUpDispatchStatus = 'pending' | 'sent' | 'failed' | 'skipped';

export const FOLLOW_UP_DELIVERY_STATUSES = [
  'unknown',
  'delivered',
  'deferred',
  'bounced',
  'complained',
] as const;
export type FollowUpDeliveryStatus =
  (typeof FOLLOW_UP_DELIVERY_STATUSES)[number];

/**
 * One row per email the scheduler decided to send. `idempotencyKey` is unique, so the same
 * follow-up + kind can never be mailed twice even if two workers overlap (spec: exactly-once).
 */
@Entity('report_follow_up_dispatches')
export class FollowUpDispatch {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'uuid' })
  followUpId: string;

  @ManyToOne(() => ReportFollowUp, (f) => f.dispatches, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'followUpId' })
  followUp: ReportFollowUp;

  @Column({ type: 'varchar', length: 16 })
  kind: FollowUpDispatchKind;

  /** Which recipient cycle of the follow-up this email belonged to (see ReportFollowUp.cycle). */
  @Column({ type: 'int', default: 1 })
  cycle: number;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 120 })
  idempotencyKey: string;

  /** yyyy-mm-dd the scheduler intended this for (Asia/Karachi). */
  @Column({ type: 'varchar', length: 10, default: '' })
  scheduledFor: string;

  @Column({ type: 'varchar', length: 16, default: 'pending' })
  status: FollowUpDispatchStatus;

  @Column({ type: 'int', default: 0 })
  attempts: number;

  /** When a worker took this send; a stale claim (crashed worker) may be retried after 15 minutes. */
  @Column({ type: 'timestamptz', nullable: true })
  claimedAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  sentAt: Date | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  providerMessageId: string | null;

  @Column({ type: 'varchar', length: 255, default: '' })
  recipientEmail: string;

  @Column({ type: 'text', default: '' })
  error: string;

  /**
   * What the mail provider reported after we handed the message over (via the provider webhook):
   * unknown (SMTP gives no feedback) | delivered | deferred | bounced | complained.
   */
  @Column({ type: 'varchar', length: 16, default: 'unknown' })
  deliveryStatus: FollowUpDeliveryStatus;

  @Column({ type: 'text', default: '' })
  deliveryDetail: string;

  @Column({ type: 'timestamptz', nullable: true })
  deliveryUpdatedAt: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
