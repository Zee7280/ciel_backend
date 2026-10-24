import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { HUB_SCHEMA } from '../hub-connection.constants';
import { ExternalConnection } from './external-connection.entity';

/**
 * received  → persisted, not yet normalized (inline budget exhausted or deferred)
 * processed → normalized into external_records
 * deferred  → transient failure, retried by the sweeper at next_attempt_at
 * dead      → max attempts reached; admin replay only
 * rejected  → permanently invalid (validation / policy); never retried
 */
export type ExternalEventStatus =
  | 'received'
  | 'processed'
  | 'deferred'
  | 'dead'
  | 'rejected';

/** Immutable inbound history. One row per accepted vendor event; the envelope is stored verbatim. */
@Entity({ name: 'external_events', schema: HUB_SCHEMA })
@Index(['connectionId', 'sourceEventId'], { unique: true })
@Index(['status', 'nextAttemptAt'])
@Index(['connectionId', 'receivedAt'])
export class ExternalEvent {
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

  /** Vendor-supplied unique id (envelope.event_id). */
  @Column({ type: 'varchar', length: 128 })
  sourceEventId: string;

  @Index()
  @Column({ type: 'varchar', length: 64 })
  eventType: string;

  @Column({ type: 'varchar', length: 16 })
  schemaVersion: string;

  @Column({ type: 'jsonb' })
  envelope: Record<string, unknown>;

  @Column({ type: 'varchar', length: 16, default: 'received' })
  status: ExternalEventStatus;

  @Column({ type: 'int', default: 0 })
  attempts: number;

  @Column({ type: 'timestamptz', nullable: true })
  nextAttemptAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  lockedAt: Date | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  lockedBy: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  errorCode: string | null;

  @Column({ type: 'text', nullable: true })
  errorMessage: string | null;

  /** Key id used to sign the request; for audit, no FK. */
  @Column({ type: 'varchar', length: 48, nullable: true })
  credentialKeyId: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  sourceIp: string | null;

  @Column({ type: 'int', nullable: true })
  payloadBytes: number | null;

  @CreateDateColumn({ type: 'timestamptz' })
  receivedAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  processedAt: Date | null;
}
