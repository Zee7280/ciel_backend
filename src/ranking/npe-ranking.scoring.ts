import {
  NPE_CRITERIA,
  NPE_EVIDENCE_FACTORS,
  type NpeCriterionKey,
  type NpeEvidenceConfidence,
} from './npe-ranking.constants';

export type NpeCriterionJudgment = {
  anchor: number;
  confidence: NpeEvidenceConfidence;
  reason: string;
  claimIds: string[];
};

export type NpeScoreBreakdown = {
  cii: number;
  criteria: Record<NpeCriterionKey, number>;
  total: number;
};

export function npeCiiAnchor(lockedCii: number): number {
  if (!Number.isFinite(lockedCii)) return 0;
  return Math.min(100, lockedCii) * 0.15;
}

export function npeCalculate(
  lockedCii: number,
  criteria: Record<NpeCriterionKey, NpeCriterionJudgment>,
): NpeScoreBreakdown {
  const cii = npeCiiAnchor(lockedCii);
  const scores = {} as Record<NpeCriterionKey, number>;
  for (const row of NPE_CRITERIA) {
    const judgment = criteria[row.key];
    if (
      !judgment ||
      !Number.isFinite(judgment.anchor) ||
      !(judgment.confidence in NPE_EVIDENCE_FACTORS)
    ) {
      throw new Error(`NPE judgment missing or invalid for ${row.key}`);
    }
    const factor = NPE_EVIDENCE_FACTORS[judgment.confidence];
    scores[row.key] = row.weight * (judgment.anchor / 5) * factor;
  }
  const total =
    Math.round(
      (cii + NPE_CRITERIA.reduce((sum, row) => sum + scores[row.key], 0)) * 100,
    ) / 100;
  return { cii, criteria: scores, total };
}

export function npeSortTuple(row: {
  total: number;
  impact: number;
  sustain: number;
  cii: number;
}): [number, number, number, number] {
  return [
    row.total,
    Math.round(row.impact * 10000),
    Math.round(row.sustain * 10000),
    row.cii,
  ];
}

export function npeTupleCompare(
  a: { total: number; impact: number; sustain: number; cii: number },
  b: { total: number; impact: number; sustain: number; cii: number },
): number {
  const aa = npeSortTuple(a);
  const bb = npeSortTuple(b);
  for (let i = 0; i < aa.length; i++) {
    if (aa[i] !== bb[i]) return bb[i] - aa[i];
  }
  return 0;
}

/** Competition ranking: identical tuples share a rank (1, 1, 3). ID is display-only. */
export function npeRankPool<
  T extends { total: number; impact: number; sustain: number; cii: number; id: string },
>(rows: T[]): Array<T & { rank: number }> {
  const sorted = rows.slice().sort(
    (a, b) => npeTupleCompare(a, b) || a.id.localeCompare(b.id),
  );
  let last: T | null = null;
  let rank = 0;
  return sorted.map((row, i) => {
    if (!last || npeTupleCompare(row, last) !== 0) rank = i + 1;
    last = row;
    return { ...row, rank };
  });
}

export function npePercentile(rank: number, n: number): number | null {
  if (n <= 1) return null;
  return Math.round((100 * (n - rank) / (n - 1)) * 10) / 10;
}
