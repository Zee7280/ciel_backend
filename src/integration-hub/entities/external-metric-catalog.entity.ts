import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { HUB_SCHEMA } from '../hub-connection.constants';

export type ExternalMetricAggregation =
  | 'sum'
  | 'average'
  | 'unique_count'
  | 'latest'
  | 'non_additive';

export type ExternalMetricClassification =
  | 'observed'
  | 'self_reported'
  | 'estimated'
  | 'projected'
  | 'externally_verified';

/**
 * Admin-configurable metric definitions for external records. Values are validated against this
 * catalog at processing time. Nothing here feeds CII, rankings or reports.
 */
@Entity({ name: 'external_metric_catalog', schema: HUB_SCHEMA })
export class ExternalMetricCatalog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 64 })
  code: string;

  @Column({ type: 'varchar', length: 160 })
  name: string;

  @Column({ type: 'varchar', length: 32 })
  unit: string;

  @Column({ type: 'varchar', length: 16, default: 'number' })
  dataType: 'number' | 'integer';

  @Column({ type: 'varchar', length: 16, default: 'sum' })
  aggregation: ExternalMetricAggregation;

  @Column({ type: 'varchar', length: 24, default: 'observed' })
  defaultClassification: ExternalMetricClassification;

  @Column({ type: 'numeric', nullable: true })
  minValue: string | null;

  @Column({ type: 'numeric', nullable: true })
  maxValue: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  sector: string | null;

  @Column({ type: 'int', array: true, default: '{}' })
  sdgs: number[];

  @Column({ type: 'text', nullable: true })
  methodologyNotes: string | null;

  /** platform slug → vendor field name that maps onto this metric. */
  @Column({ type: 'jsonb', default: {} })
  platformFieldMappings: Record<string, string>;

  @Column({ type: 'boolean', default: true })
  active: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
