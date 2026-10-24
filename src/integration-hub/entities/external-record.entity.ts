import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { HUB_SCHEMA } from '../hub-connection.constants';
import { ExternalConnection } from './external-connection.entity';

/** current → latest version; superseded → replaced by a correction; voided → withdrawn. */
export type ExternalRecordStatus = 'current' | 'superseded' | 'voided';

/** Internal review state inside the repository. Has no effect on any core table. */
export type ExternalRecordReviewState =
  | 'unreviewed'
  | 'reviewed'
  | 'disputed'
  | 'clarification_requested';

export type ExternalMetricValue = {
  code: string;
  value: number;
  unit?: string;
  classification?: string;
  method?: string;
};

export type ExternalAttestation = {
  lawful_basis?: string;
  consent_ref?: string;
  obtained_at?: string;
  contains_personal_data?: boolean;
};

/** Normalized current view of one external activity record, versioned by corrections. */
@Entity({ name: 'external_records', schema: HUB_SCHEMA })
@Index(['connectionId', 'externalActivityId', 'version'], { unique: true })
@Index(['connectionId', 'activityType', 'occurredOn'])
@Index(['connectionId', 'status'])
export class ExternalRecord {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => ExternalConnection, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'connection_id' })
  connection: ExternalConnection;

  @Column({ name: 'connection_id', type: 'uuid' })
  connectionId: string;

  @Index()
  @Column({ name: 'platform_id', type: 'uuid' })
  platformId: string;

  /** Vendor's own activity identifier (envelope.activity.external_id). */
  @Column({ type: 'varchar', length: 128 })
  externalActivityId: string;

  @Column({ type: 'varchar', length: 64 })
  activityType: string;

  @Column({ type: 'varchar', length: 200, nullable: true })
  title: string | null;

  @Column({ type: 'date', nullable: true })
  occurredOn: string | null;

  /** Validated activity-specific payload. Unknown fields are kept but never summarized. */
  @Column({ type: 'jsonb', default: {} })
  payload: Record<string, unknown>;

  /** Metric values validated against external_metric_catalog. */
  @Column({ type: 'jsonb', default: [] })
  metrics: ExternalMetricValue[];

  @Column({ type: 'jsonb', nullable: true })
  attestation: ExternalAttestation | null;

  @Column({ type: 'int', default: 1 })
  version: number;

  @Column({ type: 'varchar', length: 16, default: 'current' })
  status: ExternalRecordStatus;

  @Column({ type: 'uuid', nullable: true })
  supersededById: string | null;

  /** Event that produced this version. */
  @Column({ type: 'uuid' })
  sourceEventId: string;

  @Column({ type: 'varchar', length: 32, default: 'unreviewed' })
  reviewState: ExternalRecordReviewState;

  @Column({ type: 'text', nullable: true })
  reviewNote: string | null;

  @Column({ type: 'uuid', nullable: true })
  reviewedByUserId: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  reviewedAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  voidedAt: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
