import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity('issue_logs')
export class IssueLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ default: 'exception' })
  eventType: string;

  @Column({ default: 'error' })
  severity: string;

  /** Explicit column types: union TS types (`string | null`) break reflect-metadata and become `Object`. */
  @Column({ type: 'varchar', length: 128, nullable: true })
  module: string | null;

  @Column({ type: 'text', nullable: true })
  action: string | null;

  @Column({ type: 'varchar', length: 128, nullable: true })
  stage: string | null;

  @Column({ type: 'integer', nullable: true })
  statusCode: number | null;

  @Column({ type: 'varchar', length: 16, nullable: true })
  method: string | null;

  @Column({ type: 'text', nullable: true })
  path: string | null;

  @Column({ type: 'text', nullable: true })
  message: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  errorName: string | null;

  @Column({ type: 'text', nullable: true })
  stack: string | null;

  @Column({ type: 'uuid', nullable: true })
  userId: string | null;

  @Column({ type: 'varchar', length: 320, nullable: true })
  userEmail: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  userRole: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  targetType: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  targetId: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  requestId: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  ip: string | null;

  @Column({ type: 'text', nullable: true })
  userAgent: string | null;

  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, unknown> | null;

  @CreateDateColumn()
  createdAt: Date;
}
