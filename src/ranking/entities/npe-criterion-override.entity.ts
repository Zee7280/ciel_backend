import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * Admin criterion correction (NPE-1.3 governance). The AI judgment stays immutable; an authorized
 * administrator may record a different anchor for one criterion of one project, with the evidence
 * locator and reason that justify it. Corrections are scoped (national vs. one university cohort),
 * bound to the package version they were made for (a re-approved report invalidates them), and
 * are never deleted: superseding or revoking a correction deactivates it and keeps the record.
 */
@Entity('npe_criterion_overrides')
@Index(['scope', 'reportId'])
@Index(['scope', 'active'])
export class NpeCriterionOverride {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** `national` | `university:<orgId>` — the ranking cohort the correction applies to. */
  @Column({ type: 'varchar', length: 120 })
  scope: string;

  @Column({ name: 'report_id', type: 'uuid' })
  reportId: string;

  /** Package version the correction was made against; stale once the report changes. */
  @Column({ name: 'package_version', type: 'varchar', length: 80 })
  packageVersion: string;

  @Column({ type: 'varchar', length: 32 })
  criterion: string;

  /** Corrected anchor 0–5. */
  @Column({ type: 'int' })
  anchor: number;

  /** AI anchor at the time of the correction (for the before/after audit line). */
  @Column({ name: 'original_anchor', type: 'float', nullable: true })
  originalAnchor: number | null;

  @Column({
    name: 'original_confidence',
    type: 'varchar',
    length: 16,
    nullable: true,
  })
  originalConfidence: string | null;

  /** Exact evidence file id / page / claim the correction rests on. */
  @Column({ type: 'varchar', length: 300 })
  locator: string;

  @Column({ type: 'text' })
  reason: string;

  @Column({ name: 'created_by_user_id', type: 'uuid' })
  createdByUserId: string;

  @Column({ type: 'varchar', length: 32 })
  role: 'ciel_admin' | 'university';

  @Column({ type: 'boolean', default: true })
  active: boolean;

  @Column({ name: 'revoked_by_user_id', type: 'uuid', nullable: true })
  revokedByUserId: string | null;

  @Column({ name: 'revoked_at', type: 'timestamptz', nullable: true })
  revokedAt: Date | null;

  @Column({ name: 'revoke_reason', type: 'text', nullable: true })
  revokeReason: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
