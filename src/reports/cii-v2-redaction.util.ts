/**
 * Single source of truth for what a non-faculty viewer (student, NGO/partner, university,
 * super admin) is allowed to see of a report's CII v2 result. Faculty gets the full raw
 * `report.ciiV2`/`ciiV2Lock` — everyone else only ever sees this redacted subset: never
 * per-criterion anchors/notes, never the evidence row's numeric match score or internal "why",
 * never bonus/integrity rationale text. Extracted from `StudentReportsService.
 * redactCiiV2ForExternalViewer` so every new "let role X see the CII breakdown" surface reuses
 * the same whitelist instead of re-deciding it — repeat this, don't hand-roll a new subset.
 */

export interface RedactedCiiV2Lock {
  locked: boolean;
  hash?: string;
  lockedAt?: string;
  aiRecommendedScore?: number;
  facultyApprovedScore?: number;
  scoreWasAdjusted?: boolean;
  scoreAdjustmentReason?: string;
  facultyNote?: string;
}

export interface RedactedCiiV2 {
  final?: unknown;
  level?: unknown;
  evidenceAverage?: unknown;
  sections: Array<{
    id: unknown;
    title: unknown;
    weight: unknown;
    score: unknown;
    good?: unknown;
    limit?: unknown;
  }>;
  evidence?: Array<{
    id: unknown;
    type: unknown;
    claim: unknown;
    verdict: unknown;
  }>;
  aiRecommendedScore?: unknown;
  facultyApprovedScore?: unknown;
  bonus: { effort: number; resources: number; partners: number; total: number };
  integrityPenalty: unknown;
  studentFeedback?: unknown;
  redFlags?: unknown;
}

export type CiiV2LockInput =
  | {
      locked?: boolean;
      hash?: string;
      lockedAt?: string;
      aiRecommendedScore?: number;
      facultyApprovedScore?: number;
      scoreWasAdjusted?: boolean;
      scoreAdjustmentReason?: string;
      facultyNote?: string;
    }
  | null
  | undefined;

export function redactCiiV2Fields(
  ciiV2: Record<string, unknown> | null | undefined,
  ciiV2Lock: CiiV2LockInput,
): { ciiV2: RedactedCiiV2 | null; ciiV2Lock: RedactedCiiV2Lock | null } {
  if (!ciiV2Lock?.locked) {
    return { ciiV2: null, ciiV2Lock: null };
  }

  const sections = Array.isArray(ciiV2?.sections)
    ? (ciiV2.sections as Array<Record<string, unknown>>).map((s) => ({
        id: s.id,
        title: s.title,
        weight: s.weight,
        score: s.score,
        good: s.good,
        limit: s.limit,
      }))
    : [];

  const bonus = ciiV2?.bonus as
    | { effort?: number; resources?: number; partners?: number; total?: number }
    | undefined;

  const studentFeedback = ciiV2?.studentFeedback as
    | {
        opening_praise?: string;
        why_score_is_high_or_low?: string;
        encouragement?: string;
        five_specific_actions?: string[];
      }
    | undefined;

  const redFlags = Array.isArray(ciiV2?.redFlags) ? ciiV2.redFlags : undefined;

  const evidence = Array.isArray(ciiV2?.evidence)
    ? (ciiV2.evidence as Array<Record<string, unknown>>).map((e) => ({
        id: e.id,
        type: e.type,
        claim: e.claim,
        verdict: e.verdict,
      }))
    : undefined;

  return {
    ciiV2: {
      final: ciiV2?.final,
      level: ciiV2?.level,
      evidenceAverage: ciiV2?.evidenceAverage,
      sections,
      evidence,
      aiRecommendedScore:
        ciiV2?.aiRecommendedScore ?? ciiV2Lock.aiRecommendedScore,
      facultyApprovedScore:
        ciiV2?.facultyApprovedScore ?? ciiV2Lock.facultyApprovedScore,
      bonus: bonus
        ? {
            effort: bonus.effort ?? 0,
            resources: bonus.resources ?? 0,
            partners: bonus.partners ?? 0,
            total: bonus.total ?? 0,
          }
        : { effort: 0, resources: 0, partners: 0, total: 0 },
      integrityPenalty: ciiV2?.integrityPenalty ?? 0,
      studentFeedback,
      redFlags,
    },
    ciiV2Lock: {
      locked: true,
      hash: ciiV2Lock.hash,
      lockedAt: ciiV2Lock.lockedAt,
      aiRecommendedScore: ciiV2Lock.aiRecommendedScore,
      facultyApprovedScore: ciiV2Lock.facultyApprovedScore,
      scoreWasAdjusted: ciiV2Lock.scoreWasAdjusted,
      scoreAdjustmentReason: ciiV2Lock.scoreAdjustmentReason,
      facultyNote: ciiV2Lock.facultyNote,
    },
  };
}
