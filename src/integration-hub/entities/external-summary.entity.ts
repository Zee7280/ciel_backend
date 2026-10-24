import {
  Column,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { HUB_SCHEMA } from '../hub-connection.constants';

/**
 * Incrementally maintained totals for external-record dashboards. One row per
 * (connection, scope, period). Corrections and voids touch only the rows they affect; nothing
 * here is ever recalculated from the full history on each event.
 *
 * scope_key: 'connection' | 'activity:<externalActivityId>' | 'type:<activityType>'
 * period:    'all' | 'YYYY-MM'
 */
@Entity({ name: 'external_summaries', schema: HUB_SCHEMA })
@Index(['connectionId', 'scopeKey', 'period'], { unique: true })
export class ExternalSummary {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'connection_id', type: 'uuid' })
  connectionId: string;

  @Column({ type: 'varchar', length: 160 })
  scopeKey: string;

  @Column({ type: 'varchar', length: 8 })
  period: string;

  @Column({ type: 'int', default: 0 })
  recordCount: number;

  /** metric code → aggregated value (per catalog aggregation rule). */
  @Column({ type: 'jsonb', default: {} })
  metricTotals: Record<string, number>;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
