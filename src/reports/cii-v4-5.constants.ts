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
  | '1' | '2' | '3' | '4A' | '4B' | '5' | '6' | '7' | '8' | '9';

export type CiiV45UpliftCategory =
  | 'effort' | 'resources' | 'partnerships' | 'outcomes';

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

export interface CiiV45Result
  extends Omit<CiiV45EvaluatorPayload, 'sectionScores' | 'extraMileUplift'> {
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

/** Fixed dimensions/criteria/weights — base 100. Criterion IDs are exact and immutable. */
export const CII_V45_DIMENSIONS: CiiV45DimensionDef[] = [
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
    maxPoints: 10,
    criteria: [
      { key: 'relevance', weight: 2.5 },
      { key: 'roleClarity', weight: 2.5 },
      { key: 'collaboration', weight: 2.5 },
      { key: 'ownership', weight: 2.5 },
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
    maxPoints: 5,
    criteria: [
      { key: 'continuation', weight: 1.5 },
      { key: 'owner', weight: 1.5 },
      { key: 'handover', weight: 1.5 },
      { key: 'realism', weight: 0.5 },
    ],
  },
];

export const CII_V45_BASE_MAX = CII_V45_DIMENSIONS.reduce((sum, d) => sum + d.maxPoints, 0); // 100
export const CII_V45_BONUS_MAX = 5;
export const CII_V45_MAX = 100;
export const CII_V45_FRAMEWORK_VERSION = '5.0' as const;
export const CII_V45_AI_DIMENSIONS = CII_V45_DIMENSIONS.filter((d) => d.id !== '7');
export const CII_V45_EVIDENCE_DIMENSION = CII_V45_DIMENSIONS.find((d) => d.id === '7')!;
export const CII_V45_AI_REPORT_MAX = CII_V45_AI_DIMENSIONS.reduce((sum, d) => sum + d.maxPoints, 0); // 85
export const CII_V45_ADMIN_EVIDENCE_MAX = CII_V45_EVIDENCE_DIMENSION.maxPoints; // 15

/** Six contiguous locked bands (CIEL PK CII v5.0 badge manifest — same cut-points as v4.5). */
export const CII_V45_BANDS: CiiV45Band[] = [
  { level: 1, min: 0, max: 49, name: 'Participation Acknowledgement', assetKey: 'L1' },
  { level: 2, min: 50, max: 59, name: 'Foundation Stage Contributor', assetKey: 'L2' },
  { level: 3, min: 60, max: 69, name: 'Emerging Community Contributor', assetKey: 'L3' },
  { level: 4, min: 70, max: 79, name: 'Developing Impact Contributor', assetKey: 'L4' },
  { level: 5, min: 80, max: 89, name: 'Distinguished Impact Contributor', assetKey: 'L5' },
  { level: 6, min: 90, max: 100, name: 'Transformative Impact Contributor', assetKey: 'L6' },
];

/** Round to 1 decimal place (matches `cii-calculator.js`'s `round`). */
function round1(value: number): number {
  return Math.round((value + 1e-9) * 10) / 10;
}

function isValidAnchor(value: unknown): value is CiiV45Anchor {
  return value === 'P' || (Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 4);
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
const UPLIFT_CATEGORIES: CiiV45UpliftCategory[] = ['effort', 'resources', 'partnerships', 'outcomes'];

const CII_V45_ANCHOR_NAMES = ['Missing', 'Basic', 'Sound', 'Strong', 'Exceptional'] as const;

export function defaultAdminEvidenceRationale(
  criterion: string,
  anchor: Exclude<CiiV45Anchor, 'P'>,
): string {
  const label = CII_V45_ANCHOR_NAMES[anchor] ?? String(anchor);
  return `CIEL PK Admin assigned Anchor ${anchor} (${label}) for ${criterion} after reviewing original evidence.`;
}

function aliasAiCriterionKey(key: string): string {
  const compact = key.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
  if (compact === 'hoursconsistency' || compact === 'hourscompletion') return 'hoursCompletion';
  return key;
}

function normalizeAiDimensionId(value: unknown): string {
  const raw = String(value ?? '').trim();
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
  return aliasAiCriterionKey(String(row.criterion ?? row.key ?? row.id ?? row.criterionId ?? row.name ?? ''));
}

function pickAiAnchor(row: Record<string, unknown>, fallback?: CiiV45Anchor | null): CiiV45Anchor | null {
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
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
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
    reasoningSummary: 'AI omitted this criterion; Admin should confirm from the saved report.',
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
    const section = rows.find((s) => normalizeAiDimensionId(s.dimension) === dim.id);
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
        const c = byKey.get(key) ?? (list.length === dim.criteria.length ? list[index] : undefined);
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
          sourceRefs: Array.isArray(c.sourceRefs) ? (c.sourceRefs as string[]) : [],
          evidenceIds: [],
          reasoningSummary: compactReasoning(c.reasoningSummary ?? c.reasoning ?? c.rationale),
          deductionReason: (c.deductionReason as string | null) ?? null,
        };
      }),
    };
  });
  return { sections, omittedKeys };
}

