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

  /** Optional phone number the lead gave for this teammate. */
  @Column({ type: 'varchar', length: 30, nullable: true })
  contact: string | null;

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

  /**
   * Public certificate ID (CIEL-QCI-YYYY-XXXX-XXXX), issued once when CIEL PK gives final approval
   * and this student is credited with time; null until then. Nullable ADD COLUMN only.
   */
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 32, nullable: true })
  certificateCode: string | null;
}
