import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';
import { QuickWorkLog } from './quick-work-log.entity';

/** A CIEL student on a quick-work log: the lead, or a teammate who must confirm joining. */
@Entity('quick_work_participants')
@Unique('UQ_quick_work_participant_log_user', ['logId', 'userId'])
export class QuickWorkParticipant {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => QuickWorkLog, (log) => log.participants, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'logId' })
  log: QuickWorkLog;

  @Index()
  @Column({ type: 'uuid' })
  logId: string;

  @Index()
  @Column({ type: 'uuid' })
  userId: string;

  @Column({ default: false })
  isLead: boolean;

  @Column({ type: 'varchar', length: 100, default: '' })
  name: string;

  @Column({ type: 'varchar', length: 120, default: '' })
  email: string;

  @Column({ type: 'varchar', length: 60, default: '' })
  studentId: string;

  /** joined | invited | declined — the lead is always joined. */
  @Column({ type: 'varchar', length: 12, default: 'invited' })
  joinStatus: string;

  @Column({ default: true })
  present: boolean;

  @Column({ type: 'varchar', length: 5, nullable: true })
  startTime: string | null;

  @Column({ type: 'varchar', length: 5, nullable: true })
  endTime: string | null;

  @Column({ type: 'int', default: 0 })
  breakMinutes: number;

  /** Recorded minutes, set on save; credited only once the log is approved. */
  @Column({ type: 'int', default: 0 })
  minutes: number;
}
