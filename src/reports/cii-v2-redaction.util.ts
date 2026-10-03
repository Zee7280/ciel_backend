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
      locked?: boolean | string;
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

export interface RedactCiiV2Options {
  /**
   * Partner / NGO / university viewers see the AI score as soon as the analyser has run (marked
   * `provisional: true` until faculty locks it). Student viewers must NOT pass this — they stay
   * locked-only. Same whitelist either way: integrityChecks, per-criterion anchors and AI
   * rationale are never included.
   */
  releaseProvisional?: boolean;
}

export function redactCiiV2Fields(
  ciiV2: Record<string, unknown> | null | undefined,
  ciiV2Lock: CiiV2LockInput,
  options: RedactCiiV2Options = {},
): {
  ciiV2: (RedactedCiiV2 & { provisional?: boolean }) | null;
  ciiV2Lock: RedactedCiiV2Lock | null;
} {
  const locked =
    ciiV2Lock?.locked === true || ciiV2Lock?.locked === 'true';
  if (!locked) {
    const hasScore =
      ciiV2 != null &&
      (typeof ciiV2.final === 'number' ||
        (typeof ciiV2.final === 'string' && ciiV2.final.trim() !== ''));
    if (!options.releaseProvisional || !hasScore) {
      return { ciiV2: null, ciiV2Lock: null };
    }
    const full = redactCiiV2Fields(
      ciiV2,
      { ...(ciiV2Lock ?? {}), locked: true },
      {},
    );
    // Provisional: strip anything that implies faculty sign-off, keep score/level/sections.
    return {
      ciiV2: full.ciiV2
        ? {
            ...full.ciiV2,
            studentFeedback: undefined,
            redFlags: undefined,
            aiRecommendedScore: undefined,
            facultyApprovedScore: undefined,
            provisional: true,
          }
        : null,
      ciiV2Lock: null,
    };
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

/**
 * Independent (re-run) AI analyses for non-faculty viewers: only once the CII is locked/published,
 * and only the fields the Impact Wall trend needs. Never per-section scores, bonus / integrity
 * detail, student-feedback text or the runner's user id.
 */
export function redactIndependentAnalysesForExternal(
  analyses: unknown,
  ciiV2Lock: CiiV2LockInput,
): Array<Record<string, unknown>> | null {
  const locked = ciiV2Lock?.locked === true || ciiV2Lock?.locked === 'true';
  if (!locked || !Array.isArray(analyses)) return null;
  return (analyses as Array<Record<string, unknown>>)
    .filter((a) => a && typeof a === 'object')
    .map((a) => {
      const level = a.level as { name?: unknown } | undefined;
      return {
        id: a.id,
        runAt: a.runAt,
        runByRole: a.runByRole,
        runByName: a.runByName,
        score: a.score,
        level: level && typeof level === 'object' ? { name: level.name } : undefined,
        note: a.note,
      };
    });
}
