import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('npe_ranking_runs')
export class NpeRankingRun {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'rubric_version', type: 'varchar', length: 32 })
  rubricVersion: string;

  /** `national` for CIEL PK Admin, or university organization id. */
  @Column({ type: 'varchar', length: 120 })
  scope: string;

  @Column({ type: 'varchar', length: 32 })
  role: 'ciel_admin' | 'university';

  @Column({ type: 'varchar', length: 24, default: 'draft' })
  status: 'draft' | 'published' | 'failed';

  @Column({ name: 'created_by_user_id', type: 'uuid', nullable: true })
  createdByUserId: string | null;

  @Column({ name: 'package_versions', type: 'jsonb', default: {} })
  packageVersions: Record<string, string>;

  /** Keyed by review item id (`${reportId}:${type}`). */
  @Column({ name: 'review_clearances', type: 'jsonb', default: {} })
  reviewClearances: Record<string, boolean>;

  @Column({ type: 'jsonb', nullable: true })
  meta: Record<string, unknown> | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
