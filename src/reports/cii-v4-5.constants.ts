/**
 * Composite Impact Index (CII) v4.5 — Community Service scoring engine.
 *
 * Ported near line-for-line from the reference `cii-calculator.js` (CIEL PK
 * CII v4.5 package) so the exact math/validation/gating stays traceable back
 * to that ground truth. The AI never returns a numeric score or badge here —
 * it returns only per-criterion anchors, claims, evidence audit and
 * narrative text. All arithmetic, status derivation, bands and quality gates
 * are computed here, server-side, by `computeCiiV45Result()`.
 *
 * Keep in sync with `ciel_frontend/src/utils/communityCiiAnalyser.ts`.
 */

export class CiiV45ValidationError extends Error {}

function fail(message: string): never {
  throw new CiiV45ValidationError(message);
}

export type CiiV45Anchor = 0 | 1 | 2 | 3 | 4 | 'P';

export type CiiV45VerificationStatus =
  | 'VERIFIED'
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
}

export interface CiiV45ExtraMileUplift {
  assessmentStatus: 'ASSESSED' | 'PROCESSING_REQUIRED';
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
}

export interface CiiV45IntegrityPenalty {
  points: number;
  issues: CiiV45IntegrityIssue[];
}

export interface CiiV45ExceptionalFeature {
  verified: boolean;
  explanation?: string;
  evidenceIds?: string[];
}

export type CiiV45DeductionLedgerEntry = Record<string, unknown>;

