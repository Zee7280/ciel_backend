import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

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
  whatsappCode?: string;
  whatsappNumber?: string;
  /** Optional team-row commitment from the v13 student form (Full-time / Part-time / Advisor only / Undecided). */
  commitment?: string;
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
  facultyRole?: string;
  courseRef?: string;
  origin?: string;
  founderEmail?: string;
  founderWhatsappCode?: string;
  founderWhatsappNumber?: string;
  teamFit?: string;
  founderInsight?: string;
  legalStatus?: string;
  ventureType?: string;
  formVersion?: number;
  startDate?: string;
  hoursWeek?: string;
  degreeLevel?: string;
  website?: string;
  commitment?: string;
  priorExp?: string;
  skills?: string[];
  skillGap?: string;
  equitySplit?: string;
  advisors?: string;
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
  customer?: string;
  buyerModels?: string[];
  payerDiff?: string;
  evidenceMethods?: string[];
  competitorType?: string;
  whyUs?: string;
  resistance?: string;
  whyNow?: string;
  customerSegment?: string;
  frequency?: string;
  severity?: string;
  trigger?: string;
  jtbd?: string;
  currentSpend?: number;
  customerQuote?: string;
  wtpEvidence?: string;
  geography?: string;
  tam?: number;
  som?: number;
  marketTrend?: string;
  competitionLevel?: string;
  positioning?: string;
  competitors?: {
    name?: string;
    price?: string;
    strength?: string;
    weakness?: string;
  }[];
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
  demoUrl?: string;
  revenueModels?: string[];
  channels?: string[];
  numberSourceType?: string;
  numberSourceNote?: string;
  price?: number;
  unitCost?: number;
  startupNeed?: number;
  monthlyRevenue?: number;
  cac?: number;
  ltv?: number;
  raised?: number;
  grossMargin?: number;
  burn?: number;
  runway?: number;
  productStatus?: string;
  features?: string;
  ipStatus?: string;
  moatType?: string;
  techDependency?: string;
  roadmap?: string;
  deliveryModel?: string;
  capacity?: string;
  bottleneck?: string;
  qualityControl?: string;
  scalePlan?: string;
  pricingStrategy?: string;
  pricingTested?: string;
  purchaseFreq?: number;
  retentionYears?: number;
  primaryChannel?: string;
  salesMotion?: string;
  salesCycle?: string;
  referral?: string;
  keyMessage?: string;
  mktBudget?: number;
  newCustMonth?: number;
  funnelReach?: number;
  funnelLeads?: number;
  funnelCust?: number;
  brandAssets?: string;
  partners?: string;
  fixedCosts?: number;
  budgetPeriod?: string;
  budgetStatus?: string;
  budgetLines?: { category?: string; amount?: number; note?: string }[];
  fundSources?: { source?: string; amount?: number; note?: string }[];
  cashOnHand?: number;
  monthlyCosts?: number;
  projCustM1?: number;
  projGrowth?: number;
  paymentTerms?: string;
  revenueTarget12?: number;
  profitMonth?: string;
  mrr?: number;
  gmv?: number;
  takeRate?: number;
  mau?: number;
  churn?: number;
  payingUsers?: number;
  finAssumptions?: string;
  accounting?: string;
  raisePlan?: string;
  askInstrument?: string;
  uofProduct?: number;
  uofOps?: number;
  uofMarketing?: number;
  uofTeam?: number;
  uofLegal?: number;
  uofContingency?: number;
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
  helpImpact?: string;
  responsibility?: string[];
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
  mentorsConsulted?: number;
  competitionsJoined?: number;
  risk?: string;
  mitigation?: string;
  assumption?: string;
  regulatoryBarrier?: string;
  reflection?: string;
  valuation?: number;
  equityPercent?: number;
  founderOwnership?: number;
  fundRunway?: number;
  exitStrategy?: string;
  riskRows?: {
    type?: string;
    description?: string;
    likelihood?: string;
    impact?: string;
    mitigation?: string;
  }[];
  otherCommit?: string;
  keyPerson?: string;
  hiringNeed?: string;
  paceScore?: string;
  burnoutSigns?: string[];
  burnoutPlan?: string;
  plan90?: string;
  vision35?: string;
}

export interface VentureReviewPipeline {
  declarationWork?: boolean;
  declarationConsent?: boolean;
  studentDeclaredAt?: string;
  supervisorStatus?:
    | 'not_started'
    | 'pending'
    | 'approved'
    | 'revisions_requested'
    | 'rejected';
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
  /** CIEL PK Investor Hub spotlight — set by super-admin, preserved across student saves. */
  featured?: boolean;
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
