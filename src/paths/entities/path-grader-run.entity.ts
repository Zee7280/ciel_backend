import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

export type PathGraderRunScope = 'faculty' | 'university';
export type PathGraderRunKind = 'coursework' | 'fyp' | 'startup';

/** Tracks how many times a faculty member or a university org has "run" a path's AI Grader (i.e.
 * called that path's merit-model notify/pin action) in a given calendar year — capped at 3 per
 * pathKind+scope+year, independently per path (exhausting Coursework runs never blocks FYP or
 * Startup runs for the same faculty/university). CIEL/admin is unlimited and never gets a row
 * here. One row per (pathKind, scope, scopeKey, academicYear) tuple. */
@Entity('path_grader_runs')
@Index(['pathKind', 'scope', 'scopeKey', 'academicYear'], { unique: true })
export class PathGraderRun {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column()
    pathKind: PathGraderRunKind;

    @Column()
    scope: PathGraderRunScope;

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
