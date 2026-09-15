import { extractSection11JsonObject } from './parse-section11-v61.util';
import {
  FYP_AI_RUBRIC,
  FYP_AI_SECTIONS,
  FypAiDimensionInput,
  FypAiSectionInput,
} from '../paths/fyp-ai-analysis.constants';

export interface FypAiEvaluation {
  dimensions: FypAiDimensionInput[];
  sections: FypAiSectionInput[];
  why?: string;
  whyNotHigher?: string;
  sustainability?: string;
  opportunityPotential?: string;
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

/** Loosely validates that a parsed object looks like an FYP AI evaluation response. */
export function isFypAiEvaluation(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const rec = value as Record<string, unknown>;
  return Array.isArray(rec.dimensions) && rec.dimensions.length > 0;
}

export function parseFypAiResponse(raw: string): FypAiEvaluation | null {
  const parsed = extractSection11JsonObject(raw);
  if (!isFypAiEvaluation(parsed)) return null;
  const rec = parsed as Record<string, unknown>;

  const dimsByKey = new Map<string, unknown>();
  for (const d of Array.isArray(rec.dimensions) ? rec.dimensions : []) {
    const key = pickString(asRecord(d).key);
    if (key) dimsByKey.set(key, d);
  }

  // A dimension the AI response omits is silently scored as 0 below — that can swing the final
  // score materially (Rigor alone is 20/100 and gates the score at ≤59 below 10), so surface it as
  // a loud, faculty-visible red flag instead of letting a parsing gap masquerade as a genuinely low
  // score — same convention as parseCiiV2Response's missing-section handling.
  const parsingRedFlags: string[] = [];
  const dimensions: FypAiDimensionInput[] = FYP_AI_RUBRIC.map((d) => {
    const rawDim = dimsByKey.get(d.key);
    if (rawDim === undefined) {
      parsingRedFlags.push(
        `AI response did not include the "${d.label}" dimension — it was scored as 0 and MUST be re-run or manually reviewed before approval.`,
      );
    }
    const rawRec = asRecord(rawDim);
    return {
      key: d.key,
      score: Math.min(d.max, Math.max(0, pickNumber(rawRec.score) ?? 0)),
      rationale: pickString(rawRec.rationale) || undefined,
    };
  });

  const sectionsByKey = new Map<string, unknown>();
  for (const s of Array.isArray(rec.sections) ? rec.sections : []) {
    const key = pickString(asRecord(s).key);
    if (key) sectionsByKey.set(key, s);
  }
  const sections: FypAiSectionInput[] = FYP_AI_SECTIONS.filter((s) =>
    sectionsByKey.has(s.key),
  ).map((s) => ({
    key: s.key,
    analysis: pickString(asRecord(sectionsByKey.get(s.key)).analysis),
  }));

  const redFlags = [
    ...parsingRedFlags,
    ...(Array.isArray(rec.redFlags) ? rec.redFlags : [])
      .map((f) => pickString(f))
      .filter(Boolean),
  ];

  return {
    dimensions,
    sections,
    why: pickString(rec.why) || undefined,
    whyNotHigher: pickString(rec.whyNotHigher) || undefined,
    sustainability: pickString(rec.sustainability) || undefined,
    opportunityPotential: pickString(rec.opportunityPotential) || undefined,
    redFlags,
    needsAdminReview: Boolean(rec.needsAdminReview) || redFlags.length > 0,
    studentFeedback: pickString(rec.studentFeedback) || undefined,
    frameworkVersion: pickString(rec.framework_version) || 'FYP-MM 1.0',
  };
}
