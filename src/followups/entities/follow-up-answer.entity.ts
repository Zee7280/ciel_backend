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
import { FollowUpQuestion } from './follow-up-question.entity';

export const FOLLOW_UP_CHOICES = [
  'yes',
  'partially',
  'no',
  'unable_to_verify',
] as const;
export type FollowUpChoice = (typeof FOLLOW_UP_CHOICES)[number];

/** The partner's answer to one question. Always partner-reported, never independently verified. */
@Entity('report_follow_up_answers')
export class FollowUpAnswer {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'uuid' })
  followUpId: string;

  @ManyToOne(() => ReportFollowUp, (f) => f.answers, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'followUpId' })
  followUp: ReportFollowUp;

  @Index()
  @Column({ type: 'uuid' })
  questionId: string;

  @ManyToOne(() => FollowUpQuestion, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'questionId' })
  question: FollowUpQuestion;

  @Column({ type: 'varchar', length: 24 })
  choice: FollowUpChoice;

  @Column({ type: 'numeric', nullable: true })
  numericValue: string | null;

  @Column({ type: 'text', default: '' })
  note: string;

  @Column({ type: 'varchar', length: 32, default: 'partner_reported' })
  verificationMethod: string;

  @CreateDateColumn({ type: 'timestamptz' })
  submittedAt: Date;
}
