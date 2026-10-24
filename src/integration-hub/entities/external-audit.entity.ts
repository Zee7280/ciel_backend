import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { HUB_SCHEMA } from '../hub-connection.constants';

export type ExternalAuditActorType =
  | 'super_admin'
  | 'org_admin'
  | 'platform'
  | 'system';

/** Append-only. The runtime role has no DELETE on this table. */
@Entity({ name: 'external_audit', schema: HUB_SCHEMA })
@Index(['targetType', 'targetId'])
@Index(['createdAt'])
export class ExternalAudit {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 16 })
  actorType: ExternalAuditActorType;

  /** Core user id, platform id, or system job name. No FK. */
  @Column({ type: 'varchar', length: 64, nullable: true })
  actorId: string | null;

  @Column({ type: 'varchar', length: 160, nullable: true })
  actorLabel: string | null;

  @Index()
  @Column({ type: 'varchar', length: 64 })
  action: string;

  @Column({ type: 'varchar', length: 32 })
  targetType: string;

  @Column({ type: 'varchar', length: 64, nullable: true })
  targetId: string | null;

  /** Connection the action relates to, for org-scoped audit views. */
  @Index()
  @Column({ type: 'uuid', nullable: true })
  connectionId: string | null;

  @Column({ type: 'jsonb', nullable: true })
  details: Record<string, unknown> | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  ip: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
