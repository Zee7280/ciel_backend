import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export const VENTURE_SIGNAL_KINDS = [
  'view',
  'save',
  'interest',
  'intro',
] as const;
export type VentureSignalKind = (typeof VENTURE_SIGNAL_KINDS)[number];

/**
 * Introduction request lifecycle (three gates before any contact is shared):
 *   pending  — investor asked (gate 1 open: CIEL PK screening)
 *   screened — CIEL PK cleared it (gate 2 open: founder decides)
 *   accepted — founder accepted (gate 3: founder contact unlocks for this investor only)
 *   declined — CIEL PK or the founder said no
 */
export const VENTURE_INTRO_STATUSES = [
  'pending',
  'screened',
  'accepted',
  'declined',
] as const;
export type VentureIntroStatus = (typeof VENTURE_INTRO_STATUSES)[number];

/**
 * What an investor did on a venture in the CIEL Investor Hub. One row per investor × venture ×
 * kind: a view row counts repeats, the other kinds are one-shot. This is the record founders,
 * faculty, universities and CIEL PK read their "investor activity" from — it never lives in the
 * investor's own settings.
 */
@Entity('venture_investor_signals')
@Index(['ventureId', 'investorUserId', 'kind'], { unique: true })
export class VentureInvestorSignal {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'uuid' })
  ventureId: string;

  @Index()
  @Column({ type: 'uuid' })
  investorUserId: string;

  @Column({ type: 'varchar', length: 16 })
  kind: VentureSignalKind;

  /** Investor's note to CIEL PK / the founder (interest, intro). */
  @Column({ type: 'text', nullable: true })
  note: string | null;

  /** Intro requests only. */
  @Column({ type: 'varchar', length: 24, nullable: true })
  status: VentureIntroStatus | null;

  /** CIEL PK screening note (intro requests). */
  @Column({ type: 'text', nullable: true })
  adminNote: string | null;

  /** Views: how many times. Other kinds: always 1. */
  @Column({ type: 'int', default: 1 })
  count: number;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
