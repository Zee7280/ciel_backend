import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { HUB_SCHEMA } from '../hub-connection.constants';

/**
 * quarantined → ticket issued / object uploaded, not yet validated
 * accepted    → validated (size, type, hash) and moved out of quarantine
 * rejected    → failed validation; object deleted
 * purged      → removed by retention; metadata row kept for audit
 */
export type ExternalEvidenceState =
  | 'quarantined'
  | 'accepted'
  | 'rejected'
  | 'purged';

/** restricted → Super Admin only; org_visible → metadata visible to the connection's organization. */
export type ExternalEvidenceVisibility = 'restricted' | 'org_visible';

/** Metadata only. Bytes live in the dedicated private evidence bucket, never on the app server. */
@Entity({ name: 'external_evidence', schema: HUB_SCHEMA })
@Index(['connectionId', 'state'])
@Index(['recordId'])
export class ExternalEvidence {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'connection_id', type: 'uuid' })
  connectionId: string;

  @Column({ name: 'platform_id', type: 'uuid' })
  platformId: string;

  /** Set once the evidence is referenced by a processed record. */
  @Column({ name: 'record_id', type: 'uuid', nullable: true })
  recordId: string | null;

  /** Id returned by POST /evidence/upload-ticket and referenced in envelope.evidence[]. */
  @Index({ unique: true })
  @Column({ type: 'uuid' })
  uploadId: string;

  @Column({ type: 'varchar', length: 128 })
  bucket: string;

  @Column({ type: 'varchar', length: 512 })
  storageKey: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  originalName: string | null;

  @Column({ type: 'varchar', length: 128 })
  mimeType: string;

  @Column({ type: 'bigint', nullable: true })
  sizeBytes: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  sha256: string | null;

  @Column({ type: 'varchar', length: 16, default: 'quarantined' })
  state: ExternalEvidenceState;

  @Column({ type: 'varchar', length: 16, default: 'restricted' })
  visibility: ExternalEvidenceVisibility;

  @Column({ type: 'timestamptz' })
  ticketExpiresAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  acceptedAt: Date | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  rejectionCode: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  purgedAt: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
