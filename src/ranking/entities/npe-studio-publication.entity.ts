import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';
import type { StudioRow } from '../npe-studio.util';

/**
 * One published Ranking Studio ranking: the audience (filters), the angle (lens), the comparison
 * (group-by) and the frozen standings. Immutable once written; re-publishing the same ranking
 * creates the next revision, so history, movement and the exact basis of every position survive.
 */
@Entity('npe_studio_publications')
@Index(['scope', 'signature', 'revision'], { unique: true })
export class NpeStudioPublication {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** `national` for CIEL PK Admin, or `university:<organizationId>`. */
  @Column({ type: 'varchar', length: 120 })
  scope: string;

  @Column({ type: 'varchar', length: 32 })
  role: 'ciel_admin' | 'university';

  @Column({ name: 'run_id', type: 'uuid', nullable: true })
  runId: string | null;

  @Column({ name: 'rubric_version', type: 'varchar', length: 32 })
  rubricVersion: string;

  /** Name shown on the Impact Wall flashcard. */
  @Column({ type: 'varchar', length: 200 })
  name: string;

  @Column({ type: 'varchar', length: 32 })
  lens: string;

  @Column({ name: 'group_by', type: 'varchar', length: 32 })
  groupBy: string;

  @Column({ type: 'jsonb', default: {} })
  filters: Record<string, unknown>;

  @Column({ type: 'jsonb', nullable: true })
  weights: Record<string, number> | null;

  /** Identity of "the same ranking" (lens + group + filters + weights + method). */
  @Index()
  @Column({ type: 'varchar', length: 64 })
  signature: string;

  @Column({ type: 'int', default: 1 })
  revision: number;

  @Column({ name: 'previous_id', type: 'uuid', nullable: true })
  previousId: string | null;

  /** False when the eligible cohort differs from the previous revision (movement not comparable). */
  @Column({ name: 'cohort_comparable', type: 'boolean', default: false })
  cohortComparable: boolean;

  @Column({ name: 'eligible_report_ids', type: 'jsonb', default: [] })
  eligibleReportIds: string[];

  @Column({ name: 'held_report_ids', type: 'jsonb', default: [] })
  heldReportIds: string[];

  @Column({ type: 'jsonb', default: [] })
  rows: StudioRow[];

  @Column({ name: 'published_by_user_id', type: 'uuid' })
  publishedByUserId: string;

  @CreateDateColumn({ name: 'published_at' })
  publishedAt: Date;
}
