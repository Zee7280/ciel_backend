import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

export type NpeChallengeStatus = 'open' | 'upheld' | 'dismissed';

/**
 * Evidence-based challenge against one project's position in a published ranking (NPE-1.3
 * "National governance & challenge process"). Raised by the owner of a scope (or, for national
 * rankings, by the university whose project it is) and resolved only by the owner of the
 * publication's scope. Resolving never edits the published ranking: an upheld challenge is
 * acted on through a criterion correction and a new publication revision.
 */
@Entity('npe_ranking_challenges')
@Index(['scope', 'status'])
@Index(['raisedByScope', 'createdAt'])
export class NpeRankingChallenge {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Scope of the publication being challenged (owner resolves). */
  @Column({ type: 'varchar', length: 120 })
  scope: string;

  @Column({ name: 'publication_id', type: 'uuid' })
  publicationId: string;

  @Column({ name: 'report_id', type: 'uuid' })
  reportId: string;

  @Column({ name: 'raised_by_user_id', type: 'uuid' })
  raisedByUserId: string;

  @Column({ name: 'raised_by_role', type: 'varchar', length: 32 })
  raisedByRole: 'ciel_admin' | 'university';

  /** Scope of the actor who raised it (so a university sees its own challenges on national rankings). */
  @Column({ name: 'raised_by_scope', type: 'varchar', length: 120 })
  raisedByScope: string;

  @Column({ type: 'varchar', length: 300 })
  locator: string;

  @Column({ type: 'text' })
  reason: string;

  @Column({ type: 'varchar', length: 16, default: 'open' })
  status: NpeChallengeStatus;

  @Column({ type: 'text', nullable: true })
  resolution: string | null;

  @Column({ name: 'resolved_by_user_id', type: 'uuid', nullable: true })
  resolvedByUserId: string | null;

  @Column({ name: 'resolved_at', type: 'timestamptz', nullable: true })
  resolvedAt: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
