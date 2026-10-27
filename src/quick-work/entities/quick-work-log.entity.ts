import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import type { QuickWorkPartner, QuickWorkStatus } from '../quick-work.util';
import { QuickWorkParticipant } from './quick-work-participant.entity';

export type QuickWorkEvidence = {
  url: string;
  name: string;
  type: string;
  size: number;
  caption: string;
};

export type QuickWorkHistoryEntry = {
  action: string;
  at: string;
  byUserId: string;
  note?: string;
};

/** One Quick Community Work activity log: lead-owned, reviewed once by the named faculty member. */
@Entity('quick_work_logs')
export class QuickWorkLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'uuid' })
  leadUserId: string;

  /** draft | submitted | admin_review | changes | approved | rejected (fits varchar(16)) */
  @Index()
  @Column({ type: 'varchar', length: 16, default: 'draft' })
  status: QuickWorkStatus;

  /** solo | team */
  @Column({ type: 'varchar', length: 8, default: 'solo' })
  mode: string;

  @Column({ type: 'varchar', length: 120, default: '' })
  university: string;

  @Column({ type: 'varchar', length: 120, default: '' })
  department: string;

  @Column({ type: 'varchar', length: 100, default: '' })
  facultyName: string;

  /** Lower-cased; the signed-in faculty user with this email is the only reviewer. */
  @Index()
  @Column({ type: 'varchar', length: 120, default: '' })
  facultyEmail: string;

  /**
   * No longer used (faculty now only review after submit). Kept, with the two dates below, so that
   * TypeORM synchronize does not drop the columns and the values stored meanwhile.
   */
  @Column({ type: 'varchar', length: 10, nullable: true })
  facultyConfirmation: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  facultyRequestedAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  facultyRespondedAt: Date | null;

  @Column({ type: 'varchar', length: 120, default: '' })
  title: string;

  @Column({ type: 'varchar', length: 60, default: '' })
  activityType: string;

  /** The student's own description when activityType is “Other service activity”. */
  @Column({ type: 'varchar', length: 60, nullable: true })
  activityTypeOther: string | null;

  /** YYYY-MM-DD, Pakistan time. Stored as text so no timezone shift can move the day. */
  @Column({ type: 'varchar', length: 10, nullable: true })
  activityDate: string | null;

  /** HH:MM, Pakistan time. */
  @Column({ type: 'varchar', length: 5, nullable: true })
  startTime: string | null;

  @Column({ type: 'varchar', length: 5, nullable: true })
  endTime: string | null;

  @Column({ type: 'varchar', length: 180, default: '' })
  location: string;

  /** Optional Google Maps pin for the venue (`lat,lng`). */
  @Column({ type: 'varchar', length: 64, nullable: true })
  locationPin: string | null;

  @Column({ type: 'varchar', length: 120, nullable: true })
  host: string | null;

  /** Optional email and phone (+92...) of the host organisation. */
  @Column({ type: 'varchar', length: 120, nullable: true })
  hostEmail: string | null;

  @Column({ type: 'varchar', length: 30, nullable: true })
  hostContact: string | null;

  /**
   * Optional partner organisations: { name, email, contact } objects. Rows saved before contacts
   * existed hold plain names; read them through partnerList().
   */
  @Column({ type: 'jsonb', default: () => "'[]'" })
  partners: (QuickWorkPartner | string)[];

  @Column({ type: 'smallint', nullable: true })
  sdg: number | null;

  /** Length 1000: widened in place by src/database/widen-columns-before-sync.ts, never by synchronize. */
  @Column({ type: 'varchar', length: 1000, default: '' })
  summary: string;

  @Column({ type: 'int', nullable: true })
  peopleReached: number | null;

  @Column({
    type: 'varchar',
    length: 40,
    default: 'Faculty, University & CIEL PK only',
  })
  visibility: string;

  @Column({ type: 'jsonb', default: () => "'[]'" })
  evidence: QuickWorkEvidence[];

  @Column({ default: false })
  consent: boolean;

  @Column({ default: false })
  honest: boolean;

  @Column({ type: 'varchar', length: 300, nullable: true })
  reviewNote: string | null;

  @Column({ type: 'uuid', nullable: true })
  reviewedByUserId: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  reviewedAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  submittedAt: Date | null;

  @Column({ type: 'jsonb', default: () => "'[]'" })
  history: QuickWorkHistoryEntry[];

  @OneToMany(() => QuickWorkParticipant, (p) => p.log, { cascade: false })
  participants: QuickWorkParticipant[];

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
