import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

export interface VentureTractionRow {
    date: string;
    metric: string;
    value: string;
    note?: string;
}

export interface VentureTeamMember {
    name: string;
    role: string;
    email?: string;
    /** Server-computed from team_member_invites — 'accepted' only once the named teammate has
     * clicked their emailed invite link while signed in with this exact email. Ignored on write. */
    inviteStatus?: 'pending' | 'accepted';
}

// ── 8-step guided wizard groups (additive — the legacy fields above are untouched) ──

export interface VentureAcademicSetup {
    /** @deprecated single-select predecessor of submissionTypes — still read as a fallback for older entries. */
    submissionType?: string;
    /** Multi-select submission type(s) — a venture can legitimately be both e.g. a Final-Year Project and started as coursework. Supersedes submissionType above. */
    submissionTypes?: string[];
    university?: string;
    campus?: string;
    faculty?: string;
    department?: string;
    program?: string;
    academicYear?: string;
    semester?: string;
    courseCode?: string;
    groupId?: string;
    supervisorName?: string;
    /** Optional — used to match the faculty cohort deck the same way FYP uses supervisorEmail. */
    supervisorEmail?: string;
    coSupervisor?: string;
    deadline?: string;
    teamType?: string;
    industrySponsor?: string;
    ethicsApproval?: string;
    confidentialityStatus?: string;
    ipOwnership?: string;
    founderName?: string;
    founderRole?: string;
    founderCredentials?: string;
}

export interface VentureDocument {
    type: string;
    version: number;
    fileUrl: string;
    uploadedAt: string;
}

export interface VentureIdeaInfo {
    problem?: string;
    proofFact?: string;
    payerWho?: string;
    userWho?: string;
    beneficiaryWho?: string;
    sector?: string;
    city?: string;
    pitch?: string;
}

export interface VentureSolutionInfo {
    solution?: string;
    alternative?: string;
    advantage?: string;
    revenue?: string;
    costPerSale?: string;
    milestone12mo?: string;
    marketWho?: string;
    marketSize?: string;
    marketSource?: string;
}

export interface VentureSdgEntry {
    goalNumber: number;
    targets: string[];
    how?: string;
}
export interface VentureIndicator {
    indicator?: string;
    forGoal?: string;
    target12mo?: string;
    verifiedBy?: string;
}
export interface VentureSdgMapping {
    entries?: VentureSdgEntry[];
    mode?: 'map' | 'review' | 'none';
    howImpact?: string;
    indicators?: VentureIndicator[];
}

export interface VentureEvidenceInfo {
    interviews?: number;
    surveyResponses?: number;
    willingToTest?: number;
    testers?: number;
    pilotPartners?: number;
    preOrders?: number;
    customers?: number;
    revenueToDate?: number;
    monthlyGrowthPercent?: number;
    repeatPercent?: number;
    partnerships?: number;
    lettersOfIntent?: number;
    fundingSought?: number;
    useOfFunds?: string;
    expectedResult?: string;
    openTo?: string[];
}

export interface VentureReviewPipeline {
    declarationWork?: boolean;
    declarationConsent?: boolean;
    studentDeclaredAt?: string;
    supervisorStatus?: 'not_started' | 'pending' | 'approved' | 'revisions_requested' | 'rejected';
    supervisorNote?: string | null;
    universityStatus?: 'not_started' | 'pending' | 'approved';
    sdgReviewStatus?: 'not_started' | 'pending' | 'approved';
}

export interface VenturePublishSettings {
    audience?: 'private' | 'university' | 'partners' | 'investors';
    showName?: boolean;
    showTeam?: boolean;
    showUniversity?: boolean;
    showTraction?: boolean;
    showAsk?: boolean;
    acceptIntros?: boolean;
}

export interface VentureTeamConsentEntry {
    name: string;
    consented: boolean;
}

export interface VentureSectionSummaries {
    opportunity?: string;
    advantage?: string;
    business?: string;
    traction?: string;
    impact?: string;
    ask?: string;
    founder?: string;
}

/** One record per student — Startup / Business path: venture profile, traction, team, materials, visibility, plus the 8-step guided wizard record. */
@Entity('venture_entries')
export class VentureEntry {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    /** One venture record per student — enforced at the DB level so a race between two saves can never create a duplicate row that silently shadows the other. */
    @Index({ unique: true })
    @Column()
    userId: string;

    @Column({ nullable: true })
    ventureName: string;

    @Column({ type: 'text', nullable: true })
    description: string;

    @Column({ nullable: true })
    stage: string;

    @Column({ type: 'jsonb', default: () => "'[]'" })
    tractionRows: VentureTractionRow[];

    @Column({ type: 'jsonb', default: () => "'[]'" })
    team: VentureTeamMember[];

    @Column({ type: 'simple-array', nullable: true })
    materialUrls: string[];

    /** Derived, not directly student-toggled once the guided wizard has been used — see upsertVenture/computeShowcaseReady. */
    @Column({ default: false })
    isVisible: boolean;

    @Column({ type: 'jsonb', nullable: true })
    academicSetup: VentureAcademicSetup | null;

    @Column({ type: 'jsonb', default: () => "'[]'" })
    documents: VentureDocument[];

    @Column({ type: 'jsonb', nullable: true })
    ideaInfo: VentureIdeaInfo | null;

    @Column({ type: 'jsonb', nullable: true })
    solutionInfo: VentureSolutionInfo | null;

    @Column({ type: 'jsonb', nullable: true })
    sdgMapping: VentureSdgMapping | null;

    @Column({ type: 'jsonb', nullable: true })
    evidenceInfo: VentureEvidenceInfo | null;

    @Column({ type: 'jsonb', nullable: true })
    reviewPipeline: VentureReviewPipeline | null;

    @Column({ type: 'jsonb', nullable: true })
    publishSettings: VenturePublishSettings | null;

    @Column({ type: 'jsonb', default: () => "'[]'" })
    teamConsent: VentureTeamConsentEntry[];

    @Column({ type: 'jsonb', nullable: true })
    sectionSummaries: VentureSectionSummaries | null;

    @Column({ type: 'int', default: 0 })
    stepCompleted: number;

    @Column({ type: 'varchar', default: 'draft' })
    status: 'draft' | 'submitted';

    /** Pinned by the venture merit-model notify — same shape as Course Project's meritRibbon. */
    @Column({ type: 'jsonb', nullable: true })
    meritRibbon?: {
        rank: number;
        of: number;
        scope: string;
        total?: number;
        badgeLevel?: 'Gold' | 'Silver' | 'Bronze' | 'Participant';
        previousRank?: number | null;
        at: string;
    } | null;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
