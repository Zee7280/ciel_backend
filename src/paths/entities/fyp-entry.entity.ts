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
}
export interface FypProjectInfo {
  title?: string;
  school?: string;
  degree?: string;
  graduationYear?: string;
  /** Drives the adaptive-vocabulary "route" (scholar/maker/builder/storyteller/consultant) on the frontend — purely a relabeling key, not validated server-side. */
  projectType?: string;
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
export interface FypMethodologyInfo {
  approaches?: string[];
  methods?: string[];
  methodsOther?: string;
  sampleScale?: string;
  tools?: string;
  /** Month strings ("YYYY-MM") — when the work was actually carried out. */
  periodFrom?: string;
  periodTo?: string;
}
export interface FypFindingsInfo {
  findings?: string[];
  measurableImpact?: string;
  limitationType?: string;
  limitationDetail?: string;
  /** Evidence-quality ladder, mirrors Course Project's resultsInfo.evidenceStatus. */
  evidenceStatus?: string;
  metricName?: string;
  metricValue?: string;
  metricUnit?: string;
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
}
export interface FypSdgEntry {
  goalNumber: number;
  targets: string[];
  how?: string;
}
export interface FypSdgMapping {
  entries?: FypSdgEntry[];
  noSdgApplies?: boolean;
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