/** Forces an AI evaluator payload onto the v5.0 hybrid contract (9 quality dims, D7 pending). */
export function normalizeCiiV5AiPayload(raw: CiiV45EvaluatorPayload): CiiV45EvaluatorPayload {
  const extras = raw.extraMileUplift;
  const candidates = Array.isArray(extras?.items) ? extras.items : [];
  const { sections, omittedKeys } = coerceAiSectionScores(raw.sectionScores);
  const reasons = Array.isArray(raw.adminReviewReasons) ? [...raw.adminReviewReasons] : [];
  if (omittedKeys.length) {
    const note = `AI omitted criteria: ${omittedKeys.join(', ')}. Confirm from the saved report.`;
    if (!reasons.includes(note)) reasons.push(note);
  }
  return {
    ...raw,
    frameworkVersion: CII_V45_FRAMEWORK_VERSION,
    claimInventory: Array.isArray(raw.claimInventory) ? raw.claimInventory : [],
    evidenceAudit: Array.isArray(raw.evidenceAudit) ? raw.evidenceAudit : [],
    deductionLedger: Array.isArray(raw.deductionLedger) ? raw.deductionLedger : [],
    adminReviewReasons: reasons,
    sectionScores: [...sections, pendingDimension7Section()],
    extraMileUplift: { assessmentStatus: 'PENDING_ADMIN', items: [] },
    extraMileCandidates: Array.isArray(raw.extraMileCandidates)
      ? raw.extraMileCandidates
      : candidates,
    sectionAnalyses: Array.isArray(raw.sectionAnalyses) ? raw.sectionAnalyses : [],
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
  if (!Array.isArray(input.criteria) || input.criteria.length !== CII_V45_EVIDENCE_DIMENSION.criteria.length) {
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
    sectionScores: [...payload.sectionScores.filter((s) => s.dimension !== '7'), dim7Section],
    extraMileUplift,
    exceptionalFeature:
      input.exceptionalFeature !== undefined ? input.exceptionalFeature : payload.exceptionalFeature,
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
  const numeric = score === null ? null : [...CII_V45_BANDS].reverse().find((b) => score >= b.min) || null;
  let badge: CiiV45Band | null = numeric;
  const gates = qualityGates ?? { L4: false, L5: false, L6: false };
  while (badge && badge.level >= 4 && !gates[`L${badge.level}` as 'L4' | 'L5' | 'L6']) {
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

export function computeCiiV45Result(payload: CiiV45EvaluatorPayload): CiiV45Result {
  const p = payload;
  if (p.frameworkVersion !== '5.0') fail('Expected frameworkVersion 5.0.');
  if (!p.reportId || !p.inputFingerprint) fail('Report ID and input fingerprint required.');
  if (!Array.isArray(p.sectionScores) || p.sectionScores.length !== 10) {
    fail('Exactly ten analytical dimensions required.');
  }

  const sections: CiiV45SectionResult[] = CII_V45_DIMENSIONS.map((dim) => {
    const matches = p.sectionScores.filter((s) => s.dimension === dim.id);
    if (matches.length !== 1) fail(`Missing/duplicate dimension ${dim.id}`);
    const s = matches[0];
    if (!Array.isArray(s.criterionScores) || s.criterionScores.length !== dim.criteria.length) {
      fail(`Invalid criterion count ${dim.id}`);
    }
    let sum = 0;
    let pending = false;
    const criterionResults: CiiV45CriterionResult[] = dim.criteria.map(({ key: cid, weight: w }) => {
      const cMatches = s.criterionScores.filter((c) => c.criterion === cid);
      if (cMatches.length !== 1) fail(`Missing/duplicate criterion ${dim.id}.${cid}`);
      const c = cMatches[0];
      if (!isValidAnchor(c.anchor)) fail(`Invalid anchor ${dim.id}.${cid}`);
      if (!isValidAnchor(c.qualityAnchor)) fail(`Invalid quality anchor ${dim.id}.${cid}`);
      if (
        typeof c.reasoningSummary !== 'string' ||
        !c.reasoningSummary.trim() ||
        !Array.isArray(c.sourceRefs) ||
        !Array.isArray(c.evidenceIds)
      ) {
        fail(`Auditable rationale / source / evidence arrays required ${dim.id}.${cid}`);
      }
      if (!VERIFICATION_STATUSES.includes(c.verificationStatus)) {
        fail('Invalid verification status');
      }
      if (c.anchor === 'P') pending = true;
      const score = c.anchor === 'P' ? null : w * CII_V45_ANCHOR_FACTORS[c.anchor as 0 | 1 | 2 | 3 | 4];
      if (score !== null) sum = Math.round((sum + score) * 10000) / 10000;
      return { ...c, maximumPoints: w, score };
    });
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
  const claimInventory = Array.isArray(p.claimInventory) ? p.claimInventory : [];
  const evidenceAudit = Array.isArray(p.evidenceAudit) ? p.evidenceAudit : [];
  const adminReviewReasons = Array.isArray(p.adminReviewReasons) ? p.adminReviewReasons : [];

  const evidence = p.adminEvidenceAssessment || ({ status: 'PENDING' } as CiiV45AdminEvidenceAssessment);
  if (!['PENDING', 'ASSESSED'].includes(evidence.status)) fail('Admin evidence assessment status required.');
  const dimension7 = sections.find((s) => s.dimension === '7')!;
  if (evidence.status === 'PENDING' && dimension7.criterionScores.some((c) => c.anchor !== 'P')) {
    fail('Dimension 7 must remain pending until Admin evidence assessment.');
  }
  if (evidence.status === 'ASSESSED') {
    if (!evidence.assessorId || !evidence.assessedAt || !Array.isArray(evidence.criteria) || evidence.criteria.length !== 7) {
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
  if (!['ASSESSED', 'PROCESSING_REQUIRED', 'PENDING_ADMIN'].includes(extras.assessmentStatus)) {
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
      fail('Uplift requires individual, beyond-base justification and inspected evidence');
    }
    uplift += x.points;
  }
  if (extras.assessmentStatus === 'PENDING_ADMIN' && extras.items.length) {
    fail('Pending uplift cannot contain awarded items.');
  }

  const integrity = p.integrityPenalty || ({} as CiiV45IntegrityPenalty);
  const penalty = integrity.points;
  if (typeof penalty !== 'number' || !Number.isFinite(penalty) || penalty < 0 || penalty > 10 || !Array.isArray(integrity.issues)) {
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
    fail('Integrity penalty requires confirmed student-origin issue with inspected evidence.');
  }

  const hours = inputs.individualHours;
  if (new Set(hours.map((h) => h.studentId)).size !== hours.length) fail('Duplicate student hour audit');
  let hoursFail = false;
  let hoursPending = false;
  for (const h of hours) {
    if (!h.studentId || typeof h.requiredHours !== 'number' || !Number.isFinite(h.requiredHours) || h.requiredHours <= 0) {
      fail('Individual requirement required');
    }
    if (h.hours === null || h.recordComplete !== true) {
      hoursPending = true;
      continue;
    }
    if (typeof h.hours !== 'number' || !Number.isFinite(h.hours) || h.hours < 0) fail('Invalid hours');
    hoursFail ||= h.hours < h.requiredHours;
  }

  const studentGap = inputs.gaps.some(
    (g) => g.material && ['STUDENT_NOT_PROVIDED', 'SIGNATURE_INVALID'].includes(g.type) && g.mandatory,
  );
  // Advisory Admin review reasons do not suppress a valid score. Only unresolved source/system gaps do.
  const aiPending =
    sections.filter((s) => s.dimension !== '7').some((s) => s.score === null) ||
    hoursPending ||
    inputs.gaps.some((g) => g.material && ['SYSTEM_DATA_GAP', 'PROCESSING_REQUIRED'].includes(g.type));
  const evidencePending = evidence.status !== 'ASSESSED' || extras.assessmentStatus !== 'ASSESSED';
  const status: CiiV45ScoreStatus =
    hoursFail || studentGap || !inputs.mandatoryFieldsComplete
      ? 'RESUBMISSION_REQUIRED'
      : aiPending
        ? 'ADMIN_REVIEW_REQUIRED'
        : evidencePending
          ? 'ADMIN_EVIDENCE_REQUIRED'
          : 'FINAL';

  const aiSections = sections.filter((s) => s.dimension !== '7');
  const rawAi = aiSections.some((s) => s.score === null) ? null : aiSections.reduce((t, s) => t + (s.score as number), 0);
  const rawEvidence = dimension7.score === null ? null : dimension7.score;
  const aiReportScore = rawAi === null ? null : round1(rawAi);
  const adminEvidenceScore = rawEvidence === null ? null : round1(rawEvidence);
  const rawBase = rawAi === null || rawEvidence === null ? null : rawAi + rawEvidence;
  const base = rawBase === null ? null : round1(rawBase);
  // Combine raw /85 + /15 then round once. Do not add separately rounded display values.
  const diag =
    rawBase === null || extras.assessmentStatus !== 'ASSESSED'
      ? null
      : round1(Math.min(100, Math.max(0, rawBase + uplift - penalty)));

  const scoreRatio = (id: CiiV45Dimension): number | null => {
    const s = sections.find((x) => x.dimension === id)!;
    return s.score === null ? null : s.score / s.maximumPoints;
  };
  const get = (id: CiiV45Dimension): number | null => scoreRatio(id);
  const g4 = diag !== null && (get('4A') ?? 0) >= 0.65 && (get('4B') ?? 0) >= 0.55 && (get('7') ?? 0) >= 0.55 && penalty < 5;
  const g5 = g4 && (get('4B') ?? 0) >= 0.7 && (get('7') ?? 0) >= 0.7 && (get('9') ?? 0) >= 0.55 && penalty < 3;
  const feature = p.exceptionalFeature;
  const exceptional = !!(
    feature?.verified &&
    feature.adminVerified &&
    feature.explanation &&
    Array.isArray(feature.evidenceIds) &&
    feature.evidenceIds.length
  );
  const g6 = g5 && (get('4B') ?? 0) >= 0.8 && (get('7') ?? 0) >= 0.85 && (get('9') ?? 0) >= 0.7 && penalty === 0 && exceptional;
  const qualityGates = { L4: g4, L5: g5, L6: g6 };
  const knownBasePoints = round1(sections.reduce((t, s) => t + s.knownPoints, 0));
  const badgeScore = diag ?? (knownBasePoints > 0 ? knownBasePoints : null);
  const finalBadgeShape = resolveBadgeForScore(badgeScore, qualityGates);
  const extrasPending = extras.assessmentStatus !== 'ASSESSED';

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
    rounding:
      'Hybrid CII v5.0.2: 85 AI report-quality points + 15 Admin evidence points + Admin-confirmed uplift <=5 - confirmed integrity deduction <=10; individual attendance is system-recorded; advisory Admin flags do not suppress CII; clamp 0..100; round once to 1 decimal; apply locked badge bands and cumulative L4-L6 gates.',
  };
}

export function getCiiV45ScoringConfig() {
  return {
    cii_v45_framework_version: CII_V45_FRAMEWORK_VERSION,
    base_max: CII_V45_BASE_MAX,
    bonus_max: CII_V45_BONUS_MAX,
    max_total: CII_V45_MAX,
    ai_report_max: CII_V45_AI_REPORT_MAX,
    admin_evidence_max: CII_V45_ADMIN_EVIDENCE_MAX,
    dimensions: CII_V45_DIMENSIONS,
    bands: CII_V45_BANDS,
    anchor_factors: CII_V45_ANCHOR_FACTORS,
  };
}
