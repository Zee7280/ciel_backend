/**
 * Composite Impact Index (CII) v5.0 Hybrid — Community Service scoring engine.
 *
 * Ported from the reference `cii-calculator.js` in CIEL_PK_CII_ANALYSER_v5.0:
 * 85 AI report-quality points (dims 1,2,3,4A,4B,5,6,8,9) + 15 Admin evidence
 * points (Dimension 7 only). The AI never scores Dimension 7, never inspects
 * evidence originals, and never returns a numeric CII or badge. Arithmetic,
 * status, bands and quality gates are computed here by `computeCiiV45Result()`.
 *
 * Stored JSON still lives on `report.ciiV45` / lock fields (unchanged publish
 * path). Keep in sync with `ciel_frontend/src/utils/communityCiiAnalyser.ts`.
 */

export class CiiV45ValidationError extends Error {}

function fail(message: string): never {
  throw new CiiV45ValidationError(message);
}

export type CiiV45Anchor = 0 | 1 | 2 | 3 | 4 | 'P';

export type CiiV45VerificationStatus =
  | 'VERIFIED'
  | 'SYSTEM_VERIFIED'
  | 'AI_REPORT'
  | 'ADMIN_VERIFIED'
  | 'NARRATIVE_ONLY'
  | 'PROCESSING_REQUIRED'
  | 'NOT_APPLICABLE'
  | 'CONTRADICTED';

export type CiiV45ProcessingStatus =
  | 'INSPECTED'
  | 'UNREADABLE'
  | 'CORRUPTED'
  | 'CONVERSION_FAILED'
  | 'INACCESSIBLE'
  | 'DUPLICATE';

export type CiiV45SupportStatus =
  | 'SUPPORTED'
  | 'PARTIALLY_SUPPORTED'
  | 'UNSUPPORTED'
  | 'CONTRADICTED'
  | 'PROCESSING_REQUIRED';

export type CiiV45Privacy = 'PUBLIC' | 'RESTRICTED' | 'PRIVATE';

export type CiiV45Dimension =
  | '1'
  | '2'
  | '3'
  | '4A'
  | '4B'
  | '5'
  | '6'
  | '7'
  | '8'
  | '9';

export type CiiV45UpliftCategory =
  | 'effort'
  | 'resources'
  | 'partnerships'
  | 'outcomes';

export interface CiiV45CriterionScore {
  criterion: string;
  anchor: CiiV45Anchor;
  qualityAnchor: CiiV45Anchor;
  verificationStatus: CiiV45VerificationStatus;
  sourceRefs: string[];
  evidenceIds: string[];
  reasoningSummary: string;
  deductionReason?: string | null;
}

export interface CiiV45SectionScore {
  dimension: CiiV45Dimension;
  criterionScores: CiiV45CriterionScore[];
}

export interface CiiV45IndividualHours {
  studentId: string;
  hours: number | null;
  requiredHours: number;
  verified: boolean;
  recordComplete?: boolean;
}

export interface CiiV45Gap {
  type: string;
  material: boolean;
  mandatory?: boolean;
  field?: string;
}

export interface CiiV45InputCompleteness {
  gaps: CiiV45Gap[];
  individualHours: CiiV45IndividualHours[];
  mandatoryFieldsComplete: boolean;
}

export interface CiiV45Claim {
  claimId: string;
  text?: string;
  material: boolean;
  evidenceIds: string[];
  supportStatus: CiiV45SupportStatus;
}

export interface CiiV45EvidenceAudit {
  evidenceId: string;
  fileName?: string;
  fileType?: string;
  privacy: CiiV45Privacy;
  material: boolean;
  processingStatus: CiiV45ProcessingStatus;
  claimIds: string[];
  actualContentSummary?: string;
  matchConfidence?: number | null;
  supportStatus: CiiV45SupportStatus;
  evidenceStrength?: string;
  independence?: string;
  explanation?: string;
}

export interface CiiV45UpliftItem {
  category: CiiV45UpliftCategory;
  points: number;
  studentId?: string;
  beyondBaseJustification?: string;
  evidenceIds?: string[];
  adminVerified?: boolean;
}

export interface CiiV45ExtraMileUplift {
  assessmentStatus: 'ASSESSED' | 'PROCESSING_REQUIRED' | 'PENDING_ADMIN';
  items: CiiV45UpliftItem[];
  total?: number | null;
  knownTotal?: number;
}

export interface CiiV45IntegrityIssue {
  origin: 'STUDENT';
  confirmed: boolean;
  claimId?: string;
  evidenceIds: string[];
  reason: string;
  adminVerified?: boolean;
}

export interface CiiV45IntegrityPenalty {
  points: number;
  issues: CiiV45IntegrityIssue[];
}

export interface CiiV45ExceptionalFeature {
  verified: boolean;
  explanation?: string;
  evidenceIds?: string[];
  adminVerified?: boolean;
}

export interface CiiV45AdminEvidenceCriterion {
  criterion: string;
  anchor: Exclude<CiiV45Anchor, 'P'>;
  reasoningSummary: string;
  evidenceIds: string[];
}

export interface CiiV45AdminEvidenceAssessment {
  status: 'PENDING' | 'ASSESSED';
  assessorId?: string;
  assessedAt?: string;
  criteria?: CiiV45AdminEvidenceCriterion[];
}

export type CiiV45DeductionLedgerEntry = Record<string, unknown>;

/**
 * R3 Admin moderation of one AI criterion mark. The AI anchor stays on the criterion untouched
 * (it is the immutable baseline); the reviewed mark replaces it in the section total only.
 * Keyed in `CiiV45AdminModeration.edits` by `"<dimension>.<criterionKey>"`.
 */
export interface CiiV45AdminCriterionEdit {
  /** Reviewed points, 0..criterion maximum, at most two decimals. */
  points: number;
  reason: string;
  sourceRef?: string | null;
  actorId: string;
  at: string;
}

export interface CiiV45ModerationLogEntry {
  dimension: string;
  criterion: string;
  /** The mark in force before this change (AI mark, or the previous Admin mark). */
  from: number | null;
  /** The mark after the change (the AI mark again when an edit is restored; null if that is pending). */
  to: number | null;
  aiScore: number | null;
  reason: string;
  sourceRef?: string | null;
  actorId: string;
  at: string;
}

export interface CiiV45AdminModeration {
  /** Bumped on every saved edit; the editor sends the revision it read (optimistic concurrency). */
  revision: number;
  edits: Record<string, CiiV45AdminCriterionEdit>;
  /** Append-only history of every saved criterion change. */
  log: CiiV45ModerationLogEntry[];
}

/** Admin confirmations behind a published L6 (the "sustained impact" qualification). */
export interface CiiV45L6Confirmations {
  observedRetention: boolean;
  communityOwnership: boolean;
  externalCorroboration: boolean;
  /** Exact report / follow-up / evidence source the confirmations rest on. */
  sourceRef: string;
  confirmedByAdminId?: string;
  confirmedAt?: string;
}

export type CiiV45L6Status =
  | 'NOT_REQUIRED'
  | 'PENDING_QUALIFICATION'
  | 'QUALIFIED';

export interface CiiV45L6Assessment {
  status: CiiV45L6Status;
  reasons: string[];
  minimums: {
    cii: number;
    measuredChange: number;
    sustainability: number;
    manualEvidence: number;
  };
}

