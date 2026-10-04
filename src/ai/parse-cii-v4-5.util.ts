import { extractSection11JsonObject } from './parse-section11-v61.util';
import { CiiV45EvaluatorPayload } from '../reports/cii-v4-5.constants';

/**
 * Parses the CII v4.5 AI evaluator's raw JSON response.
 *
 * Mostly strict parsing + shape validation rather than reshaping: the v4.5
 * schema is already the AI's exact required output contract
 * (claimInventory/evidenceAudit are first-class top-level arrays, not
 * embedded). Returns `null` on any required-key omission or parse failure,
 * which the caller turns into a "please retry" error rather than scoring a
 * wrong/partial shape.
 */

const REQUIRED_KEYS: (keyof CiiV45EvaluatorPayload)[] = [
  'frameworkVersion',
  'reportId',
  'inputFingerprint',
  'inputCompleteness',
  'claimInventory',
  'evidenceAudit',
  'sectionScores',
  'deductionLedger',
  'extraMileUplift',
  'integrityPenalty',
  'exceptionalFeature',
  'adminReviewReasons',
  'strengths',
  'developmentPriorities',
  'analysisSummary',
  'evidenceSummary',
  'studentFeedback',
];

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

export function parseCiiV45Response(raw: string): CiiV45EvaluatorPayload | null {
  const parsed = extractSection11JsonObject(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const value = parsed as Record<string, unknown>;

  // exceptionalFeature is nullable by contract; every other required key must be present
  // (though it may legitimately be an empty array/string) — a missing key forces a retry
  // rather than silently defaulting to a wrong shape.
  for (const key of REQUIRED_KEYS) {
    if (key === 'exceptionalFeature') continue;
    if (!hasOwn(value, key) || value[key] === undefined) return null;
  }
  if (!hasOwn(value, 'exceptionalFeature')) return null;

  if (value.frameworkVersion !== '4.5') return null;
  if (typeof value.reportId !== 'string' || !value.reportId.trim()) return null;
  if (typeof value.inputFingerprint !== 'string' || !value.inputFingerprint.trim()) return null;
  if (!Array.isArray(value.sectionScores)) return null;
  if (!Array.isArray(value.claimInventory)) return null;
  if (!Array.isArray(value.evidenceAudit)) return null;
  if (!Array.isArray(value.deductionLedger)) return null;
  if (!Array.isArray(value.adminReviewReasons)) return null;
  if (!Array.isArray(value.strengths)) return null;
  if (!Array.isArray(value.developmentPriorities)) return null;

  const payload = value as unknown as CiiV45EvaluatorPayload;

  // The AI must never assert a positive integrity penalty — only a separately-saved, verified
  // Admin adjudication can (not implemented in this core-swap pass). Force it to zero/empty on
  // ingestion as a belt-and-suspenders guard against a model that ignores that instruction.
  payload.integrityPenalty = { points: 0, issues: [] };

  return payload;
}
