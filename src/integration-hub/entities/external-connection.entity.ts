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
import { ExternalPlatform } from './external-platform.entity';

export type ExternalConnectionStatus =
  | 'proposed'
  | 'org_approved'
  | 'active'
  | 'suspended'
  | 'revoked';

/**
 * One approved relationship between an external platform and one CIEL PK organization. Exists
 * only for authorization and isolation: `organizationId` is a plain UUID copied from core at
 * approval time (validated then, never joined later), per the strict isolation policy.
 */
@Entity({ name: 'external_connections', schema: HUB_SCHEMA })
@Index(['platformId', 'organizationId'], { unique: true })
export class ExternalConnection {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => ExternalPlatform, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'platform_id' })
  platform: ExternalPlatform;

  @Column({ name: 'platform_id', type: 'uuid' })
  platformId: string;

  /** Core organization id, no foreign key by design. */
  @Index()
  @Column({ name: 'organization_id', type: 'uuid' })
  organizationId: string;

  /** Display snapshot taken at proposal time so hub screens never join core tables. */
  @Column({ type: 'varchar', length: 200 })
  organizationName: string;

  @Index()
  @Column({ type: 'varchar', length: 16, default: 'proposed' })
  status: ExternalConnectionStatus;

  @Column({ type: 'text', nullable: true })
  purpose: string | null;

  /** Event types permitted on this connection (subset of the platform's approved types). */
  @Column({ type: 'text', array: true, default: '{}' })
  scopes: string[];

  @Column({ type: 'varchar', length: 160, nullable: true })
  dpaReference: string | null;

  /** When false, any personal field in a payload is rejected at intake. */
  @Column({ type: 'boolean', default: false })
  personalFieldsAllowed: boolean;

  /** Organization admins may open original evidence only when this is true (explicit grant). */
  @Column({ type: 'boolean', default: false })
  orgEvidenceOpenAllowed: boolean;

  /** Overrides the platform default retention when set. */
  @Column({ type: 'int', nullable: true })
  retentionDays: number | null;

  /** Only outbound touchpoint: a plain referral URL on an opportunity must sit under this host. */
  @Column({ type: 'varchar', length: 255, nullable: true })
  referralDomain: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  validFrom: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  validUntil: Date | null;

  @Column({ type: 'uuid', nullable: true })
  proposedByUserId: string | null;

  @Column({ type: 'uuid', nullable: true })
  orgApprovedByUserId: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  orgApprovedAt: Date | null;

  @Column({ type: 'uuid', nullable: true })
  authorizedByUserId: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  authorizedAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  suspendedAt: Date | null;

  @Column({ type: 'text', nullable: true })
  statusReason: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
