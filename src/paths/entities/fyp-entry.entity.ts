import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

export interface FypMilestone {
  label: string;
  status: 'pending' | 'in_progress' | 'complete';
  dueDate?: string | null;
  completedAt?: string | null;
}

export interface FypDeliverable {
  version: number;
  label: string;
  fileUrl: string;
  uploadedAt: string;
}

export interface FypCommunityLinkage {
  orgName?: string;
  contactName?: string;
  contactEmail?: string;
  description?: string;
}

export const DEFAULT_FYP_MILESTONES: FypMilestone[] = [
  {
    label: 'Proposal approved',
    status: 'pending',
    dueDate: null,
    completedAt: null,
  },
  {
    label: 'Literature / groundwork review',
    status: 'pending',
    dueDate: null,
    completedAt: null,
  },
  {
    label: 'Midpoint evaluation',
    status: 'pending',
    dueDate: null,
    completedAt: null,
  },
  {
    label: 'Final implementation',
    status: 'pending',
    dueDate: null,
    completedAt: null,
  },
  {
    label: 'Defense / submission',
    status: 'pending',
    dueDate: null,
    completedAt: null,
  },
];

// ── 9-step guided wizard groups (additive — the legacy milestone-timeline fields above are untouched) ──

export interface FypTeamMember {
  name: string;
  email?: string;
  role?: string;
  rollNumber?: string;
  whatsappCode?: string;
  whatsappNumber?: string;
  /** Server-computed from team_member_invites — 'accepted' only once the named co-author has
   * clicked their emailed invite link while signed in with this exact email. Ignored on write. */
  inviteStatus?: 'pending' | 'accepted';
}
export interface FypProjectInfo {
  title?: string;
  /** The final-form's first, required field — mirrors CourseProjectStudentInfo.universityName. */
  university?: string;
  school?: string;
  degree?: string;
  graduationYear?: string;
  /** Drives the adaptive-vocabulary "route" (scholar/maker/builder/storyteller/consultant) on the frontend — purely a relabeling key, not validated server-side. */
  projectType?: string;
  /** Multi-select project type(s) — supersedes the single projectType above; first pick leads unless leadRoute overrides. */
  projectTypes?: string[];
  /** Explicit override of which route leads when projectTypes span more than one route — unset means "first pick leads". */
  leadRoute?: string;
  studentName?: string;
  studentEmail?: string;
  rollNumber?: string;
  /** HEC allows splitting the FYP across the final year — which semester(s) it spans. */
  span?: string;
  /** Typically 6 under HEC policy — optional, not validated server-side. */
  creditHours?: string;
  /** Older entries may hold plain name strings — read via normalizeFypTeamMembers, don't assume objects. */
  teamMembers?: (string | FypTeamMember)[];
  supervisorName?: string;
  supervisorEmail?: string;
  coSupervisorName?: string;
  coSupervisorEmail?: string;
  academicAreaKey?: string;
  academicArea?: string;
  discipline?: string;
  officialProgram?: string;
  academicLevel?: string;
  teamType?: string;
  teamRole?: string;
  v9Route?: string;
  v9RouteOther?: string;
  v9Form?: Record<string, unknown>;
}
export interface FypBackgroundInfo {
  problem?: string;
  whyUrgent?: string[];
  whyUrgentOther?: string;
  audience?: string[];
  audienceOther?: string;
}
export interface FypObjectivesInfo {
  aim?: string;
  objectives?: string[];
  /** What was deliberately excluded from the work's coverage — optional but strengthens the record. */
  scope?: string;
}
export interface FypLiteratureInfo {
  sourcesReviewed?: string;
  sourceTypes?: string[];
  sourceTypesOther?: string;
  gap?: string;
}
/** One "how many / of what" line in the standardized scale-builder — up to 6 per entry. */
export interface FypScaleEntry {
  n?: string;
  unit?: string;
  unitOther?: string;
}
export interface FypMethodologyInfo {
  approaches?: string[];
  approachesOther?: string;
  methods?: string[];
  methodsOther?: string;
  /** @deprecated free-text predecessor of scaleEntries — still read as a fallback for older entries. */
  sampleScale?: string;
  /** Structured scale/scope builder (up to 6 entries) — supersedes the free-text sampleScale above. */
  scaleEntries?: FypScaleEntry[];
  tools?: string;
  /** Month strings ("YYYY-MM"), or day strings ("YYYY-MM-DD") when periodDayPrecision is set — when the work was actually carried out. */
  periodFrom?: string;
  periodTo?: string;
  /** When true, periodFrom/periodTo carry day precision instead of month precision. */
  periodDayPrecision?: boolean;
}
/** One measured/estimated/target number inside findings.metrics — up to 3 per entry. */
export interface FypMetric {
  id?: string;
  name?: string;
  value?: string;
  unit?: string;
  unitOther?: string;
  /** 'Measured' | 'Estimated' | 'Target' */
  status?: string;
}
export interface FypFindingsInfo {
  /** What did the work produce? (thesis, prototype, collection, app, dataset, ...) */
  outputs?: string[];
  outputsOther?: string;
  findings?: string[];
  measurableImpact?: string;
  /** @deprecated superseded by the single `limitation` field below — still read as a fallback. */
  limitationType?: string;
  /** @deprecated see limitationType */
  limitationDetail?: string;
  /** The one honest limitation line — supersedes limitationType/limitationDetail. */
  limitation?: string;
  /** Evidence-quality ladder, mirrors Course Project's resultsInfo.evidenceStatus. */
  evidenceStatus?: string;
  /** Up to 3 structured results, each status-tagged Measured/Estimated/Target — supersedes the flat metricName/metricValue/metricUnit/numberRepresents fields below. */
  metrics?: FypMetric[];
  /** @deprecated pre-multi-metric shape — still read for entries submitted before this system existed. */
  metricName?: string;
  /** @deprecated see metricName */
  metricValue?: string;
  /** @deprecated see metricName */
  metricUnit?: string;
  /** @deprecated see metricName */
  numberRepresents?: string;
}
/** Route-specific extras shown only for the matching project type — a degree-show collection needs different fields than a software build. */
export interface FypRouteDetails {
  // maker route — degree show / exhibition
  showMonth?: string;
  piecesShown?: number;
  juryExaminer?: string;
  // builder route — build status
  buildStatus?: string;
  testersCount?: number;
  iterationsCount?: number;
  // storyteller route — screening / release
  screeningMonth?: string;
  audienceReached?: number;
  runtimeFormat?: string;
  // consultant route — client engagement
  clientOrg?: string;
  engagementBasis?: string;
  recommendationStatus?: string;
  // scholar route — discussion & conclusion (the HEC thesis chain's closing step)
  discussion?: string;
  conclusion?: string;
  v9Pathway?: Record<string, unknown>;
  v9Roadmap?: { stage?: string; goal?: string }[];
}
export interface FypSdgEntry {
  goalNumber: number;
  targets: string[];
  how?: string;
}
export interface FypSdgMapping {
  entries?: FypSdgEntry[];
  noSdgApplies?: boolean;
  /** The one shared "briefly explain the connection" line, covering all selected SDGs together
   * (the final-form has no per-SDG explanation field) — mirrors Course Project's sdgMapping.notes. */
  notes?: string;
}
export interface FypReflectionInfo {
  biggestLesson?: string;
  hardestMoment?: string;
  wrongAssumption?: string;
  sustainabilityShift?: string;
  skills?: string[];
  whatsNext?: string;
  adviceForNext?: string;
}
export interface FypRepositoryInfo {
  externalLinks?: string;
  visibility?: string;
}
export interface FypSectionSummaries {
  project?: string;
  background?: string;
  objectives?: string;
  literature?: string;
  methodology?: string;
  findings?: string;
  sdg?: string;
  reflection?: string;
}

