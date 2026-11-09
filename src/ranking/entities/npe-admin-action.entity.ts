import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

export type NpeAdminActionKind =
  | 'override.save'
  | 'override.revoke'
  | 'review.clear'
  | 'run.publish'
  | 'studio.publish'
  | 'challenge.open'
  | 'challenge.resolve';

/**
 * Append-only log of administrator actions in the ranking pipeline (NPE-1.3 "Recent administrator
 * actions"). Rows are written next to the action they describe and are never updated or deleted.
 */
@Entity('npe_admin_actions')
@Index(['scope', 'createdAt'])
export class NpeAdminAction {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 120 })
  scope: string;

  @Column({ name: 'actor_user_id', type: 'uuid' })
  actorUserId: string;

  @Column({ type: 'varchar', length: 32 })
  role: 'ciel_admin' | 'university';

  @Column({ type: 'varchar', length: 48 })
  action: NpeAdminActionKind;

  @Column({ name: 'report_id', type: 'uuid', nullable: true })
  reportId: string | null;

  /** Id of the publication, run, correction or challenge the action touched. */
  @Column({ name: 'target_id', type: 'varchar', length: 120, nullable: true })
  targetId: string | null;

  /** Human-readable one-liner plus the before/after values, for the audit panel. */
  @Column({ type: 'jsonb', default: {} })
  details: Record<string, unknown>;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
