import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';
import { QuickWorkLog } from './quick-work-log.entity';

/**
 * A teammate the lead named whose email has no CIEL student account yet. They get an email to sign
 * up; once a student account with that email exists, the invite becomes a normal participant row
 * ("invited") that they approve or reject. Never credited, never counted as joined, never part of a
 * submitted log; it only blocks submit until the person signs up and answers (or the lead removes them).
 */
@Entity('quick_work_pending_invites')
@Unique('UQ_quick_work_pending_invite_log_email', ['logId', 'email'])
export class QuickWorkPendingInvite {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => QuickWorkLog, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'logId' })
  log: QuickWorkLog;

  @Index()
  @Column({ type: 'uuid' })
  logId: string;

  /** Lowercase, trimmed. */
  @Index()
  @Column({ type: 'varchar', length: 120 })
  email: string;

  @Column({ type: 'varchar', length: 100, default: '' })
  name: string;

  @Column({ type: 'varchar', length: 60, default: '' })
  studentId: string;

  @Column({ type: 'varchar', length: 30, nullable: true })
  contact: string | null;

  @CreateDateColumn()
  createdAt: Date;
}
