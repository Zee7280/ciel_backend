import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

export interface CourseProjectStudentInfo {
    studentName?: string;
    rollNumber?: string;
    universityName?: string;
    disciplineName?: string;
    semester?: string;
    teamMode?: string; // 'Solo' | 'Group'
    groupMembers?: string[];
    teacherName?: string;
    teacherEmail?: string;
    notes?: string;
}

export interface CourseProjectAssignmentInfo {
    format?: string;
    formatOther?: string;
    whatAsked?: string;
    realWorldIssue?: string;
    notes?: string;
}

export interface CourseProjectAimsInfo {
    aimStatement?: string;
    objectives?: string[];
    notes?: string;
}

export interface CourseProjectProcessInfo {
    activities?: string[];
    activitiesOther?: string;
    methods?: string[];
    methodsOther?: string;
    sampleScale?: string;
    notes?: string;
}

export interface CourseProjectResultsInfo {
    outputs?: string[];
    outputsOther?: string;
    outputDescription?: string;
    findings?: string[];
    measurableImpact?: string;
    limitationType?: string;
    limitationOther?: string;
    limitationDetail?: string;
    notes?: string;
}

export interface CourseProjectSdgEntry {
    goalNumber: number;
    targets: string[];
    how?: string;
}

export interface CourseProjectSdgMapping {
    origin?: string;
    entries?: CourseProjectSdgEntry[];
    notes?: string;
}

export interface CourseProjectReflectionInfo {
    lessonLearned?: string;
    sdgLinkHonesty?: string;
    skills?: string[];
    skillsOther?: string;
    whatsNext?: string;
    adviceNextSemester?: string;
    notes?: string;
}

/** Which optional modules apply to this assignment's format (Aim, Activities, Methods, Findings, Impact, Limitations). */
export interface CourseProjectModuleInclusion {
    aim?: boolean;
    act?: boolean;
    meth?: boolean;
    find?: boolean;
    imp?: boolean;
    lim?: boolean;
}

/** Per-section review text (student-accepted or edited) shown on the final review/flash-card step. */
export interface CourseProjectSectionSummaries {
    course?: string;
    assignment?: string;
    aims?: string;
    process?: string;
    results?: string;
    sdg?: string;
    reflection?: string;
}

/** One record per student — the Course Project path's single draft-autosaved entry (8-step coursework wizard). */
@Entity('course_project_entries')
export class CourseProjectEntry {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Index()
    @Column()
    userId: string;

    // ---------- Legacy fields (kept for backward compatibility — admin views read these) ----------
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

    // ---------- Step 1: You & the course ----------
    @Column({ type: 'jsonb', nullable: true })
    studentInfo: CourseProjectStudentInfo | null;

    // ---------- Step 2: The assignment & its format ----------
    @Column({ type: 'jsonb', nullable: true })
    assignmentInfo: CourseProjectAssignmentInfo | null;

    // ---------- Step 3: Aim & objectives ----------
    @Column({ type: 'jsonb', nullable: true })
    aimsInfo: CourseProjectAimsInfo | null;

    // ---------- Step 4: How the work was done ----------
    @Column({ type: 'jsonb', nullable: true })
    processInfo: CourseProjectProcessInfo | null;

    // ---------- Step 5: What came out of it ----------
    @Column({ type: 'jsonb', nullable: true })
    resultsInfo: CourseProjectResultsInfo | null;

    // ---------- Step 6: SDG mapping ----------
    @Column({ type: 'jsonb', nullable: true })
    sdgMapping: CourseProjectSdgMapping | null;

    // ---------- Step 7: Reflection ----------
    @Column({ type: 'jsonb', nullable: true })
    reflectionInfo: CourseProjectReflectionInfo | null;

    // ---------- Step 8: Attach, review & submit ----------
    @Column({ type: 'jsonb', nullable: true })
    moduleInclusion: CourseProjectModuleInclusion | null;

    @Column({ type: 'jsonb', nullable: true })
    sectionSummaries: CourseProjectSectionSummaries | null;

    @Column({ type: 'text', nullable: true })
    addedNote: string;

    /** How many of the 8 wizard steps are complete. */
    @Column({ type: 'int', default: 0 })
    stepCompleted: number;

    @Column({ default: 'draft' })
    status: string; // draft | submitted

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