/** Shape the AI actually returns — anchors/narrative only, no score fields. */
export interface CiiV45EvaluatorPayload {
  frameworkVersion: '4.5' | '5.0';
  reportId: string;
  inputFingerprint: string;
  inputCompleteness: CiiV45InputCompleteness;
  claimInventory: CiiV45Claim[];
  evidenceAudit: CiiV45EvidenceAudit[];
  sectionScores: CiiV45SectionScore[];
  deductionLedger: CiiV45DeductionLedgerEntry[];
  extraMileUplift: CiiV45ExtraMileUplift;
  extraMileCandidates?: CiiV45UpliftItem[];
  sectionAnalyses?: Array<{
    dimension: Exclude<CiiV45Dimension, '7'>;
    summary: string;
    strengths: string[];
    limitations: string[];
    adminFlags: string[];
  }>;
  integrityPenalty: CiiV45IntegrityPenalty;
  exceptionalFeature: CiiV45ExceptionalFeature | null;
  adminEvidenceAssessment?: CiiV45AdminEvidenceAssessment;
  /** R3 only: Admin criterion mark edits (absent on R1/R2 analyses and on a fresh AI run). */
  adminModeration?: CiiV45AdminModeration;
  /** R3 only: the Admin's L6 sustained-impact confirmations (supplied at approval). */
  l6Qualification?: CiiV45L6Confirmations;
  adminReviewReasons: string[];
  strengths: string[];
  developmentPriorities: string[];
  analysisSummary: string;
  evidenceSummary: string;
  studentFeedback: string;
}

export type CiiV45ScoreStatus =
  | 'RESUBMISSION_REQUIRED'
  | 'ADMIN_REVIEW_REQUIRED'
  | 'ADMIN_EVIDENCE_REQUIRED'
  | 'FINAL';

export interface CiiV45Band {
  level: number;
  min: number;
  max: number;
  name: string;
  assetKey: string;
}

export interface CiiV45Badge extends CiiV45Band {
  code: string;
  numericLevel: number;
  gateCapped: boolean;
}

export interface CiiV45CriterionResult extends CiiV45CriterionScore {
  maximumPoints: number;
  score: number | null;
  /** R3 only: the mark the AI anchor earns, kept when an Admin edit replaces `score`. */
  aiScore?: number | null;
  /** R3 only: true when `score` is an Admin-reviewed mark rather than the AI mark. */
  adminEdited?: boolean;
  adminEdit?: {
    reason: string;
    sourceRef?: string | null;
    actorId: string;
    at: string;
  };
}

export interface CiiV45SectionResult {
  dimension: CiiV45Dimension;
  name: string;
  maximumPoints: number;
  criterionScores: CiiV45CriterionResult[];
  /** null if any criterion in this dimension is pending ('P'). */
  score: number | null;
  /** Sum of known (non-pending) criteria, even when `score` is null. */
  knownPoints: number;
}

export interface CiiV45Result extends Omit<
  CiiV45EvaluatorPayload,
  'sectionScores' | 'extraMileUplift'
> {
  sectionScores: CiiV45SectionResult[];
  knownBasePoints: number;
  /** Weighted sum of the nine AI report-quality dimensions (max 85). */
  aiReportScore: number | null;
  /** Weighted sum of Admin Dimension 7 (max 15). */
  adminEvidenceScore: number | null;
  baseCII: number | null;
  extraMileUplift: CiiV45ExtraMileUplift;
  adminEvidenceAssessment: CiiV45AdminEvidenceAssessment;
  diagnosticCII: number | null;
  scoreStatus: CiiV45ScoreStatus;
  needsAdminReview: boolean;
  finalCII: number | null;
  recommendedBadge: CiiV45Badge | null;
  diagnosticBadge: CiiV45Badge | null;
  finalBadge: CiiV45Badge | null;
  qualityGates: { L4: boolean; L5: boolean; L6: boolean };
  publicationEligible: boolean;
  /** Dimension table the sections were scored against (R3 current; R2 / R1 for older payloads). */
  rubricVersion?: string;
  /** R3 only: the band the numeric CII lands in, whether or not it is yet awarded. */
  candidateBadge?: CiiV45Badge | null;
  /** R3 only: `L6_PENDING_QUALIFICATION` = a 90+ CII retained without an L6 award yet. */
  badgeStatus?: 'AWARDED' | 'L6_PENDING_QUALIFICATION' | null;
  /** R3 only: the L6 qualification check behind `badgeStatus`. */
  l6Assessment?: CiiV45L6Assessment;
  /** R3 only: the AI's own proposal total before any Admin criterion edits (null while any criterion is pending). */
  aiProposalScore?: number | null;
  /** R3 only: true when at least one Admin criterion mark is in force. */
  moderated?: boolean;
  rounding: string;
}

/** 0=Missing, 1=Basic, 2=Sound, 3=Strong, 4=Exceptional. */
export const CII_V45_ANCHOR_FACTORS = [0, 0.5, 0.7, 0.85, 1] as const;

export interface CiiV45CriterionDef {
  key: string;
  weight: number;
}

export interface CiiV45DimensionDef {
  id: CiiV45Dimension;
  name: string;
  maxPoints: number;
  criteria: CiiV45CriterionDef[];
}

/**
 * R2 dimension table (CIEL-CII-2026.11-R2, as first deployed): Dimension 6 / 9 re-cut, every other
 * dimension on its original criteria. Kept verbatim so analyses stored under it (unapproved
 * drafts, locks) still score and approve exactly as before; new AI runs use `CII_V45_DIMENSIONS`.
 */
export const CII_V45_R2_DIMENSIONS: CiiV45DimensionDef[] = [
  {
    id: '1',
    name: 'Participation & Individual Effort',
    maxPoints: 10,
    criteria: [
      { key: 'role', weight: 2.5 },
      { key: 'quality', weight: 2.5 },
      { key: 'hoursCompletion', weight: 2.5 },
      { key: 'continuity', weight: 2.5 },
    ],
  },
  {
    id: '2',
    name: 'Community Need & Starting Point',
    maxPoints: 10,
    criteria: [
      { key: 'specificity', weight: 2 },
      { key: 'communityGrounding', weight: 2 },
      { key: 'baseline', weight: 2 },
      { key: 'context', weight: 2 },
      { key: 'discipline', weight: 2 },
    ],
  },
  {
    id: '3',
    name: 'SDG Contribution',
    maxPoints: 5,
    criteria: [
      { key: 'alignment', weight: 2.5 },
      { key: 'logic', weight: 1.5 },
      { key: 'coherence', weight: 0.5 },
      { key: 'focus', weight: 0.5 },
    ],
  },
  {
    id: '4A',
    name: 'Activities & Outputs',
    maxPoints: 15,
    criteria: [
      { key: 'delivery', weight: 3 },
      { key: 'rigor', weight: 3 },
      { key: 'ownership', weight: 3 },
      { key: 'outputQuality', weight: 3 },
      { key: 'appropriateScale', weight: 3 },
    ],
  },
  {
    id: '4B',
    name: 'Outcomes & Measured Change',
    maxPoints: 15,
    criteria: [
      { key: 'clarity', weight: 3 },
      { key: 'change', weight: 4 },
      { key: 'measurement', weight: 3 },
      { key: 'communityValue', weight: 3 },
      { key: 'attribution', weight: 2 },
    ],
  },
  {
    id: '5',
    name: 'Resources & Stewardship',
    maxPoints: 10,
    criteria: [
      { key: 'stewardship', weight: 2.5 },
      { key: 'traceability', weight: 2.5 },
      { key: 'appropriateness', weight: 2.5 },
      { key: 'deliveryContribution', weight: 2.5 },
    ],
  },
  {
    id: '6',
    name: 'Partnership & Collaboration',
    maxPoints: 5,
    criteria: [
      { key: 'activeRole', weight: 2 },
      { key: 'reciprocity', weight: 2 },
      { key: 'feedbackLearning', weight: 1 },
    ],
  },
  {
    id: '7',
    name: 'Evidence, Ethics & Verification',
    maxPoints: 15,
    criteria: [
      { key: 'participation', weight: 2 },
      { key: 'activities', weight: 3 },
      { key: 'reach', weight: 2 },
      { key: 'outcomes', weight: 3 },
      { key: 'resourcesPartners', weight: 2 },
      { key: 'ethics', weight: 2 },
      { key: 'coverage', weight: 1 },
    ],
  },
  {
    id: '8',
    name: 'Reflection & Academic Growth',
    maxPoints: 5,
    criteria: [
      { key: 'learning', weight: 1.5 },
      { key: 'academicApplication', weight: 1 },
      { key: 'ethicalUnderstanding', weight: 1 },
      { key: 'improvement', weight: 1.5 },
    ],
  },
  {
    id: '9',
    name: 'Sustainability & Handover',
    maxPoints: 10,
    criteria: [
      { key: 'retainedBenefits', weight: 2 },
      { key: 'ownershipHandover', weight: 2 },
      { key: 'maintenanceFeasibility', weight: 1 },
      { key: 'followUpRetention', weight: 3 },
      { key: 'adaptationReplication', weight: 2 },
    ],
  },
];

