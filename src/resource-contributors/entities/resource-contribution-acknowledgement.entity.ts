import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/** What the certificate and the contributor's account show; frozen at acknowledgement time. */
export type ContributionSnapshot = {
  project_title: string;
  project_code: string | null;
  opportunity_id: string | null;
  lead_name: string;
  resource_type: string;
  amount: string;
  unit: string;
  purpose: string;
  sources: string[];
  verification: string[];
  evidence_trail: string;
  sdg: number | null;
  partner_name: string | null;
  verified_at: string;
  report_verify_url: string | null;
};

/**
 * One row per external resource contributor named in a verified report (Section 5). Created when
 * CIEL PK publishes the report; the unique (report, resource index) key makes the appreciation
 * email + certificate exactly-once, and `token` is the public certificate key (never the report id).
 */
@Entity('resource_contribution_acknowledgements')
@Index(['reportId', 'resourceIndex'], { unique: true })
export class ResourceContributionAcknowledgement {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'uuid' })
  reportId: string;

  @Column({ type: 'int' })
  resourceIndex: number;

  /** Normalised (lower-case) contributor email from the report. */
  @Index()
  @Column({ type: 'varchar', length: 255 })
  email: string;

  @Column({ type: 'varchar', length: 255 })
  contributorName: string;

  /** Public certificate key: /verify/contribution/<token>. */
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 64 })
  token: string;

  /** CIEL PK account with this email, when one exists (filled at send time or on first sign-in). */
  @Index()
  @Column({ type: 'varchar', length: 64, nullable: true })
  linkedUserId: string | null;

  @Column({ type: 'jsonb' })
  snapshot: ContributionSnapshot;

  @Column({ type: 'timestamptz', nullable: true })
  emailSentAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  notifiedAt: Date | null;

  @Column({ type: 'text', nullable: true })
  error: string | null;

  @CreateDateColumn()
  createdAt: Date;
}
