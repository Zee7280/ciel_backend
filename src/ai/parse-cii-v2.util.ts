import { extractSection11JsonObject } from './parse-section11-v61.util';
import {
  CII_V2_SECTIONS,
  CiiV2BonusInput,
  CiiV2EvidenceRow,
  CiiV2SectionInput,
} from '../reports/cii-v2.constants';

export interface CiiV2AiEvaluation {
  sections: CiiV2SectionInput[];
  bonus: CiiV2BonusInput;
  bonusWhy: { effort?: string; resources?: string; partners?: string; outcome?: string };
  integrityPenalty: number;
  integrityWhy?: string;
  evidence: CiiV2EvidenceRow[];
  redFlags: string[];
  /** Optional hold/review integrity checks (additive; absent in older responses). */
  checks: Array<{ level: 'hold' | 'review'; title: string; detail: string }>;
  needsAdminReview: boolean;
  /** True when the model omitted whole sections / criteria (they were scored 0): re-run, don't lock. */
  incomplete?: boolean;
  studentFeedback?: string;
  frameworkVersion: string;
}

/** Explicit wording shown wherever evidence does not support a claim. */
export const EVIDENCE_UNSUPPORTED_FLAG = 'UNRELATED / DOES NOT SUPPORT CLAIM';

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function pickString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function pickNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function parseBonusChannel(value: unknown): { amount: number; why?: string } {
  if (typeof value === 'number') return { amount: value };
  const rec = asRecord(value);
  return {
    amount: pickNumber(rec.amount) ?? 0,
    why: pickString(rec.why) || undefined,
  };
}

function parseEvidenceRow(
  raw: unknown,
  index: number,
): CiiV2EvidenceRow | null {
  const rec = asRecord(raw);
  const file =
    pickString(rec.file) ||
    pickString(rec.file_name) ||
    pickString(rec.filename) ||
    pickString(rec.url);
  const claim = pickString(rec.claim);
  if (!file && !claim) return null;
  const match = Math.min(
    100,
    Math.max(0, pickNumber(rec.match ?? rec.match_confidence) ?? 0),
  );
  const verdictRaw = pickString(rec.verdict).toUpperCase();
  // An unknown / missing verdict is derived from the numeric match (≥85 / ≥50 / below) rather than
  // silently softened to PARTIAL — an "unrelated" row must not be upgraded by a parsing gap.
  const verdict: CiiV2EvidenceRow['verdict'] =
    verdictRaw === 'MATCH' ||
    verdictRaw === 'PARTIAL' ||
    verdictRaw === 'MISMATCH'
      ? verdictRaw
      : verdictRaw === 'PROCESSING_REQUIRED'
        ? 'PARTIAL'
        : match >= 85
          ? 'MATCH'
          : match >= 50
            ? 'PARTIAL'
            : 'MISMATCH';
  const supportRaw = pickString(rec.claimSupport ?? rec.claim_support)
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  let claimSupport: NonNullable<CiiV2EvidenceRow['claimSupport']> =
    supportRaw === 'supported' ||
    supportRaw === 'partially_supported' ||
    supportRaw === 'unsupported' ||
    supportRaw === 'contradicted'
      ? supportRaw
      : supportRaw === 'processing_required'
        ? 'unsupported'
        : verdict === 'MATCH'
          ? 'supported'
          : verdict === 'PARTIAL'
            ? 'partially_supported'
            : 'unsupported';
  // The verdict and the plain-words support must agree: a MISMATCH can never read "supported".
  if (verdict === 'MISMATCH' && (claimSupport === 'supported' || claimSupport === 'partially_supported')) {
    claimSupport = 'unsupported';
  }
  if (verdict === 'MATCH' && (claimSupport === 'unsupported' || claimSupport === 'contradicted')) {
    claimSupport = 'partially_supported';
  }
  const flagged = claimSupport === 'unsupported' || claimSupport === 'contradicted';
  let why = pickString(rec.why);
  if (flagged && !/^UNRELATED \/ DOES NOT SUPPORT CLAIM/i.test(why)) {
    why = `${EVIDENCE_UNSUPPORTED_FLAG}: ${why || 'The evidence does not substantiate this claim.'}`;
  }
  return {
    id: pickString(rec.id) || `E-${String(index + 1).padStart(2, '0')}`,
    file: file || 'Uploaded evidence',
    claim: claim || 'Report claim',
    type: pickString(rec.type) || 'Document',
    match,
    verdict,
    claimSupport,
    ...(flagged ? { flag: EVIDENCE_UNSUPPORTED_FLAG } : {}),
    why,
  };
}

function parseSectionInput(
  raw: unknown,
  sectionId: number,
): { input: CiiV2SectionInput; missingCriteriaKeys: string[] } {
  const rec = asRecord(raw);
  const section = CII_V2_SECTIONS.find((s) => s.id === sectionId);
  const criteriaByKey = new Map<string, unknown>();
  if (Array.isArray(rec.criteria)) {
    for (const c of rec.criteria) {
      const cRec = asRecord(c);
      const key = pickString(cRec.key);
      if (key) criteriaByKey.set(key, cRec);
    }
  }

  const missingCriteriaKeys: string[] = [];
  const criteria = (section?.criteria || []).map((c) => {
    if (!criteriaByKey.has(c.key)) missingCriteriaKeys.push(c.key);
    const cRec = asRecord(criteriaByKey.get(c.key));
    return {
      key: c.key,
      anchor: Math.min(4, Math.max(0, pickNumber(cRec.anchor) ?? 0)),
      note: pickString(cRec.note) || undefined,
    };
  });

  return {
    input: {
      id: sectionId,
      criteria,
      good: pickString(rec.good) || undefined,
      limit: pickString(rec.limit) || undefined,
    },
    missingCriteriaKeys,
  };
}