/**
 * Current rubric (CIEL-CII-2026.11-R3): the full 45-criterion table of the R3 analyser — 38 AI
 * report-quality criteria (85) + 7 Admin evidence criteria (15). Dimension maxima, the 85 + 15
 * split, the anchor factors and the six bands are unchanged from R2; what changes is how the
 * seven AI dimensions other than 6 and 9 are cut into criteria, and the badge policy
 * (`CII_V45_L6_POLICY`). Criterion IDs are exact and immutable.
 */
export const CII_V45_DIMENSIONS: CiiV45DimensionDef[] = [
  {
    id: '1',
    name: 'Participation & Individual Effort',
    maxPoints: 10,
    criteria: [
      { key: 'hoursRequirement', weight: 4 },
      { key: 'attendanceValidity', weight: 2 },
      { key: 'contributionAgency', weight: 2 },
      { key: 'participationAccount', weight: 2 },
    ],
  },
  {
    id: '2',
    name: 'Community Need & Starting Point',
    maxPoints: 10,
    criteria: [
      { key: 'needAndVoice', weight: 3 },
      { key: 'startingPosition', weight: 2 },
      { key: 'objectivesPathway', weight: 3 },
      { key: 'inclusionSafeguarding', weight: 2 },
    ],
  },
  {
    id: '3',
    name: 'SDG Contribution',
    maxPoints: 5,
    criteria: [
      { key: 'sdgConnection', weight: 2 },
      { key: 'outcomeLinkedContribution', weight: 2 },
      { key: 'boundedClaims', weight: 1 },
    ],
  },
  {
    id: '4A',
    name: 'Activities & Outputs',
    maxPoints: 15,
    criteria: [
      { key: 'completedDelivery', weight: 4 },
      { key: 'outputsUnits', weight: 4 },
      { key: 'reachDeduplication', weight: 4 },
      { key: 'equitableAccess', weight: 3 },
    ],
  },
  {
    id: '4B',
    name: 'Measured Change',
    maxPoints: 15,
    criteria: [
      { key: 'observedChange', weight: 4 },
      { key: 'objectiveAttainment', weight: 2 },
      { key: 'measurementQuality', weight: 3 },
      { key: 'credibleContribution', weight: 2 },
      { key: 'communityConfirmation', weight: 2 },
      { key: 'evaluationImprovement', weight: 2 },
    ],
  },
  {
    id: '5',
    name: 'Resources & Stewardship',
    maxPoints: 10,
    criteria: [
      { key: 'resourceAccount', weight: 3 },
      { key: 'arithmeticTraceability', weight: 2 },
      { key: 'proportionateAllocation', weight: 2 },
      { key: 'resourceEfficiency', weight: 2 },
      { key: 'responsibleMaterials', weight: 1 },
    ],
  },
  // Partnership & Collaboration (5), Evidence (15, Admin) and Sustainability (10) are exactly the
  // R2 dimensions.
  ...CII_V45_R2_DIMENSIONS.filter((d) => ['6', '7'].includes(d.id)),
  {
    id: '8',
    name: 'Reflection & Academic Growth',
    maxPoints: 5,
    criteria: [
      { key: 'personalCivicLearning', weight: 2 },
      { key: 'academicApplication', weight: 1 },
      { key: 'competencyDevelopment', weight: 1 },
      { key: 'ethicalJudgement', weight: 1 },
    ],
  },
  ...CII_V45_R2_DIMENSIONS.filter((d) => d.id === '9'),
];

/**
 * Rubric versions. R3 is current. R2 (CIEL-CII-2026.11-R2) re-cut Dimensions 6 and 9 only; R1
 * (CIEL-CII-2026.10-R1) is the original table. Analyses stored under an older rubric keep scoring
 * under it, with its original gate-based badge rule (see `resolveCiiV45Rubric`).
 */
export const CII_V45_RUBRIC_VERSION = 'CIEL-CII-2026.11-R3' as const;
export const CII_V45_R2_RUBRIC_VERSION = 'CIEL-CII-2026.11-R2' as const;
export const CII_V45_LEGACY_RUBRIC_VERSION = 'CIEL-CII-2026.10-R1' as const;

/**
 * R3 badge policy: the final CII alone picks the band; a 90+ candidate is awarded L6 only after
 * these numeric minima and the Admin's three sourced confirmations. Without them the CII is kept
 * and L6 stays pending: the badge is never silently downgraded to L5.
 */
export const CII_V45_L6_POLICY = {
  version: 'CIEL-BADGES-2026.11-R2',
  minimumCii: 90,
  minimumMeasuredChange: 12,
  minimumSustainability: 8,
  minimumManualEvidence: 12,
} as const;

/**
 * R1 shape of the two re-cut dimensions. Analyses stored before R2 (unapproved drafts, locks,
 * independent runs) carry these criterion keys; `computeCiiV45Result` scores them against this
 * table so an Admin can still approve a pre-R2 draft and a re-read of an old lock reproduces
 * the same number.
 */
export const CII_V45_LEGACY_DIMENSIONS_R1: CiiV45DimensionDef[] =
  CII_V45_R2_DIMENSIONS.map((dim) => {
    if (dim.id === '6') {
      return {
        ...dim,
        maxPoints: 10,
        criteria: [
          { key: 'relevance', weight: 2.5 },
          { key: 'roleClarity', weight: 2.5 },
          { key: 'collaboration', weight: 2.5 },
          { key: 'ownership', weight: 2.5 },
        ],
      };
    }
    if (dim.id === '9') {
      return {
        ...dim,
        maxPoints: 5,
        criteria: [
          { key: 'continuation', weight: 1.5 },
          { key: 'owner', weight: 1.5 },
          { key: 'handover', weight: 1.5 },
          { key: 'realism', weight: 0.5 },
        ],
      };
    }
    return dim;
  });

export type CiiV45BadgePolicy = 'GATES' | 'L6_QUALIFICATION';

type SectionKeysView = ReadonlyArray<{
  dimension: string;
  criterionScores?: ReadonlyArray<{ criterion: string }>;
}>;

/**
 * Picks the dimension table (and with it the badge rule) a stored/incoming payload was scored
 * against, from the criterion keys it carries:
 *  - R1: Dimension 6 or 9 still has its original keys;
 *  - R2: Dimension 6/9 are re-cut but one of the other dimensions still has its R2 keys;
 *  - R3 (current): everything else, including a payload whose sections are missing (the caller's
 *    validation reports that).
 * R1 and R2 keep the cumulative quality-gate badge rule they were approved under; R3 uses the L6
 * qualification policy.
 */
