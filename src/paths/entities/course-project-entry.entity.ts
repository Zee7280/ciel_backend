import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

export interface CourseProjectGroupMember {
    name: string;
    email?: string;
    rollNumber?: string;
}

export interface CourseProjectStudentInfo {
    studentName?: string;
    rollNumber?: string;
    studentEmail?: string;
    universityName?: string;
    disciplineName?: string;
    /** School / department free text — distinct from disciplineName (HEC programme search), added for the 8-step "final form" wizard. */
    department?: string;
    /** Programme, e.g. "BBA" — added for the "final form" wizard. */
    programme?: string;
    courseCode?: string;
    semester?: string;
    teamMode?: string; // 'Individual' | 'Pair' | 'Group / Team' | 'Whole class' | 'Interdisciplinary team' (legacy data may say 'Solo' | 'Group')
    /** Older entries may still hold plain name strings from before email capture was added — read via normalizeGroupMembers, don't assume objects. */
    groupMembers?: (string | CourseProjectGroupMember)[];
    /** What type(s) of coursework this was (assignment, semester project, case study, ...) — distinct from assignmentInfo.format (the output's shape). Tap all that apply. */
    courseworkTypes?: string[];
    courseworkTypeOther?: string;
    /** @deprecated pre-multi-select shape — still read for entries submitted before this was a tap-all field. */
    courseworkType?: string;
    teacherName?: string;
    teacherEmail?: string;
    notes?: string;
}

export interface CourseProjectAssignmentInfo {
    /** Legacy single-select format — kept in sync with formats[0] for back-compat with admin views and CourseworkCard. */
    format?: string;
    formatOther?: string;
    /** Multi-select formats — first pick is primary/leads. Added for the "final form" wizard. */
    formats?: string[];
    /** Explicit student override of which pathway leads when formats span more than one — unset means "first pick leads". */
    leadRoute?: string;
    whatAsked?: string;
    realWorldIssue?: string;
    notes?: string;
}

export interface CourseProjectAimsInfo {
    aimStatement?: string;
    objectives?: string[];
    /** Who/what the work was intended to benefit, influence or improve. */
    beneficiaries?: string[];
    beneficiariesOther?: string;
    notes?: string;
}

export interface CourseProjectProcessInfo {
    activities?: string[];
    activitiesOther?: string;
    methods?: string[];
    methodsOther?: string;
    sampleScale?: string;
    /** Who the student engaged or worked with while doing the work. */
    stakeholders?: string[];
    stakeholdersOther?: string;
    notes?: string;
}

/** One measured/estimated result inside resultsInfo.metrics — up to 5 per entry. */
export interface CourseProjectMetric {
    id: string;
    name?: string;
    type?: string;
    typeOther?: string;
    value?: string;
    unit?: string;
    unitOther?: string;
    /** "Actual — measured" | "Target — intended future result" | "Estimated / projected" | "Proposed — not yet tested" */
    status?: string;
    meaning?: string;
    sample?: string;
    periodFrom?: string;
    periodTo?: string;
    source?: string;
    sourceOther?: string;
    character?: string;
    verifier?: string;
    verifierOther?: string;
    comparedBeforeAfter?: boolean;
    baseline?: string;
    evidenceAttached?: boolean;
}

export interface CourseProjectResultsInfo {
    outputs?: string[];
    outputsOther?: string;
    outputDescription?: string;
    findings?: string[];
    /** "Did you measure a result?" — Yes / Partly / No (findings-only) / Not yet. Drives whether `metrics` applies. */
    measured?: string;
    /** Up to 5 structured results — replaces the older single evidenceStatus/metricName/metricValue/metricUnit/numberRepresents fields below. */
    metrics?: CourseProjectMetric[];
    measurableImpact?: string;
    limitationType?: string;
    limitationOther?: string;
    limitationDetail?: string;
    /** "How should this limitation be considered when reading your results?" */
    limitationInterpretation?: string;
    /** Up to 3 optional next-step recommendations. */
    recommendations?: string[];
    /** 2-3 sentence summary of the most important result. */
    resultsSummary?: string;
    notes?: string;
    /** @deprecated pre-multi-metric shape — still read for entries submitted before this system existed. */
    evidenceStatus?: string;
    /** @deprecated see evidenceStatus */
    metricName?: string;
    /** @deprecated see evidenceStatus */
    metricValue?: string;
    /** @deprecated see evidenceStatus */
    metricUnit?: string;
    /** @deprecated see evidenceStatus */
    numberRepresents?: string;
}

export interface CourseProjectSdgEntry {
    goalNumber: number;
    targets: string[];
    how?: string;
    /** 'Direct' | 'Supporting' — the first entry in the array is always the primary SDG. */
    strength?: string;
}

export interface CourseProjectSdgMapping {
    origin?: string;
    /** Honestly declared "no genuine SDG link" — flagged for teacher confirmation rather than force-mapped; the record still counts fully. */
    notApplicable?: boolean;
    entries?: CourseProjectSdgEntry[];
    notes?: string;
}

export interface CourseProjectReflectionInfo {
    lessonLearned?: string;
    /** Legacy honesty rating — superseded by integrationLevel in the "final form" wizard, kept for older entries. */
    sdgLinkHonesty?: string;
    /** How strongly sustainability was connected to the actual work (new taxonomy). */
    integrationLevel?: string;
    skills?: string[];
    skillsOther?: string;
    /** Structured "what's next" choice, e.g. "Recommended for implementation". */
    nextSteps?: string;
    nextStepsOther?: string;
    /** Optional one-line elaboration on what's next — free text, shown alongside nextSteps. */
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

    /** The primary uploaded assignment file (essay/deck/design file/code link) — distinct from evidenceUrls' supporting files. Drives half the Verifiability score. */
    @Column({ nullable: true })
    assignmentFileUrl: string;

    /** Faculty review gate — only "approved" entries count toward Merit Model rankings/AI picks/showcase, mirroring FYP's eligibility gate. */
    @Column({ default: 'pending' })
    facultyApprovalStatus: string; // pending | approved | rejected

    @Column({ type: 'text', nullable: true })
    facultyApprovalNote: string | null;

    @Column({ type: 'timestamp', nullable: true })
    facultyApprovalAt: Date | null;

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
