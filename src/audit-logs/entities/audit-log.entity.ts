import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  Index,
} from 'typeorm';

@Entity('audit_logs')
export class AuditLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column()
  action: string;

  @Column({ nullable: true })
  user: string; // Storing name or ID directly for simplicity in logs

  @Column({ nullable: true })
  target: string;

  @Column({ nullable: true })
  ip: string;

  @Index()
  @Column({ nullable: true })
  user_email: string;

  @Column({ nullable: true })
  target_type: string;

  /** HTTP method of the mutation (POST / PATCH / PUT / DELETE). Summary column so the list never
   * has to load `details`. Null on rows written before the column existed. */
  @Column({ type: 'varchar', length: 12, nullable: true })
  method: string | null;

  /** 'success' | 'failure' (see AdminMutationAuditInterceptor). */
  @Column({ type: 'varchar', length: 16, nullable: true })
  outcome: string | null;

  @Column({ type: 'integer', nullable: true })
  status_code: number | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  user_role: string | null;

  /** Cheap human label of the target (title / name / email from the request body). */
  @Column({ type: 'varchar', length: 160, nullable: true })
  target_label: string | null;

  @Column('simple-json', { nullable: true })
  details: any;

  @Index()
  @CreateDateColumn()
  created_at: Date;
}
