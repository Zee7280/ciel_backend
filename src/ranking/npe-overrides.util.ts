import { NPE_CRITERION_KEYS } from './npe-ranking.constants';
import type { NpeCriterionJudgment } from './npe-ranking.scoring';

/** The part of a stored correction the scorer needs. */
export type NpeOverrideInput = {
  id: string;
  criterion: string;
  anchor: number;
  packageVersion: string;
  originalAnchor?: number | null;
  locator?: string;
  reason?: string;
  createdAt?: Date | string;
  createdByUserId?: string;
  role?: string;
};

export type NpeAppliedOverride = {
  id: string;
  criterion: string;
  anchor: number;
  aiAnchor: number;
  locator: string;
  reason: string;
  createdAt: string | null;
  createdByUserId: string | null;
  role: string | null;
};

/**
 * Lays Admin criterion corrections over the AI judgment of one project (NPE-1.3).
 *  - The AI judgment is never mutated; the returned `criteria` is a new object.
 *  - Only corrections made for the same package version apply; a correction made before the report
 *    was re-approved is reported as `stale` and ignored (the new content was never reviewed).
 *  - Confidence is kept from the AI: a correction changes the anchor, not the evidence factor, and
 *    an `unsupported` criterion is never corrected upward here (the service refuses to save one).
 *  - Unknown criterion keys are ignored.
 */
export function applyCriterionOverrides(
  criteria: Record<string, NpeCriterionJudgment>,
  overrides: NpeOverrideInput[],
  packageVersion: string,
): {
  criteria: Record<string, NpeCriterionJudgment>;
  applied: NpeAppliedOverride[];
  stale: string[];
} {
  const out: Record<string, NpeCriterionJudgment> = { ...criteria };
  const applied: NpeAppliedOverride[] = [];
  const stale: string[] = [];
  for (const o of overrides) {
    if (!(NPE_CRITERION_KEYS as readonly string[]).includes(o.criterion))
      continue;
    const base = criteria[o.criterion];
    if (!base) continue;
    if (o.packageVersion !== packageVersion) {
      stale.push(o.criterion);
      continue;
    }
    if (base.confidence === 'unsupported') continue;
    const anchor = Math.max(0, Math.min(5, Math.round(Number(o.anchor))));
    if (!Number.isFinite(anchor)) continue;
    out[o.criterion] = { ...base, anchor };
    applied.push({
      id: o.id,
      criterion: o.criterion,
      anchor,
      aiAnchor: Number(base.anchor),
      locator: o.locator ?? '',
      reason: o.reason ?? '',
      createdAt:
        o.createdAt instanceof Date
          ? o.createdAt.toISOString()
          : o.createdAt
            ? String(o.createdAt)
            : null,
      createdByUserId: o.createdByUserId ?? null,
      role: o.role ?? null,
    });
  }
  return { criteria: out, applied, stale };
}
