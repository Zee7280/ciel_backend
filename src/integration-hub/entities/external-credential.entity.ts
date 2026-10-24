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
import { ExternalPlatform } from './external-platform.entity';

export type ExternalCredentialStatus = 'active' | 'revoked';

/**
 * Machine credential for HMAC request signing. The secret is shown once at issuance and stored
 * encrypted (AES-256-GCM, key from HUB_SECRETS_KEY) so the verifier can recompute signatures.
 */
@Entity({ name: 'external_credentials', schema: HUB_SCHEMA })
export class ExternalCredential {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => ExternalPlatform, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'platform_id' })
  platform: ExternalPlatform;

  @Index()
  @Column({ name: 'platform_id', type: 'uuid' })
  platformId: string;

  /** Public identifier sent in X-Hub-Key-Id. */
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 48 })
  keyId: string;

  @Column({ type: 'text' })
  secretCiphertext: string;

  /** Last 4 characters of the secret for admin display. */
  @Column({ type: 'varchar', length: 4 })
  secretLast4: string;

  @Column({ type: 'varchar', length: 16, default: 'active' })
  status: ExternalCredentialStatus;

  @Column({ type: 'varchar', length: 120, nullable: true })
  label: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  expiresAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  lastUsedAt: Date | null;

  @Column({ type: 'uuid', nullable: true })
  createdByUserId: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  revokedAt: Date | null;

  @Column({ type: 'uuid', nullable: true })
  revokedByUserId: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
