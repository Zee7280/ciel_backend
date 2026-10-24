import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { HUB_SCHEMA } from '../hub-connection.constants';

export type ExternalPlatformStatus =
  | 'sandbox'
  | 'live'
  | 'suspended'
  | 'retired';

export type ExternalIntegrationMode = 'push' | 'pull' | 'file';

/** Per-platform operational settings; all optional, defaults applied in code. */
export type ExternalPlatformSettings = {
  /** Requests per minute across all connections of the platform. */
  rate_limit_per_minute?: number;
  /** Max events accepted in one POST /events call. */
  max_batch_size?: number;
  /** Max request body in bytes for POST /events. */
  max_payload_bytes?: number;
  /** Max evidence object size in bytes. */
  max_evidence_bytes?: number;
  /** Allowed evidence MIME types. */
  evidence_mime_allowlist?: string[];
  /** Default retention for accepted records and evidence (days). */
  retention_days?: number;
  /** Retention for processing logs / rejected events (days). */
  log_retention_days?: number;
  /** Alert when failure ratio over the last hour exceeds this (0–1). */
  failure_rate_alert_threshold?: number;
};

@Entity({ name: 'external_platforms', schema: HUB_SCHEMA })
export class ExternalPlatform {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 64 })
  slug: string;

  @Column({ type: 'varchar', length: 160 })
  name: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Index()
  @Column({ type: 'varchar', length: 16, default: 'sandbox' })
  status: ExternalPlatformStatus;

  @Column({ type: 'varchar', length: 8, default: 'push' })
  integrationMode: ExternalIntegrationMode;

  /** Event types this platform may send (e.g. activity.session). Empty ⇒ none accepted. */
  @Column({ type: 'text', array: true, default: '{}' })
  approvedEventTypes: string[];

  @Column({ type: 'jsonb', default: {} })
  settings: ExternalPlatformSettings;

  /** Accountable organization and technical contact, as free text / small object. */
  @Column({ type: 'jsonb', nullable: true })
  technicalContact: Record<string, unknown> | null;

  @Column({ type: 'varchar', length: 160, nullable: true })
  agreementReference: string | null;

  /** Core user id (uuid) of the Super Admin who registered / last changed status. No FK. */
  @Column({ type: 'uuid', nullable: true })
  createdByUserId: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  liveAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  suspendedAt: Date | null;

  @Column({ type: 'text', nullable: true })
  suspensionReason: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
