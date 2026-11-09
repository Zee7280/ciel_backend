import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { StudentReport } from '../../reports/entities/student-report.entity';
import { FollowUpQuestion } from './follow-up-question.entity';
import { FollowUpDispatch } from './follow-up-dispatch.entity';
import { FollowUpAnswer } from './follow-up-answer.entity';

/**
 * Lifecycle of one Section 9.5 follow-up:
 *   scheduled → sent (initial mail) → reminded (reminder 1 / final) → responded | declined | expired
 *   cancelled       report sent back / unlocked / closed, or an admin cancelled it
 *   needs_attention activation found no usable recipient or date; admin fixes and re-activates
 */
export const FOLLOW_UP_STATUSES = [
  'scheduled',
  'sent',
  'reminded',
  'responded',
  'declined',
  'expired',
  'cancelled',
  'needs_attention',
] as const;
export type FollowUpStatus = (typeof FOLLOW_UP_STATUSES)[number];

/** Statuses in which the scheduler may still send mail. */
export const FOLLOW_UP_ACTIVE_STATUSES: FollowUpStatus[] = [
  'scheduled',
  'sent',
  'reminded',
];

/** What the partner email and response page show about the project (frozen at activation). */
export type FollowUpProjectReference = {
  title: string;
  projectId: string;
  reportId: string;
  host: string;
  university: string;
  location: string;
  periodStart: string;
  periodEnd: string;
  objective: string;
  beneficiaries: string;
  studentTeam: string;
};

@Entity('report_follow_ups')
export class ReportFollowUp {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index({ unique: true })
  @Column({ type: 'uuid' })
  reportId: string;

  @ManyToOne(() => StudentReport, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'reportId' })
  report: StudentReport;

  @Column({ type: 'uuid', nullable: true })
  opportunityId: string | null;

  @Column({ type: 'uuid', nullable: true })
  studentId: string | null;

  @Index()
  @Column({ type: 'varchar', length: 32, default: 'scheduled' })
  status: FollowUpStatus;

  @Column({ type: 'varchar', length: 160, default: '' })
  recipientName: string;

  @Column({ type: 'varchar', length: 255, default: '' })
  recipientEmail: string;

  @Column({ type: 'varchar', length: 120, default: '' })
  recipientRole: string;

  /** yyyy-mm-dd, Asia/Karachi calendar day on which the first email goes out. */
  @Column({ type: 'varchar', length: 10, default: '' })
  dueDate: string;

  @Column({ type: 'varchar', length: 10, default: '' })
  projectEndDate: string;

  @Column({ type: 'varchar', length: 80, default: '' })
  intervalLabel: string;

  @Column({ type: 'int', default: 7 })
  reminder1Days: number;

  @Column({ type: 'int', default: 14 })
  reminder2Days: number;

  /** sha256 of the signed link token; the token itself is never stored. */
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 64, nullable: true })
  tokenHash: string | null;

  /**
   * Each email carries a freshly issued token (so a leaked DB never yields a usable link); the
   * hashes of earlier emails' tokens stay valid here until expiry, so an older email still opens.
   */
  @Column({ type: 'jsonb', default: () => "'[]'" })
  previousTokenHashes: string[];

  @Column({ type: 'timestamptz', nullable: true })
  tokenExpiresAt: Date | null;

  @Column({ type: 'int', default: 1 })
  questionSetVersion: number;

  /** Set once an admin edited the questions; activation then never regenerates them. */
  @Column({ type: 'timestamptz', nullable: true })
  questionsEditedAt: Date | null;

  @Column({ type: 'jsonb', nullable: true })
  projectRef: FollowUpProjectReference | null;

  /** Student's own "what should be checked" + note from 9.5, kept for the admin and the email. */
  @Column({ type: 'text', default: '' })
  checkFocus: string;

  /**
   * True when CIEL PK created or re-targeted this follow-up itself (student answered "Not decided
   * yet", or the recipient had to be changed), so the recipient is not the student's 9.5 answer.
   */
  @Column({ type: 'boolean', default: false })
  decidedByAdmin: boolean;

  /**
   * Mail cycle. Re-targeting an already-mailed follow-up to a new contact starts cycle + 1, so the
   * new person receives the initial email (not a "reminder") and exactly-once keys stay unique.
   */
  @Column({ type: 'int', default: 1 })
  cycle: number;

  @Column({ type: 'timestamptz', nullable: true })
  activatedAt: Date | null;

  @Column({ type: 'varchar', length: 160, nullable: true })
  activatedBy: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  respondedAt: Date | null;

  @Column({ type: 'varchar', length: 160, default: '' })
  respondentName: string;

  @Column({ type: 'text', default: '' })
  generalComment: string;

  @Column({ type: 'timestamptz', nullable: true })
  declinedAt: Date | null;

  @Column({ type: 'text', default: '' })
  declineReason: string;

  /** Admin reviewed the partner's answers; from then on the student sees them too. */
  @Column({ type: 'timestamptz', nullable: true })
  reviewedAt: Date | null;

  @Column({ type: 'varchar', length: 160, nullable: true })
  reviewedBy: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  cancelledAt: Date | null;

  @Column({ type: 'text', default: '' })
  cancelReason: string;

  @Column({ type: 'text', default: '' })
  lastError: string;

  @OneToMany(() => FollowUpQuestion, (q) => q.followUp)
  questions: FollowUpQuestion[];

  @OneToMany(() => FollowUpDispatch, (d) => d.followUp)
  dispatches: FollowUpDispatch[];

  @OneToMany(() => FollowUpAnswer, (a) => a.followUp)
  answers: FollowUpAnswer[];

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