/** Shape the AI actually returns — anchors/claims/evidence/narrative only, no score fields. */
export interface CiiV45EvaluatorPayload {
  frameworkVersion: '4.5';
  reportId: string;
  inputFingerprint: string;
  inputCompleteness: CiiV45InputCompleteness;
  claimInventory: CiiV45Claim[];
  evidenceAudit: CiiV45EvidenceAudit[];
  sectionScores: CiiV45SectionScore[];
  deductionLedger: CiiV45DeductionLedgerEntry[];
  extraMileUplift: CiiV45ExtraMileUplift;
  integrityPenalty: CiiV45IntegrityPenalty;
  exceptionalFeature: CiiV45ExceptionalFeature | null;
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
  baseCII: number | null;
  extraMileUplift: CiiV45ExtraMileUplift;
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
    name: 'Participation & Verified Effort',
    maxPoints: 10,
    criteria: [
      { key: 'role', weight: 2.5 },
      { key: 'quality', weight: 2.5 },
      { key: 'hoursConsistency', weight: 2.5 },
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
      { key: 'alignment', weight: 1.5 },
      { key: 'logic', weight: 1.5 },
      { key: 'coherence', weight: 1.5 },
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

/** Six contiguous locked bands (CIEL PK CII v4.5 badge manifest). */
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
  'VERIFIED', 'NARRATIVE_ONLY', 'PROCESSING_REQUIRED', 'NOT_APPLICABLE', 'CONTRADICTED',
];
const CLAIM_SUPPORT_STATUSES: CiiV45SupportStatus[] = [
  'SUPPORTED', 'PARTIALLY_SUPPORTED', 'UNSUPPORTED', 'CONTRADICTED', 'PROCESSING_REQUIRED',
];
const PRIVACY_VALUES: CiiV45Privacy[] = ['PUBLIC', 'RESTRICTED', 'PRIVATE'];
const PROCESSING_STATUSES: CiiV45ProcessingStatus[] = [
  'INSPECTED', 'UNREADABLE', 'CORRUPTED', 'CONVERSION_FAILED', 'INACCESSIBLE', 'DUPLICATE',
];
const UPLIFT_CATEGORIES: CiiV45UpliftCategory[] = ['effort', 'resources', 'partnerships', 'outcomes'];

/**
 * Deterministically computes the full CII v4.5 result from the AI's raw
 * evaluator payload (anchors/claims/evidence/narrative only — no score
 * fields). Ported near line-for-line from `cii-calculator.js`'s `calculate()`
 * so every validation rule and its exact failure message stays traceable
 * back to that reference. Throws `CiiV45ValidationError` on any structural
 * violation.
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
  if (p.frameworkVersion !== '4.5') fail('Expected frameworkVersion 4.5.');
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
  if (
    !Array.isArray(p.claimInventory) ||
    !Array.isArray(p.evidenceAudit) ||
    !Array.isArray(p.adminReviewReasons)
  ) {
    fail('Claim / evidence / review arrays required.');
  }

  const claimIds = p.claimInventory.map((x) => x.claimId);
  const evidenceIds = p.evidenceAudit.map((x) => x.evidenceId);
  if (new Set(claimIds).size !== claimIds.length || new Set(evidenceIds).size !== evidenceIds.length) {
    fail('Duplicate claim / evidence IDs');
  }
  for (const c of p.claimInventory) {
    if (
      !c.claimId ||
      typeof c.material !== 'boolean' ||
      !Array.isArray(c.evidenceIds) ||
      !CLAIM_SUPPORT_STATUSES.includes(c.supportStatus)
    ) {
      fail('Invalid claim inventory');
    }
    if (c.evidenceIds.some((id) => !evidenceIds.includes(id))) fail('Unknown evidence in claim');
  }
  for (const e of p.evidenceAudit) {
    if (
      !e.evidenceId ||
      typeof e.material !== 'boolean' ||
      !PRIVACY_VALUES.includes(e.privacy) ||
      !PROCESSING_STATUSES.includes(e.processingStatus) ||
      !Array.isArray(e.claimIds) ||
      e.claimIds.some((id) => !claimIds.includes(id))
    ) {
      fail('Invalid evidence audit');
    }
  }
  for (const s of sections) {
    for (const c of s.criterionScores) {
      if (c.evidenceIds.some((id) => !evidenceIds.includes(id))) fail('Unknown criterion evidence ID');
    }
  }
  const dimension7 = sections.find((s) => s.dimension === '7')!;
  for (const c of dimension7.criterionScores) {
    if (
      c.criterion !== 'ethics' &&
      typeof c.anchor === 'number' &&
      c.anchor > 2 &&
      c.verificationStatus !== 'PROCESSING_REQUIRED' &&
      (!c.evidenceIds.length ||
        !c.evidenceIds.some((id) =>
          p.evidenceAudit.some((e) => e.evidenceId === id && e.processingStatus === 'INSPECTED'),
        ))
    ) {
      fail('High evidence anchor requires inspected proof.');
    }
  }

  const extras = p.extraMileUplift || ({} as CiiV45ExtraMileUplift);
  if (!['ASSESSED', 'PROCESSING_REQUIRED'].includes(extras.assessmentStatus)) {
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
        x.evidenceIds.some(
          (id) => !p.evidenceAudit.some((e) => e.evidenceId === id && e.processingStatus === 'INSPECTED'),
        ))
    ) {
      fail('Uplift requires individual, beyond-base justification and inspected evidence');
    }
    uplift += x.points;
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
          i.evidenceIds.some((id) => !p.evidenceAudit.some((e) => e.evidenceId === id && e.processingStatus === 'INSPECTED')),
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
    if (typeof h.hours === 'number' && h.hours < h.requiredHours && h.recordComplete === true) {
      hoursFail = true;
    }
    if (h.hours === null) {
      hoursPending = true;
      continue;
    }
    if (typeof h.hours !== 'number' || !Number.isFinite(h.hours) || h.hours < 0) fail('Invalid hours');
    hoursFail ||= h.hours < h.requiredHours;
  }

  const studentGap = inputs.gaps.some((g) => g.material && g.type === 'STUDENT_NOT_PROVIDED' && g.mandatory);
  const pendingOverall =
    extras.assessmentStatus === 'PROCESSING_REQUIRED' ||
    sections.some((s) => s.score === null) ||
    hoursPending ||
    inputs.gaps.some((g) => g.material && ['SYSTEM_DATA_GAP', 'PROCESSING_REQUIRED'].includes(g.type)) ||
    p.claimInventory.some((c) => c.material && c.supportStatus === 'PROCESSING_REQUIRED') ||
    p.evidenceAudit.some((e) => e.material && !['INSPECTED', 'DUPLICATE'].includes(e.processingStatus)) ||
    p.adminReviewReasons.length > 0;

  const status: CiiV45ScoreStatus =
    hoursFail || studentGap || !inputs.mandatoryFieldsComplete
      ? 'RESUBMISSION_REQUIRED'
      : pendingOverall
        ? 'ADMIN_REVIEW_REQUIRED'
        : 'FINAL';

  const base = sections.some((s) => s.score === null) ? null : sections.reduce((t, s) => t + (s.score as number), 0);
  // Diagnostic CII is the numeric rollup of scored criteria. Uninspected files
  // or extra-mile still-processing block publication (`finalCII` / FINAL); they must
  // not hide the overall score the Analyzer already computed.
  // Pending faculty/partner attendance verification is not an analyser gate.
  const extraForDiag =
    extras.assessmentStatus === 'PROCESSING_REQUIRED' ? 0 : uplift;
  const diag =
    base === null
      ? null
      : round1(Math.min(100, Math.max(0, base + extraForDiag - penalty)));

  const scoreRatio = (id: CiiV45Dimension): number | null => {
    const s = sections.find((x) => x.dimension === id)!;
    return s.score === null ? null : s.score / s.maximumPoints;
  };
  const ratio4A = scoreRatio('4A');
  const ratio4B = scoreRatio('4B');
  const ratio7 = scoreRatio('7');
  const ratio9 = scoreRatio('9');
  const g4 = (ratio4A ?? 0) >= 0.65 && (ratio4B ?? 0) >= 0.55 && (ratio7 ?? 0) >= 0.55 && penalty < 5;
  const g5 = g4 && (ratio4B ?? 0) >= 0.7 && (ratio7 ?? 0) >= 0.7 && (ratio9 ?? 0) >= 0.55 && penalty < 3;
  const feature = p.exceptionalFeature;
  const exceptional = !!(
    feature?.verified &&
    feature.explanation &&
    Array.isArray(feature.evidenceIds) &&
    feature.evidenceIds.length &&
    feature.evidenceIds.every((id) => p.evidenceAudit.some((e) => e.evidenceId === id && e.processingStatus === 'INSPECTED'))
  );
  const g6 = g5 && (ratio4B ?? 0) >= 0.8 && (ratio7 ?? 0) >= 0.85 && (ratio9 ?? 0) >= 0.7 && penalty === 0 && exceptional;
  const qualityGates = { L4: g4, L5: g5, L6: g6 };
  const knownBasePoints = round1(sections.reduce((t, s) => t + s.knownPoints, 0));
  const badgeScore = diag ?? (knownBasePoints > 0 ? knownBasePoints : null);
  const finalBadgeShape = resolveBadgeForScore(badgeScore, qualityGates);

  return {
    ...p,
    knownBasePoints,
    sectionScores: sections,
    baseCII: base === null ? null : round1(base),
    extraMileUplift: {
      ...extras,
      total: extras.assessmentStatus === 'PROCESSING_REQUIRED' ? null : uplift,
      knownTotal: uplift,
    },
    integrityPenalty: integrity,
    diagnosticCII: diag,
    scoreStatus: status,
    needsAdminReview: pendingOverall,
    finalCII: status === 'FINAL' ? diag : null,
    recommendedBadge: status === 'FINAL' ? finalBadgeShape : null,
    diagnosticBadge: finalBadgeShape,
    finalBadge: null,
    qualityGates,
    publicationEligible: status === 'FINAL',
    rounding:
      'Clamp 0..100; round once to 1 decimal; map to locked six-level bands; apply cumulative L4-L6 gates.',
  };
}

export function getCiiV45ScoringConfig() {
  return {
    cii_v45_framework_version: '4.5',
    base_max: CII_V45_BASE_MAX,
    bonus_max: CII_V45_BONUS_MAX,
    max_total: CII_V45_MAX,
    dimensions: CII_V45_DIMENSIONS,
    bands: CII_V45_BANDS,
    anchor_factors: CII_V45_ANCHOR_FACTORS,
  };
}
