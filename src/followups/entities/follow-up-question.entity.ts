import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { ReportFollowUp } from './report-follow-up.entity';

export type FollowUpQuestionOrigin = 'rules' | 'ai' | 'admin';

/** One verifiable question per distinct activity / durable benefit (spec §2). */
@Entity('report_follow_up_questions')
export class FollowUpQuestion {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'uuid' })
  followUpId: string;

  @ManyToOne(() => ReportFollowUp, (f) => f.questions, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'followUpId' })
  followUp: ReportFollowUp;

  /** Section 4 activity block id (or null for the overall / student-focus question). */
  @Column({ type: 'varchar', length: 120, nullable: true })
  activityId: string | null;

  @Column({ type: 'varchar', length: 240, default: '' })
  activityTitle: string;

  @Column({ type: 'text' })
  questionText: string;

  /** Optional measurable count the partner may add ("Trees still surviving"). */
  @Column({ type: 'varchar', length: 160, nullable: true })
  countLabel: string | null;

  /** Report fields the question was derived from, for the admin's review. */
  @Column({ type: 'jsonb', default: () => "'[]'" })
  sourceFieldIds: string[];

  @Column({ type: 'text', default: '' })
  reason: string;

  @Column({ type: 'boolean', default: true })
  include: boolean;

  @Column({ type: 'int', default: 0 })
  displayOrder: number;

  @Column({ type: 'varchar', length: 16, default: 'rules' })
  generatedBy: FollowUpQuestionOrigin;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
