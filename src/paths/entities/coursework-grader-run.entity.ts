import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

export type CourseworkGraderRunScope = 'faculty' | 'university';

/** Tracks how many times a faculty member or a university org has "run" the Coursework AI Grader
 * (i.e. called the merit-model notify/pin action) in a given calendar year — capped at 3 per
 * scope+year; CIEL/admin is unlimited and never gets a row here. One row per (scope, scopeKey,
 * academicYear) triple. */
@Entity('coursework_grader_runs')
@Index(['scope', 'scopeKey', 'academicYear'], { unique: true })
export class CourseworkGraderRun {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column()
    scope: CourseworkGraderRunScope;

    /** Faculty scope: the faculty user's lowercased email. University scope: the organization id. */
    @Column()
    scopeKey: string;

    @Column({ type: 'int' })
    academicYear: number;

    @Column({ type: 'int', default: 0 })
    runCount: number;

    @Column({ type: 'timestamp', nullable: true })
    lastRunAt: Date | null;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