export function resolveCiiV45Rubric(sectionScores: SectionKeysView): {
  version: string;
  dimensions: CiiV45DimensionDef[];
  badgePolicy: CiiV45BadgePolicy;
} {
  const keysOf = (id: string): string[] =>
    (sectionScores.find((s) => s.dimension === id)?.criterionScores ?? []).map(
      (c) => c.criterion,
    );
  const sameSet = (a: string[], b: string[]): boolean =>
    a.length === b.length && a.every((k) => b.includes(k));
  const matches = (table: CiiV45DimensionDef[], id: string): boolean => {
    const keys = keysOf(id);
    if (!keys.length) return false;
    const def = table.find((d) => d.id === id);
    return (
      !!def &&
      sameSet(
        keys,
        def.criteria.map((c) => c.key),
      )
    );
  };
  if (
    matches(CII_V45_LEGACY_DIMENSIONS_R1, '6') ||
    matches(CII_V45_LEGACY_DIMENSIONS_R1, '9')
  ) {
    return {
      version: CII_V45_LEGACY_RUBRIC_VERSION,
      dimensions: CII_V45_LEGACY_DIMENSIONS_R1,
      badgePolicy: 'GATES',
    };
  }
  if (
    ['1', '2', '3', '4A', '4B', '5', '8'].some((id) =>
      matches(CII_V45_R2_DIMENSIONS, id),
    )
  ) {
    return {
      version: CII_V45_R2_RUBRIC_VERSION,
      dimensions: CII_V45_R2_DIMENSIONS,
      badgePolicy: 'GATES',
    };
  }
  return {
    version: CII_V45_RUBRIC_VERSION,
    dimensions: CII_V45_DIMENSIONS,
    badgePolicy: 'L6_QUALIFICATION',
  };
}

/** The six bands that apply to a score (no gate walk). */
function bandForCii(score: number | null): CiiV45Band | null {
  return score === null
    ? null
    : [...CII_V45_BANDS].reverse().find((b) => score >= b.min) || null;
}

function badgeFromBand(band: CiiV45Band, numeric: CiiV45Band): CiiV45Badge {
  return {
    ...band,
    code: `L${band.level}`,
    numericLevel: numeric.level,
    gateCapped: band.level !== numeric.level,
  };
}

/**
 * R3 L6 qualification: a 90+ CII is awarded L6 only when the numeric minima hold and the Admin
 * has confirmed observed retention, community ownership/adoption and corroboration from outside
 * the student team against a named source. Anything below 90 never needs it.
 */
export function assessCiiV45L6(
  score: number | null,
  sections: ReadonlyArray<{
    dimension: string;
    score: number | null;
    knownPoints?: number;
  }>,
  confirmations?: CiiV45L6Confirmations | null,
): CiiV45L6Assessment {
  const P = CII_V45_L6_POLICY;
  const minimums = {
    cii: P.minimumCii,
    measuredChange: P.minimumMeasuredChange,
    sustainability: P.minimumSustainability,
    manualEvidence: P.minimumManualEvidence,
  };
  if (score === null || score < P.minimumCii) {
    return { status: 'NOT_REQUIRED', reasons: [], minimums };
  }
  const pts = (id: string): number =>
    sections.find((s) => s.dimension === id)?.score ?? 0;
  const reasons: string[] = [];
  if (pts('4B') < P.minimumMeasuredChange)
    reasons.push(`Measured Change below ${P.minimumMeasuredChange}/15`);
  if (pts('9') < P.minimumSustainability)
    reasons.push(`Sustainability below ${P.minimumSustainability}/10`);
  if (pts('7') < P.minimumManualEvidence)
    reasons.push(`Manual evidence below ${P.minimumManualEvidence}/15`);
  if (confirmations?.observedRetention !== true)
    reasons.push('Observed retained benefits not confirmed');
  if (confirmations?.communityOwnership !== true)
    reasons.push('Community ownership or adoption not confirmed');
  if (confirmations?.externalCorroboration !== true)
    reasons.push('Corroboration outside the student team not confirmed');
  if (!String(confirmations?.sourceRef ?? '').trim())
    reasons.push('Qualification source reference missing');
  return {
    status: reasons.length ? 'PENDING_QUALIFICATION' : 'QUALIFIED',
    reasons,
    minimums,
  };
}

/**
 * R3 badge: the numeric band is the candidate; L6 is only awarded when qualified. A 90+ candidate
 * without qualification returns `badge: null` with status `L6_PENDING_QUALIFICATION` (the CII is
 * kept, L6 is withheld, never replaced by L5).
 */
export function resolveCiiV45BadgeR3(
  score: number | null,
  l6Qualified: boolean,
): {
  badge: CiiV45Badge | null;
  candidate: CiiV45Badge | null;
  status: 'AWARDED' | 'L6_PENDING_QUALIFICATION' | null;
} {
  const numeric = bandForCii(score);
  if (!numeric) return { badge: null, candidate: null, status: null };
  const candidate = badgeFromBand(numeric, numeric);
  if (numeric.level === 6 && !l6Qualified) {
    return { badge: null, candidate, status: 'L6_PENDING_QUALIFICATION' };
  }
  return { badge: candidate, candidate, status: 'AWARDED' };
}

/** Admin criterion edits are valid only for R3 analyses, within the criterion maximum, 2 decimals. */
function validateModerationEdit(
  key: string,
  edit: CiiV45AdminCriterionEdit,
  weight: number,
): void {
  const cents = edit.points * 100;
  if (
    typeof edit.points !== 'number' ||
    !Number.isFinite(edit.points) ||
    edit.points < 0 ||
    edit.points > weight ||
    Math.abs(cents - Math.round(cents)) > 1e-6
  ) {
    fail(
      `Moderated mark for ${key} must be between 0 and ${weight}, with at most two decimals.`,
    );
  }
  if (
    typeof edit.reason !== 'string' ||
    !edit.reason.trim() ||
    !edit.actorId ||
    !edit.at
  ) {
    fail(`Moderated mark for ${key} needs a reason, an actor and a timestamp.`);
  }
}

export const CII_V45_BASE_MAX = CII_V45_DIMENSIONS.reduce(
  (sum, d) => sum + d.maxPoints,
  0,
); // 100
export const CII_V45_BONUS_MAX = 5;
export const CII_V45_MAX = 100;
export const CII_V45_FRAMEWORK_VERSION = '5.0' as const;
export const CII_V45_AI_DIMENSIONS = CII_V45_DIMENSIONS.filter(
  (d) => d.id !== '7',
);
export const CII_V45_EVIDENCE_DIMENSION = CII_V45_DIMENSIONS.find(
  (d) => d.id === '7',
)!;
export const CII_V45_AI_REPORT_MAX = CII_V45_AI_DIMENSIONS.reduce(
  (sum, d) => sum + d.maxPoints,
  0,
); // 85
export const CII_V45_ADMIN_EVIDENCE_MAX = CII_V45_EVIDENCE_DIMENSION.maxPoints; // 15

/** Six contiguous locked bands (CIEL PK CII v5.0 badge manifest — same cut-points as v4.5). */
export const CII_V45_BANDS: CiiV45Band[] = [
  {
    level: 1,
    min: 0,
    max: 49,
    name: 'Participation Acknowledgement',
    assetKey: 'L1',
  },
  {
    level: 2,
    min: 50,
    max: 59,
    name: 'Foundation Stage Contributor',
    assetKey: 'L2',
  },
  {
    level: 3,
    min: 60,
    max: 69,
    name: 'Emerging Community Contributor',
    assetKey: 'L3',
  },
  {
    level: 4,
    min: 70,
    max: 79,
    name: 'Developing Impact Contributor',
    assetKey: 'L4',
  },
  {
    level: 5,
    min: 80,
    max: 89,
    name: 'Distinguished Impact Contributor',
    assetKey: 'L5',
  },
  {
    level: 6,
    min: 90,
    max: 100,
    name: 'Transformative Impact Contributor',
    assetKey: 'L6',
  },
];

