import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Safety copy written by Teams & enrollments right before a destructive admin action
 * (delete team / delete member / merge). `payload` holds the rows that action removed or changed,
 * so the action can be undone from the roster instead of being permanent.
 */
@Entity('admin_team_snapshots')
export class AdminTeamSnapshot {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ name: 'opportunity_id', type: 'uuid' })
  opportunityId: string;

  @Column({ type: 'varchar', length: 32 })
  kind: 'delete_team' | 'delete_member' | 'merge';

  /** Human label shown in the Undo list, e.g. "Team TM-2026-… (3 members)". */
  @Column({ type: 'varchar', length: 300 })
  label: string;

  @Column({ name: 'actor_id', type: 'varchar', length: 64, nullable: true })
  actorId: string | null;

  @Column({ name: 'actor_email', type: 'varchar', length: 255, nullable: true })
  actorEmail: string | null;

  /** Counts for display: { participations, reports, payments, applications }. */
  @Column('simple-json')
  summary: Record<string, number>;

  @Column('simple-json')
  payload: Record<string, unknown>;

  @Column({ name: 'restored_at', type: 'timestamp', nullable: true })
  restoredAt: Date | null;

  @Column({ name: 'restored_by', type: 'varchar', length: 255, nullable: true })
  restoredBy: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
