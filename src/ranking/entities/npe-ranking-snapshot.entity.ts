import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { NpeRankingRun } from './npe-ranking-run.entity';

export type NpeSnapshotStanding = {
  reportId: string;
  title: string;
  university: string;
  excellenceScore: number;
  rank: number;
  cii: number | null;
};

@Entity('npe_ranking_snapshots')
@Index(['runId', 'scope'], { unique: true })
export class NpeRankingSnapshot {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'run_id', type: 'uuid' })
  runId: string;

  @ManyToOne(() => NpeRankingRun, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'run_id' })
  run: NpeRankingRun;

  @Column({ type: 'varchar', length: 120 })
  scope: string;

  @Column({ name: 'rubric_version', type: 'varchar', length: 32 })
  rubricVersion: string;

  @Column({ type: 'jsonb', default: [] })
  standings: NpeSnapshotStanding[];

  @Column({ name: 'published_by_user_id', type: 'uuid' })
  publishedByUserId: string;

  @CreateDateColumn({ name: 'published_at' })
  publishedAt: Date;
}
