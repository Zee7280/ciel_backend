import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

/** One record per student — the Course Project path's single draft-autosaved entry. */
@Entity('course_project_entries')
export class CourseProjectEntry {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Index()
    @Column()
    userId: string;

    @Column({ nullable: true })
    course: string;

    @Column({ nullable: true })
    projectTitle: string;

    @Column({ type: 'text', nullable: true })
    projectDescription: string;

    @Column({ type: 'simple-array', nullable: true })
    sdgs: number[];

    @Column({ type: 'simple-array', nullable: true })
    evidenceUrls: string[];

    /** How many of the 4 stepper steps (Course, Project, Impact, Evidence) are complete. */
    @Column({ type: 'int', default: 0 })
    stepCompleted: number;

    @Column({ default: 'draft' })
    status: string; // draft | submitted

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
