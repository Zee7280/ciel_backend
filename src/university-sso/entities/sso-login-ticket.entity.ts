import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * One-time ticket the SSO callback hands to the browser (in the redirect URL) and the frontend
 * exchanges for a session token. Only its hash is stored; it expires in minutes and is single use,
 * so a URL left in browser history cannot be replayed.
 */
@Entity('sso_login_tickets')
export class SsoLoginTicket {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 64 })
  tokenHash: string;

  @Column({ type: 'uuid' })
  userId: string;

  @Column({ type: 'uuid' })
  organizationId: string;

  @Column({ type: 'boolean', default: false })
  isMobile: boolean;

  @Index()
  @Column({ type: 'timestamptz' })
  expiresAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  usedAt: Date | null;

  @CreateDateColumn()
  createdAt: Date;
}
