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

@Entity('npe_ranking_evaluations')
@Index(['runId', 'reportId'], { unique: true })
export class NpeRankingEvaluation {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'run_id', type: 'uuid' })
  runId: string;

  @ManyToOne(() => NpeRankingRun, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'run_id' })
  run: NpeRankingRun;

  @Column({ name: 'report_id', type: 'uuid' })
  reportId: string;

  @Column({ name: 'package_version', type: 'varchar', length: 80 })
  packageVersion: string;

  @Column({ name: 'read_complete', type: 'boolean', default: false })
  readComplete: boolean;

  @Column({ type: 'jsonb', default: [] })
  flags: string[];

  @Column({ type: 'jsonb', default: {} })
  criteria: Record<string, unknown>;

  @Column({ type: 'jsonb', default: [] })
  claims: unknown[];

  @Column({ type: 'text', default: '' })
  summary: string;

  @Column({ type: 'text', default: '' })
  limitations: string;

  @Column({ name: 'excellence_score', type: 'float', nullable: true })
  excellenceScore: number | null;

  @Column({ name: 'score_breakdown', type: 'jsonb', nullable: true })
  scoreBreakdown: Record<string, unknown> | null;

  @Column({ type: 'jsonb', nullable: true })
  audit: Record<string, unknown> | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
