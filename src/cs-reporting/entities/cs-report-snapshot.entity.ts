import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';
import type {
  CsProjectRow,
  CsReportFilters,
  CsReportSummary,
  CsStudentRow,
} from '../cs-reporting.util';

/**
 * A community-service report as it was generated, so a file sent to HEC or a university can be
 * downloaded again with exactly the same figures even after later approvals change the live data.
 */
@Entity('cs_report_snapshots')
export class CsReportSnapshot {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Printed on the files, e.g. CSR-20261029-7K3M. */
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 32 })
  code: string;

  @Column({ type: 'varchar', length: 120, nullable: true })
  preparedFor: string | null;

  @Column({ type: 'jsonb' })
  filters: CsReportFilters;

  @Column({ default: false })
  includeStudents: boolean;

  @Column({ type: 'jsonb' })
  summary: CsReportSummary;

  @Column({ type: 'jsonb' })
  projects: CsProjectRow[];

  /** Named student rows; null when the admin generated a totals-only report. */
  @Column({ type: 'jsonb', nullable: true })
  students: CsStudentRow[] | null;

  @Column({ type: 'uuid', nullable: true })
  generatedById: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  generatedByName: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
