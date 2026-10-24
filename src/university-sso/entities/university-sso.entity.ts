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
import { Organization } from '../../organizations/entities/organization.entity';
import type { SsoProvider, SsoStatus } from '../university-sso.constants';

/**
 * One university's single sign-on configuration. A university without a row has SSO off. Kept
 * apart from `organizations` so the client secret is never loaded by ordinary organization reads.
 */
@Entity('university_sso')
export class UniversitySso {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index({ unique: true })
  @Column({ type: 'uuid' })
  organizationId: string;

  @ManyToOne(() => Organization, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'organizationId' })
  organization: Organization;

  @Column({ type: 'varchar', length: 16, default: 'draft' })
  status: SsoStatus;

  @Column({ type: 'varchar', length: 16 })
  provider: SsoProvider;

  /** Generic OpenID Connect issuer URL (null for the Google / Microsoft presets). */
  @Column({ type: 'varchar', length: 255, nullable: true })
  issuer: string | null;

  /** Microsoft Entra tenant id (required), or the Google Workspace primary domain (optional). */
  @Column({ type: 'varchar', length: 255, nullable: true })
  tenantId: string | null;

  @Column({ type: 'varchar', length: 255 })
  clientId: string;

  /** AES-256-GCM (sso-seal key); never selected unless a sign-in or an admin save needs it. */
  @Column({ type: 'text', nullable: true, select: false })
  clientSecretEncrypted: string | null;

  /** Email domains students of this university sign in with, lower-case. */
  @Column({ type: 'simple-array' })
  allowedDomains: string[];

  @Column({ type: 'timestamptz', nullable: true })
  activatedAt: Date | null;

  @Column({ type: 'uuid', nullable: true })
  activatedByUserId: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  lastTestAt: Date | null;

  @Column({ type: 'boolean', nullable: true })
  lastTestOk: boolean | null;

  @Column({ type: 'varchar', length: 300, nullable: true })
  lastTestNote: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  lastSignInAt: Date | null;

  @Column({ type: 'int', default: 0 })
  signInCount: number;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
