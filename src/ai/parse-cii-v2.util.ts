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
  bonusWhy: { effort?: string; resources?: string; partners?: string };
  integrityPenalty: number;
  integrityWhy?: string;
  evidence: CiiV2EvidenceRow[];
  redFlags: string[];
  needsAdminReview: boolean;
  studentFeedback?: string;
  frameworkVersion: string;
}

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
    pickString(rec.file) || pickString(rec.filename) || pickString(rec.url);
  const claim = pickString(rec.claim);
  if (!file && !claim) return null;
  const verdictRaw = pickString(rec.verdict).toUpperCase();
  const verdict: CiiV2EvidenceRow['verdict'] =
    verdictRaw === 'MATCH' ||
    verdictRaw === 'PARTIAL' ||
    verdictRaw === 'MISMATCH'
      ? verdictRaw
      : 'PARTIAL';
  return {
    id: pickString(rec.id) || `E-${String(index + 1).padStart(2, '0')}`,
    file: file || 'Uploaded evidence',
    claim: claim || 'Report claim',
    type: pickString(rec.type) || 'Document',
    match: Math.min(100, Math.max(0, pickNumber(rec.match) ?? 0)),
    verdict,
    why: pickString(rec.why),
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
  // parseSectionInput below — that can swing the final score by a lot (Section 4 alone is
  // 32/94 base points), so surface it as a loud, faculty-visible red flag instead of letting a
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

  const bonusRec = asRecord(rec.bonus);
  const effort = parseBonusChannel(bonusRec.effort);
  const resources = parseBonusChannel(bonusRec.resources);
  const partners = parseBonusChannel(bonusRec.partners);

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

  return {
    sections,
    bonus: {
      effort: effort.amount,
      resources: resources.amount,
      partners: partners.amount,
    },
    bonusWhy: {
      effort: effort.why,
      resources: resources.why,
      partners: partners.why,
    },
    integrityPenalty: Math.max(0, integrityPenalty),
    integrityWhy,
    evidence,
    redFlags,
    needsAdminReview: Boolean(rec.needsAdminReview) || redFlags.length > 0,
    studentFeedback: pickString(rec.studentFeedback) || undefined,
    frameworkVersion: pickString(rec.framework_version) || 'v2.0',
  };
}