/** Loosely validates that a parsed object looks like a CII v2 evaluation response. */
export function isCiiV2Evaluation(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const rec = value as Record<string, unknown>;
  return Array.isArray(rec.sections) && rec.sections.length > 0;
}

export function parseCiiV2Response(raw: string): CiiV2AiEvaluation | null {
  const parsed = extractSection11JsonObject(raw);
  if (!isCiiV2Evaluation(parsed)) return null;

  const rec = parsed as Record<string, unknown>;
  const sectionsRaw = Array.isArray(rec.sections) ? rec.sections : [];
  const sectionsById = new Map<number, unknown>();
  for (const s of sectionsRaw) {
    const id = pickNumber(asRecord(s).id);
    if (id !== null) sectionsById.set(id, s);
  }

  // A section or criterion the AI response omits is silently scored as anchor 0 by
  // parseSectionInput below — that can swing the final score by a lot (Sections 4/5/8
  // are 15 points each), so surface it as a loud, faculty-visible red flag instead of letting a
  // parsing gap masquerade as a genuinely low score.
  const parsingRedFlags: string[] = [];
  const sections = CII_V2_SECTIONS.map((s) => {
    const raw = sectionsById.get(s.id);
    if (raw === undefined) {
      parsingRedFlags.push(
        `AI response did not include Section ${s.id} (${s.title}) — it was scored as 0 and MUST be re-run or manually reviewed before approval.`,
      );
    }
    const { input, missingCriteriaKeys } = parseSectionInput(raw, s.id);
    if (raw !== undefined && missingCriteriaKeys.length > 0) {
      parsingRedFlags.push(
        `Section ${s.id}: AI response was missing criteria [${missingCriteriaKeys.join(', ')}] — defaulted to anchor 0.`,
      );
    }
    return input;
  });

  // v3.1 uses extraMileUplift; older runs used bonus.{effort,resources,partners}.
  const uplift = asRecord(rec.extraMileUplift ?? rec.extra_mile_uplift);
  const bonusRec = asRecord(rec.bonus);
  const effort = parseBonusChannel(
    uplift.extra_effort ?? uplift.extraEffort ?? bonusRec.effort,
  );
  const resources = parseBonusChannel(
    uplift.resource_mobilization ?? uplift.resourceMobilization ?? bonusRec.resources,
  );
  const partners = parseBonusChannel(
    uplift.partnership_building ?? uplift.partnershipBuilding ?? bonusRec.partners,
  );
  const outcome = parseBonusChannel(
    uplift.exceptional_outcome ?? uplift.exceptionalOutcome ?? bonusRec.outcome,
  );

  const integrityRec = asRecord(rec.integrityPenalty);
  const integrityPenalty =
    typeof rec.integrityPenalty === 'number'
      ? rec.integrityPenalty
      : (pickNumber(integrityRec.amount) ?? 0);
  const integrityWhy =
    typeof rec.integrityPenalty === 'object'
      ? pickString(integrityRec.why) || undefined
      : undefined;

  const evidence = (Array.isArray(rec.evidence) ? rec.evidence : [])
    .map((e, i) => parseEvidenceRow(e, i))
    .filter((e): e is CiiV2EvidenceRow => e !== null);

  const redFlags = [
    ...parsingRedFlags,
    ...(Array.isArray(rec.redFlags) ? rec.redFlags : [])
      .map((f) => pickString(f))
      .filter(Boolean),
  ];

  const checks = (Array.isArray(rec.checks) ? rec.checks : [])
    .map((c) => {
      const r = asRecord(c);
      const title = pickString(r.title);
      const detail = pickString(r.detail);
      if (!title || !detail) return null;
      const level: 'hold' | 'review' =
        pickString(r.level).toLowerCase() === 'hold' ? 'hold' : 'review';
      return { level, title, detail };
    })
    .filter((c): c is { level: 'hold' | 'review'; title: string; detail: string } => c !== null);

  return {
    sections,
    bonus: {
      effort: effort.amount,
      resources: resources.amount,
      partners: partners.amount,
      outcome: outcome.amount,
    },
    bonusWhy: {
      effort: effort.why,
      resources: resources.why,
      partners: partners.why,
      outcome: outcome.why,
    },
    // A single run must not be able to zero a report on its own: cap the penalty (the rubric's
    // harshest tier is -15, so 30 leaves generous headroom).
    integrityPenalty: Math.min(30, Math.max(0, integrityPenalty)),
    integrityWhy,
    evidence,
    redFlags,
    checks,
    needsAdminReview:
      Boolean(rec.needsAdminReview) ||
      redFlags.length > 0 ||
      pickString(rec.badgeReadiness).toUpperCase() === 'ADMIN_REVIEW_REQUIRED' ||
      pickString(asRecord(rec.inputCompleteness).scoring_status).toLowerCase() ===
        'admin_review_required',
    incomplete: parsingRedFlags.length > 0,
    studentFeedback: pickString(rec.studentFeedback) || undefined,
    frameworkVersion: pickString(rec.framework_version) || 'v3.1-balanced',
  };
}
