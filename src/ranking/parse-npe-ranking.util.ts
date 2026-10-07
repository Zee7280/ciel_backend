import { extractSection11JsonObject } from '../ai/parse-section11-v61.util';
import {
  NPE_CRITERION_KEYS,
  NPE_EVIDENCE_FACTORS,
  type NpeCriterionKey,
  type NpeEvidenceConfidence,
} from './npe-ranking.constants';
import type { NpeCriterionJudgment } from './npe-ranking.scoring';

export type NpeClaim = {
  id: string;
  criterion: string;
  statement: string;
  source: string;
  locator: string;
  support: NpeEvidenceConfidence;
  limitation: string;
};

export type NpeAiEvaluation = {
  projectId: string;
  packageVersion: string;
  readComplete: boolean;
  flags: string[];
  summary: string;
  limitations: string;
  criteria: Record<NpeCriterionKey, NpeCriterionJudgment>;
  claims: NpeClaim[];
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asConfidence(value: unknown): NpeEvidenceConfidence | null {
  const key = String(value || '').trim().toLowerCase();
  return key in NPE_EVIDENCE_FACTORS ? (key as NpeEvidenceConfidence) : null;
}

export function parseNpeRankingResponse(raw: string): NpeAiEvaluation | null {
  const parsed = extractSection11JsonObject(raw);
  const rec = asRecord(parsed);
  if (!rec) return null;
  if (typeof rec.projectId !== 'string' || !rec.projectId.trim()) return null;
  if (typeof rec.packageVersion !== 'string' || !rec.packageVersion.trim()) {
    return null;
  }
  if (typeof rec.readComplete !== 'boolean') return null;
  if (!Array.isArray(rec.flags) || rec.flags.some((f) => typeof f !== 'string')) {
    return null;
  }
  if (typeof rec.summary !== 'string' || typeof rec.limitations !== 'string') {
    return null;
  }
  if (!Array.isArray(rec.claims)) return null;
  const claims: NpeClaim[] = [];
  const claimIds = new Set<string>();
  for (const rawClaim of rec.claims) {
    const c = asRecord(rawClaim);
    if (!c || typeof c.id !== 'string' || claimIds.has(c.id)) return null;
    const support = asConfidence(c.support);
    if (!support) return null;
    for (const key of ['statement', 'source', 'locator', 'limitation', 'criterion'] as const) {
      if (typeof c[key] !== 'string') return null;
    }
    claimIds.add(c.id);
    claims.push({
      id: c.id,
      criterion: String(c.criterion),
      statement: String(c.statement),
      source: String(c.source),
      locator: String(c.locator),
      support,
      limitation: String(c.limitation),
    });
  }
  const criteria = {} as Record<NpeCriterionKey, NpeCriterionJudgment>;
  const criteriaRec = asRecord(rec.criteria);
  if (!criteriaRec) return null;
  for (const key of NPE_CRITERION_KEYS) {
    const v = asRecord(criteriaRec[key]);
    if (!v) return null;
    const anchor = Number(v.anchor);
    const confidence = asConfidence(v.confidence);
    if (
      !Number.isFinite(anchor) ||
      anchor < 0 ||
      anchor > 5 ||
      !confidence ||
      typeof v.reason !== 'string' ||
      !Array.isArray(v.claimIds) ||
      !v.claimIds.every((id) => typeof id === 'string' && claimIds.has(id))
    ) {
      return null;
    }
    if (confidence !== 'unsupported' && v.claimIds.length === 0) return null;
    criteria[key] = {
      anchor,
      confidence,
      reason: v.reason,
      claimIds: v.claimIds as string[],
    };
  }
  return {
    projectId: rec.projectId.trim(),
    packageVersion: rec.packageVersion.trim(),
    readComplete: rec.readComplete,
    flags: rec.flags as string[],
    summary: rec.summary,
    limitations: rec.limitations,
    criteria,
    claims,
  };
}

export function unreadNpeEvaluation(
  projectId: string,
  packageVersion: string,
  flags: string[],
): NpeAiEvaluation {
  const empty = {
    anchor: 0,
    confidence: 'unsupported' as const,
    reason: 'Material source could not be read. No comparative marks awarded.',
    claimIds: [] as string[],
  };
  const criteria = {} as Record<NpeCriterionKey, NpeCriterionJudgment>;
  for (const key of NPE_CRITERION_KEYS) criteria[key] = { ...empty };
  return {
    projectId,
    packageVersion,
    readComplete: false,
    flags,
    summary: 'Held for review — material evidence or package could not be read.',
    limitations: flags.join('; ') || 'Unread source.',
    criteria,
    claims: [],
  };
}