/** Round to 1 decimal place (matches `cii-calculator.js`'s `round`). */
function round1(value: number): number {
  return Math.round((value + 1e-9) * 10) / 10;
}

function isValidAnchor(value: unknown): value is CiiV45Anchor {
  return (
    value === 'P' ||
    (Number.isInteger(value) &&
      (value as number) >= 0 &&
      (value as number) <= 4)
  );
}

const VERIFICATION_STATUSES: CiiV45VerificationStatus[] = [
  'VERIFIED',
  'SYSTEM_VERIFIED',
  'AI_REPORT',
  'ADMIN_VERIFIED',
  'NARRATIVE_ONLY',
  'PROCESSING_REQUIRED',
  'NOT_APPLICABLE',
  'CONTRADICTED',
];
const UPLIFT_CATEGORIES: CiiV45UpliftCategory[] = [
  'effort',
  'resources',
  'partnerships',
  'outcomes',
];

const CII_V45_ANCHOR_NAMES = [
  'Missing',
  'Basic',
  'Sound',
  'Strong',
  'Exceptional',
] as const;

export function defaultAdminEvidenceRationale(
  criterion: string,
  anchor: Exclude<CiiV45Anchor, 'P'>,
): string {
  const label = CII_V45_ANCHOR_NAMES[anchor] ?? String(anchor);
  return `CIEL PK Admin assigned Anchor ${anchor} (${label}) for ${criterion} after reviewing original evidence.`;
}

/** Seven Dimension-7 rows. Missing/invalid Admin marks default to Sound (2) so Confirm can publish. */
export function completeAdminEvidenceCriteria(
  raw?: Array<{
    criterion: string;
    anchor: 0 | 1 | 2 | 3 | 4;
    reasoningSummary?: string;
    evidenceIds?: string[];
  }>,
): Array<{
  criterion: string;
  anchor: Exclude<CiiV45Anchor, 'P'>;
  reasoningSummary?: string;
  evidenceIds?: string[];
}> {
  const byKey = new Map(
    (Array.isArray(raw) ? raw : []).map((row) => [row.criterion, row]),
  );
  return CII_V45_EVIDENCE_DIMENSION.criteria.map(({ key }) => {
    const row = byKey.get(key);
    const anchor =
      row && Number.isInteger(row.anchor) && row.anchor >= 0 && row.anchor <= 4
        ? row.anchor
        : 2;
    return {
      criterion: key,
      anchor,
      reasoningSummary: row?.reasoningSummary,
      evidenceIds: row?.evidenceIds,
    };
  });
}

function aliasAiCriterionKey(key: string): string {
  const compact = key.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
  // Older AI payloads / prompts called the hours criterion hoursConsistency or hoursCompletion.
  if (
    compact === 'hoursconsistency' ||
    compact === 'hourscompletion' ||
    compact === 'hoursrequirement'
  )
    return 'hoursRequirement';
  return key;
}

function normalizeAiDimensionId(value: unknown): string {
  const raw = String((value ?? '') as { toString(): string }).trim();
  const match = raw.match(/^(?:dimension\s*)?(4A|4B|[1-9])$/i);
  return match ? match[1].toUpperCase() : raw;
}