/** One record per student — FYP / Thesis path: legacy overview/milestone timeline, plus the 9-step guided wizard record. */
@Entity('fyp_entries')
export class FypEntry {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** One FYP/Thesis record per student (unlike Course Project's multi-entry deck) — enforced at the DB level so a race between two saves can never create a duplicate row that silently shadows the other. */
  @Index({ unique: true })
  @Column()
  userId: string;

  @Column({ nullable: true })
  projectTitle: string;

  @Column({ type: 'text', nullable: true })
  overview: string;

  /** Supervisor review gate — same pattern as Course Project's facultyApprovalStatus: only "approved"
   * entries count toward Merit Model rankings/AI picks/showcase. */
  @Column({ default: 'pending' })
  supervisorApprovalStatus: string; // pending | approved | rejected | revision_requested

  @Column({ type: 'text', nullable: true })
  supervisorApprovalNote: string | null;

  @Column({ type: 'timestamp', nullable: true })
  supervisorApprovalAt: Date | null;

  /** Pinned by the FYP merit-model notify — same shape as Course Project's meritRibbon. */
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

  @Column({
    type: 'jsonb',
    default: () => `'${JSON.stringify(DEFAULT_FYP_MILESTONES)}'`,
  })
  milestones: FypMilestone[];

  @Column({ type: 'jsonb', default: () => "'[]'" })
  deliverables: FypDeliverable[];

  @Column({ type: 'jsonb', nullable: true })
  communityLinkage: FypCommunityLinkage | null;

  @Column({ type: 'jsonb', nullable: true })
  projectInfo: FypProjectInfo | null;

  @Column({ type: 'jsonb', nullable: true })
  background: FypBackgroundInfo | null;

  @Column({ type: 'jsonb', nullable: true })
  objectivesInfo: FypObjectivesInfo | null;

  @Column({ type: 'jsonb', nullable: true })
  literature: FypLiteratureInfo | null;

  @Column({ type: 'jsonb', nullable: true })
  methodology: FypMethodologyInfo | null;

  @Column({ type: 'jsonb', nullable: true })
  findings: FypFindingsInfo | null;

  @Column({ type: 'jsonb', nullable: true })
  routeDetails: FypRouteDetails | null;

  @Column({ type: 'jsonb', nullable: true })
  sdgMapping: FypSdgMapping | null;

  @Column({ type: 'jsonb', nullable: true })
  reflectionInfo: FypReflectionInfo | null;

  @Column({ type: 'jsonb', nullable: true })
  repository: FypRepositoryInfo | null;

  @Column({ type: 'jsonb', nullable: true })
  sectionSummaries: FypSectionSummaries | null;

  @Column({ type: 'text', nullable: true })
  addedNote: string | null;

  @Column({ type: 'int', default: 0 })
  stepCompleted: number;

  @Column({ type: 'varchar', default: 'draft' })
  status: 'draft' | 'submitted';

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