function asScoreRow(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function aiCriterionRows(section: unknown): Record<string, unknown>[] {
  const rec = asScoreRow(section);
  const raw = rec.criterionScores ?? rec.criteria ?? rec.scores;
  return Array.isArray(raw) ? raw.map(asScoreRow) : [];
}

function pickAiCriterionKey(row: Record<string, unknown>): string {
  return aliasAiCriterionKey(
    String(
      (row.criterion ??
        row.key ??
        row.id ??
        row.criterionId ??
        row.name ??
        '') as { toString(): string },
    ),
  );
}

function pickAiAnchor(
  row: Record<string, unknown>,
  fallback?: CiiV45Anchor | null,
): CiiV45Anchor | null {
  return (
    coerceAiAnchor(row.anchor) ??
    coerceAiAnchor(row.qualityAnchor) ??
    coerceAiAnchor(row.score) ??
    coerceAiAnchor(row.rating) ??
    fallback ??
    null
  );
}

export function pendingDimension7Section(): CiiV45SectionScore {
  return {
    dimension: '7',
    criterionScores: CII_V45_EVIDENCE_DIMENSION.criteria.map(({ key }) => ({
      criterion: key,
      anchor: 'P',
      qualityAnchor: 'P',
      verificationStatus: 'PROCESSING_REQUIRED',
      sourceRefs: [],
      evidenceIds: [],
      reasoningSummary: 'Pending CIEL PK Admin evidence assessment.',
    })),
  };
}

function compactReasoning(value: unknown): string {
  const text =
    typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  if (!text) return 'AI report-quality judgement.';
  return text.length > 180 ? `${text.slice(0, 177).trimEnd()}…` : text;
}

function omittedAiCriterion(key: string): CiiV45CriterionScore {
  return {
    criterion: key,
    anchor: 'P',
    qualityAnchor: 'P',
    verificationStatus: 'PROCESSING_REQUIRED',
    sourceRefs: [],
    evidenceIds: [],
    reasoningSummary:
      'AI omitted this criterion; Admin should confirm from the saved report.',
  };
}

function coerceAiAnchor(value: unknown): CiiV45Anchor | null {
  if (value === 'P' || value === 'p') return 'P';
  const n = typeof value === 'string' && value.trim() ? Number(value) : value;
  if (Number.isInteger(n) && (n as number) >= 0 && (n as number) <= 4) {
    return n as 0 | 1 | 2 | 3 | 4;
  }
  return null;
}

function coerceAiSectionScores(raw: CiiV45SectionScore[] | undefined): {
  sections: CiiV45SectionScore[];
  omittedKeys: string[];
} {
  const rows = Array.isArray(raw) ? raw : [];
  const omittedKeys: string[] = [];
  const sections = CII_V45_AI_DIMENSIONS.map((dim) => {
    const section = rows.find(
      (s) => normalizeAiDimensionId(s.dimension) === dim.id,
    );
    const list = aiCriterionRows(section);
    const byKey = new Map<string, Record<string, unknown>>();
    for (const row of list) {
      const mapped = pickAiCriterionKey(row);
      if (mapped && mapped !== 'undefined' && mapped !== 'null') {
        byKey.set(mapped, row);
      }
    }
    return {
      dimension: dim.id,
      criterionScores: dim.criteria.map(({ key }, index) => {
        const c =
          byKey.get(key) ??
          (list.length === dim.criteria.length ? list[index] : undefined);
        if (!c) {
          omittedKeys.push(`${dim.id}.${key}`);
          return omittedAiCriterion(key);
        }
        const anchor = pickAiAnchor(c) ?? 'P';
        const quality = pickAiAnchor(c, anchor) ?? anchor;
        const statusRaw = c.verificationStatus;
        const status = VERIFICATION_STATUSES.includes(statusRaw as never)
          ? (statusRaw as (typeof VERIFICATION_STATUSES)[number])
          : 'AI_REPORT';
        return {
          criterion: key,
          anchor,
          qualityAnchor: quality === 'P' ? anchor : quality,
          verificationStatus: status === 'VERIFIED' ? 'AI_REPORT' : status,
          sourceRefs: Array.isArray(c.sourceRefs)
            ? (c.sourceRefs as string[])
            : [],
          evidenceIds: [],
          reasoningSummary: compactReasoning(
            c.reasoningSummary ?? c.reasoning ?? c.rationale,
          ),
          deductionReason: (c.deductionReason as string | null) ?? null,
        };
      }),
    };
  });
  return { sections, omittedKeys };
}

/** Forces an AI evaluator payload onto the v5.0 hybrid contract (9 quality dims, D7 pending). */
export function normalizeCiiV5AiPayload(
  raw: CiiV45EvaluatorPayload,
): CiiV45EvaluatorPayload {
  const extras = raw.extraMileUplift;
  const candidates = Array.isArray(extras?.items) ? extras.items : [];
  const { sections, omittedKeys } = coerceAiSectionScores(raw.sectionScores);
  const reasons = Array.isArray(raw.adminReviewReasons)
    ? [...raw.adminReviewReasons]
    : [];
  if (omittedKeys.length) {
    const note = `AI omitted criteria: ${omittedKeys.join(', ')}. Confirm from the saved report.`;
    if (!reasons.includes(note)) reasons.push(note);
  }
  return {
    ...raw,
    frameworkVersion: CII_V45_FRAMEWORK_VERSION,
    claimInventory: Array.isArray(raw.claimInventory) ? raw.claimInventory : [],
    evidenceAudit: Array.isArray(raw.evidenceAudit) ? raw.evidenceAudit : [],
    deductionLedger: Array.isArray(raw.deductionLedger)
      ? raw.deductionLedger
      : [],
    adminReviewReasons: reasons,
    sectionScores: [...sections, pendingDimension7Section()],
    extraMileUplift: { assessmentStatus: 'PENDING_ADMIN', items: [] },
    extraMileCandidates: Array.isArray(raw.extraMileCandidates)
      ? raw.extraMileCandidates
      : candidates,
    sectionAnalyses: Array.isArray(raw.sectionAnalyses)
      ? raw.sectionAnalyses
      : [],
    integrityPenalty: { points: 0, issues: [] },
    exceptionalFeature: raw.exceptionalFeature
      ? { ...raw.exceptionalFeature, adminVerified: false }
      : null,
    adminEvidenceAssessment: { status: 'PENDING' },
  };
}

export function applyAdminEvidenceAssessment(
  payload: CiiV45EvaluatorPayload,
  input: {
    assessorId: string;
    assessedAt: string;
    criteria: Array<{
      criterion: string;
      anchor: Exclude<CiiV45Anchor, 'P'>;
      reasoningSummary?: string;
      evidenceIds?: string[];
    }>;
    extraMile?: CiiV45ExtraMileUplift;
    exceptionalFeature?: CiiV45ExceptionalFeature | null;
  },
): CiiV45EvaluatorPayload {
  if (
    !Array.isArray(input.criteria) ||
    input.criteria.length !== CII_V45_EVIDENCE_DIMENSION.criteria.length
  ) {
    fail('Complete Admin evidence assessment required.');
  }
  const dim7Section: CiiV45SectionScore = {
    dimension: '7',
    criterionScores: CII_V45_EVIDENCE_DIMENSION.criteria.map(({ key }) => {
      const a = input.criteria.find((c) => c.criterion === key);
      if (!a) {
        fail('Dimension 7 must match the saved Admin evidence assessment.');
      }
      const reasoning =
        typeof a.reasoningSummary === 'string' && a.reasoningSummary.trim()
          ? a.reasoningSummary.trim()
          : defaultAdminEvidenceRationale(key, a.anchor);
      return {
        criterion: key,
        anchor: a.anchor,
        qualityAnchor: a.anchor,
        verificationStatus: 'ADMIN_VERIFIED' as const,
        sourceRefs: ['admin_evidence_assessment'],
        evidenceIds: Array.isArray(a.evidenceIds) ? a.evidenceIds : [],
        reasoningSummary: reasoning,
      };
    }),
  };
  const extras = input.extraMile ?? payload.extraMileUplift;
  const extraMileUplift: CiiV45ExtraMileUplift =
    extras?.assessmentStatus === 'ASSESSED'
      ? extras
      : { assessmentStatus: 'ASSESSED', items: [] };
  return {
    ...payload,
    frameworkVersion: CII_V45_FRAMEWORK_VERSION,
    sectionScores: [
      ...payload.sectionScores.filter((s) => s.dimension !== '7'),
      dim7Section,
    ],
    extraMileUplift,
    exceptionalFeature:
      input.exceptionalFeature !== undefined
        ? input.exceptionalFeature
        : payload.exceptionalFeature,
    adminEvidenceAssessment: {
      status: 'ASSESSED',
      assessorId: input.assessorId,
      assessedAt: input.assessedAt,
      criteria: dim7Section.criterionScores.map((c) => ({
        criterion: c.criterion,
        anchor: c.anchor as Exclude<CiiV45Anchor, 'P'>,
        reasoningSummary: c.reasoningSummary,
        evidenceIds: c.evidenceIds,
      })),
    },
  };
}

/**
 * Deterministically computes the full CII v5.0 Hybrid result from anchors only
 * (no numeric score fields). Ported from `cii-calculator.js` v5.0. Throws
 * `CiiV45ValidationError` on any structural violation.
 */
/**
 * Maps a (possibly null) score onto the six locked bands and walks the badge down to the
 * highest level whose cumulative quality gate actually passes — shared by `computeCiiV45Result`
 * and the admin moderation path (`persistCiiV45Approval`) so a moderated score is re-graded
 * through the exact same gate-capping logic, never a second hand-rolled walk.
 */
export function resolveBadgeForScore(
  score: number | null,
  qualityGates: { L4: boolean; L5: boolean; L6: boolean } | undefined,
): CiiV45Badge | null {
  const numeric =
    score === null
      ? null
      : [...CII_V45_BANDS].reverse().find((b) => score >= b.min) || null;
  let badge: CiiV45Band | null = numeric;
  const gates = qualityGates ?? { L4: false, L5: false, L6: false };
  while (
    badge &&
    badge.level >= 4 &&
    !gates[`L${badge.level}` as 'L4' | 'L5' | 'L6']
  ) {
    badge = CII_V45_BANDS.find((b) => b.level === badge!.level - 1) || null;
  }
  return badge
    ? {
        ...badge,
        code: `L${badge.level}`,
        numericLevel: numeric!.level,
        gateCapped: badge.level !== numeric!.level,
      }
    : null;
}

export function computeCiiV45Result(
  payload: CiiV45EvaluatorPayload,
): CiiV45Result {
  const p = payload;
  if (p.frameworkVersion !== '5.0') fail('Expected frameworkVersion 5.0.');
  if (!p.reportId || !p.inputFingerprint)
    fail('Report ID and input fingerprint required.');
  if (!Array.isArray(p.sectionScores) || p.sectionScores.length !== 10) {
    fail('Exactly ten analytical dimensions required.');
  }

  // Pre-R2 payloads (old criterion keys in Dim 6 / 9) are scored against the R1 table they were
  // produced with; everything new is scored against the current rubric.
  const rubric = resolveCiiV45Rubric(p.sectionScores);
  const r3 = rubric.badgePolicy === 'L6_QUALIFICATION';
  const moderationEdits = p.adminModeration?.edits ?? {};
  if (!r3 && Object.keys(moderationEdits).length) {
    fail(
      'Criterion mark moderation requires the R3 rubric. Re-run the analysis.',
    );
  }
  const sections: CiiV45SectionResult[] = rubric.dimensions.map((dim) => {
    const matches = p.sectionScores.filter((s) => s.dimension === dim.id);
    if (matches.length !== 1) fail(`Missing/duplicate dimension ${dim.id}`);
    const s = matches[0];
    if (
      !Array.isArray(s.criterionScores) ||
      s.criterionScores.length !== dim.criteria.length
    ) {
      fail(`Invalid criterion count ${dim.id}`);
    }
    let sum = 0;
    let pending = false;
    const criterionResults: CiiV45CriterionResult[] = dim.criteria.map(
      ({ key: cid, weight: w }) => {
        const cMatches = s.criterionScores.filter((c) => c.criterion === cid);
        if (cMatches.length !== 1)
          fail(`Missing/duplicate criterion ${dim.id}.${cid}`);
        const c = cMatches[0];
        if (!isValidAnchor(c.anchor)) fail(`Invalid anchor ${dim.id}.${cid}`);
        if (!isValidAnchor(c.qualityAnchor))
          fail(`Invalid quality anchor ${dim.id}.${cid}`);
        if (
          typeof c.reasoningSummary !== 'string' ||
          !c.reasoningSummary.trim() ||
          !Array.isArray(c.sourceRefs) ||
          !Array.isArray(c.evidenceIds)
        ) {
          fail(
            `Auditable rationale / source / evidence arrays required ${dim.id}.${cid}`,
          );
        }
        if (!VERIFICATION_STATUSES.includes(c.verificationStatus)) {
          fail('Invalid verification status');
        }
        const aiScore =
          c.anchor === 'P' ? null : w * CII_V45_ANCHOR_FACTORS[c.anchor];
        const edit = r3 ? moderationEdits[`${dim.id}.${cid}`] : undefined;
        if (edit) validateModerationEdit(`${dim.id}.${cid}`, edit, w);
        // An Admin-reviewed mark replaces the AI mark in the total (and resolves a pending
        // criterion); the AI anchor and its mark stay on the criterion as the baseline.
        const score = edit ? edit.points : aiScore;
        if (score === null) pending = true;
        if (score !== null) sum = Math.round((sum + score) * 10000) / 10000;
        const {
          aiScore: _a,
          adminEdited: _e,
          adminEdit: _d,
          ...rest
        } = c as CiiV45CriterionScore & Partial<CiiV45CriterionResult>;
        void _a;
        void _e;
        void _d;
        return {
          ...rest,
          maximumPoints: w,
          score,
          ...(r3
            ? {
                aiScore,
                adminEdited: !!edit,
                ...(edit
                  ? {
                      adminEdit: {
                        reason: edit.reason,
                        sourceRef: edit.sourceRef ?? null,
                        actorId: edit.actorId,
                        at: edit.at,
                      },
                    }
                  : {}),
              }
            : {}),
        };
      },
    );
    return {
      dimension: dim.id,
      name: dim.name,
      maximumPoints: dim.maxPoints,
      criterionScores: criterionResults,
      score: pending ? null : sum,
      knownPoints: sum,
    };
  });

  const inputs = p.inputCompleteness || ({} as CiiV45InputCompleteness);
  if (
    !Array.isArray(inputs.gaps) ||
    !Array.isArray(inputs.individualHours) ||
    !inputs.individualHours.length ||
    typeof inputs.mandatoryFieldsComplete !== 'boolean'
  ) {
    fail('Input audit and individual hours required.');
  }
  const claimInventory = Array.isArray(p.claimInventory)
    ? p.claimInventory
    : [];
  const evidenceAudit = Array.isArray(p.evidenceAudit) ? p.evidenceAudit : [];
  const adminReviewReasons = Array.isArray(p.adminReviewReasons)
    ? p.adminReviewReasons
    : [];

  const evidence =
    p.adminEvidenceAssessment ||
    ({ status: 'PENDING' } as CiiV45AdminEvidenceAssessment);
  if (!['PENDING', 'ASSESSED'].includes(evidence.status))
    fail('Admin evidence assessment status required.');
  const dimension7 = sections.find((s) => s.dimension === '7')!;
  if (
    evidence.status === 'PENDING' &&
    dimension7.criterionScores.some((c) => c.anchor !== 'P')
  ) {
    fail('Dimension 7 must remain pending until Admin evidence assessment.');
  }
  if (evidence.status === 'ASSESSED') {
    if (
      !evidence.assessorId ||
      !evidence.assessedAt ||
      !Array.isArray(evidence.criteria) ||
      evidence.criteria.length !== 7
    ) {
      fail('Complete Admin evidence assessment required.');
    }
    for (const c of dimension7.criterionScores) {
      const a = evidence.criteria.find((x) => x.criterion === c.criterion);
      if (
        !a ||
        a.anchor !== c.anchor ||
        a.anchor === ('P' as never) ||
        typeof a.reasoningSummary !== 'string' ||
        !a.reasoningSummary.trim() ||
        !Array.isArray(a.evidenceIds)
      ) {
        fail('Dimension 7 must match the saved Admin evidence assessment.');
      }
    }
  }

  const extras = p.extraMileUplift || ({} as CiiV45ExtraMileUplift);
  if (
    !['ASSESSED', 'PROCESSING_REQUIRED', 'PENDING_ADMIN'].includes(
      extras.assessmentStatus,
    )
  ) {
    fail('Extra-mile assessment status required.');
  }
  if (!Array.isArray(extras.items) || extras.items.length > 4) {
    fail('Extra-mile items required (max four).');
  }
  const seenCategories = new Set<string>();
  let uplift = 0;
  for (const x of extras.items) {
    if (
      !UPLIFT_CATEGORIES.includes(x.category) ||
      seenCategories.has(x.category) ||
      typeof x.points !== 'number' ||
      !Number.isFinite(x.points) ||
      x.points < 0 ||
      x.points > 1.25
    ) {
      fail('Invalid extra-mile item');
    }
    seenCategories.add(x.category);
    if (
      x.points > 0 &&
      (!x.studentId ||
        !inputs.individualHours.some((h) => h.studentId === x.studentId) ||
        !x.beyondBaseJustification ||
        !Array.isArray(x.evidenceIds) ||
        !x.evidenceIds.length ||
        x.adminVerified !== true)
    ) {
      fail(
        'Uplift requires individual, beyond-base justification and inspected evidence',
      );
    }
    uplift += x.points;
  }
  if (extras.assessmentStatus === 'PENDING_ADMIN' && extras.items.length) {
    fail('Pending uplift cannot contain awarded items.');
  }

  const integrity = p.integrityPenalty || ({} as CiiV45IntegrityPenalty);
  const penalty = integrity.points;
  if (
    typeof penalty !== 'number' ||
    !Number.isFinite(penalty) ||
    penalty < 0 ||
    penalty > 10 ||
    !Array.isArray(integrity.issues)
  ) {
    fail('Invalid integrity penalty');
  }
  if (
    penalty > 0 &&
    (!integrity.issues.length ||
      integrity.issues.some(
        (i) =>
          i.origin !== 'STUDENT' ||
          !i.confirmed ||
          !i.reason ||
          !Array.isArray(i.evidenceIds) ||
          !i.evidenceIds.length ||
          !i.adminVerified,
      ))
  ) {
    fail(
      'Integrity penalty requires confirmed student-origin issue with inspected evidence.',
    );
  }

  const hours = inputs.individualHours;
  if (new Set(hours.map((h) => h.studentId)).size !== hours.length)
    fail('Duplicate student hour audit');
  let hoursFail = false;
  let hoursPending = false;
  for (const h of hours) {
    if (
      !h.studentId ||
      typeof h.requiredHours !== 'number' ||
      !Number.isFinite(h.requiredHours) ||
      h.requiredHours <= 0
    ) {
      fail('Individual requirement required');
    }
    if (h.hours === null || h.recordComplete !== true) {
      hoursPending = true;
      continue;
    }
    if (typeof h.hours !== 'number' || !Number.isFinite(h.hours) || h.hours < 0)
      fail('Invalid hours');
    hoursFail ||= h.hours < h.requiredHours;
  }

  const studentGap = inputs.gaps.some(
    (g) =>
      g.material &&
      ['STUDENT_NOT_PROVIDED', 'SIGNATURE_INVALID'].includes(g.type) &&
      g.mandatory,
  );
  // Advisory Admin review reasons do not suppress a valid score. Only unresolved source/system gaps do.
  const aiPending =
    sections.filter((s) => s.dimension !== '7').some((s) => s.score === null) ||
    hoursPending ||
    inputs.gaps.some(
      (g) =>
        g.material &&
        ['SYSTEM_DATA_GAP', 'PROCESSING_REQUIRED'].includes(g.type),
    );
  const evidencePending =
    evidence.status !== 'ASSESSED' || extras.assessmentStatus !== 'ASSESSED';
  const status: CiiV45ScoreStatus =
    hoursFail || studentGap || !inputs.mandatoryFieldsComplete
      ? 'RESUBMISSION_REQUIRED'
      : aiPending
        ? 'ADMIN_REVIEW_REQUIRED'
        : evidencePending
          ? 'ADMIN_EVIDENCE_REQUIRED'
          : 'FINAL';

  const aiSections = sections.filter((s) => s.dimension !== '7');
  const rawAi = aiSections.some((s) => s.score === null)
    ? null
    : aiSections.reduce((t, s) => t + (s.score as number), 0);
  const rawEvidence = dimension7.score === null ? null : dimension7.score;
  const aiReportScore = rawAi === null ? null : round1(rawAi);
  const adminEvidenceScore = rawEvidence === null ? null : round1(rawEvidence);
  const rawBase =
    rawAi === null || rawEvidence === null ? null : rawAi + rawEvidence;
  const base = rawBase === null ? null : round1(rawBase);
  // Combine raw /85 + /15 then round once. Do not add separately rounded display values.
  // R3 is 85 + 15 only: the legacy Admin uplift / integrity deduction never enter the number
  // (neither can be set through the approval flow; they stay for R1/R2 analyses).
  const adjust = r3 ? 0 : uplift - penalty;
  const diag =
    rawBase === null || extras.assessmentStatus !== 'ASSESSED'
      ? null
      : round1(Math.min(100, Math.max(0, rawBase + adjust)));

  const scoreRatio = (id: CiiV45Dimension): number | null => {
    const s = sections.find((x) => x.dimension === id)!;
    return s.score === null ? null : s.score / s.maximumPoints;
  };
  const get = (id: CiiV45Dimension): number | null => scoreRatio(id);
  const g4 =
    diag !== null &&
    (get('4A') ?? 0) >= 0.65 &&
    (get('4B') ?? 0) >= 0.55 &&
    (get('7') ?? 0) >= 0.55 &&
    penalty < 5;
  const g5 =
    g4 &&
    (get('4B') ?? 0) >= 0.7 &&
    (get('7') ?? 0) >= 0.7 &&
    (get('9') ?? 0) >= 0.55 &&
    penalty < 3;
  const feature = p.exceptionalFeature;
  const exceptional = !!(
    feature?.verified &&
    feature.adminVerified &&
    feature.explanation &&
    Array.isArray(feature.evidenceIds) &&
    feature.evidenceIds.length
  );
  const g6 =
    g5 &&
    (get('4B') ?? 0) >= 0.8 &&
    (get('7') ?? 0) >= 0.85 &&
    (get('9') ?? 0) >= 0.7 &&
    penalty === 0 &&
    exceptional;
  const knownBasePoints = round1(
    sections.reduce((t, s) => t + s.knownPoints, 0),
  );
  const badgeScore = diag ?? (knownBasePoints > 0 ? knownBasePoints : null);
  const l6Assessment = r3
    ? assessCiiV45L6(diag, sections, p.l6Qualification)
    : undefined;
  // R1/R2: cumulative quality gates cap the band. R3: no L4/L5 gate, L6 needs the qualification.
  const qualityGates = r3
    ? {
        L4: diag !== null,
        L5: diag !== null,
        L6: l6Assessment?.status === 'QUALIFIED',
      }
    : { L4: g4, L5: g5, L6: g6 };
  const r3Badge = r3 ? resolveCiiV45BadgeR3(badgeScore, qualityGates.L6) : null;
  const finalBadgeShape = r3
    ? r3Badge!.badge
    : resolveBadgeForScore(badgeScore, qualityGates);
  const extrasPending = extras.assessmentStatus !== 'ASSESSED';
  const aiProposalScore = r3
    ? aiSections.some((s) =>
        s.criterionScores.some(
          (c) => c.aiScore === null || c.aiScore === undefined,
        ),
      )
      ? null
      : round1(
          aiSections.reduce(
            (t, s) =>
              t +
              s.criterionScores.reduce((u, c) => u + (c.aiScore as number), 0),
            0,
          ),
        )
    : undefined;

  return {
    ...p,
    claimInventory,
    evidenceAudit,
    adminReviewReasons,
    knownBasePoints,
    sectionScores: sections,
    aiReportScore,
    adminEvidenceScore,
    baseCII: base,
    extraMileUplift: {
      ...extras,
      total: extrasPending ? null : round1(uplift),
      knownTotal: round1(uplift),
    },
    adminEvidenceAssessment: evidence,
    integrityPenalty: integrity,
    diagnosticCII: diag,
    scoreStatus: status,
    needsAdminReview: status !== 'FINAL',
    finalCII: status === 'FINAL' ? diag : null,
    recommendedBadge: status === 'FINAL' ? finalBadgeShape : null,
    diagnosticBadge: finalBadgeShape,
    finalBadge: null,
    qualityGates,
    publicationEligible: status === 'FINAL',
    rubricVersion: rubric.version,
    ...(r3
      ? {
          candidateBadge: r3Badge!.candidate,
          badgeStatus: r3Badge!.status,
          l6Assessment,
          aiProposalScore,
          moderated: Object.keys(moderationEdits).length > 0,
        }
      : {}),
    rounding: r3
      ? 'CII R3: 85 AI report-quality points (Admin-reviewed where a criterion mark was edited) + 15 Admin evidence points; individual attendance is system-recorded; advisory Admin flags do not suppress CII; clamp 0..100; round once to 1 decimal. The final CII alone picks the candidate band; L6 is awarded only after the sourced sustained-impact qualification, otherwise the CII is retained and L6 stays pending (never replaced by L5).'
      : 'Hybrid CII v5.0.2: 85 AI report-quality points + 15 Admin evidence points + Admin-confirmed uplift <=5 - confirmed integrity deduction <=10; individual attendance is system-recorded; advisory Admin flags do not suppress CII; clamp 0..100; round once to 1 decimal; apply locked badge bands and cumulative L4-L6 gates.',
  };
}

export function getCiiV45ScoringConfig() {
  return {
    cii_v45_framework_version: CII_V45_FRAMEWORK_VERSION,
    rubric_version: CII_V45_RUBRIC_VERSION,
    base_max: CII_V45_BASE_MAX,
    bonus_max: CII_V45_BONUS_MAX,
    max_total: CII_V45_MAX,
    ai_report_max: CII_V45_AI_REPORT_MAX,
    admin_evidence_max: CII_V45_ADMIN_EVIDENCE_MAX,
    dimensions: CII_V45_DIMENSIONS,
    bands: CII_V45_BANDS,
    anchor_factors: CII_V45_ANCHOR_FACTORS,
    badge_policy: {
      version: CII_V45_L6_POLICY.version,
      l6: {
        minimum_cii: CII_V45_L6_POLICY.minimumCii,
        minimum_measured_change: CII_V45_L6_POLICY.minimumMeasuredChange,
        minimum_sustainability: CII_V45_L6_POLICY.minimumSustainability,
        minimum_manual_evidence: CII_V45_L6_POLICY.minimumManualEvidence,
        requires_observed_retention: true,
        requires_community_ownership_or_adoption: true,
        requires_corroboration_outside_student_team: true,
        pending_behavior:
          'Approve the CII; withhold L6 pending qualification. Never substitute L5 for a 90+ candidate.',
      },
    },
  };
}
