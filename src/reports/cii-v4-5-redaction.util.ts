/**
 * Single source of truth for what a non-admin viewer (student, NGO/partner, university, faculty)
 * is allowed to see of a report's CII v4.5 result. Admin gets the full raw `report.ciiV45`/
 * `ciiV45Lock`; everyone else only ever sees this redacted subset: never
 * `claimInventory[].text`, `evidenceAudit[].actualContentSummary`, per-criterion
 * `reasoningSummary`/`sourceRefs`/`deductionReason`, `adminReviewReasons` detail, or
 * `exceptionalFeature.explanation`.
 *
 * Score, badge and section totals are visible to every role as soon as analysis exists.
 * Per-criterion reasoning, claim text and evidence-content audits stay stripped.
 */

export interface RedactedCiiV45Lock {
  locked: boolean;
  hash?: string;
  lockedAt?: string;
  aiRecommendedScore?: number;
  adminApprovedScore?: number;
  scoreWasModerated?: boolean;
  scoreModerationReason?: string;
  /** R3: `L6_PENDING_QUALIFICATION` = a 90+ CII retained without an L6 award yet. Status only. */
  badgeStatus?: string | null;
}

export interface RedactedCiiV45Badge {
  code: unknown;
  name: unknown;
  level: unknown;
  numericLevel: unknown;
  gateCapped: unknown;
}

export interface RedactedCiiV45 {
  finalCII?: unknown;
  diagnosticCII?: unknown;
  frameworkVersion?: unknown;
  aiReportScore?: unknown;
  adminEvidenceScore?: unknown;
  baseCII?: unknown;
  knownBasePoints?: unknown;
  finalBadge: RedactedCiiV45Badge | null;
  recommendedBadge: RedactedCiiV45Badge | null;
  diagnosticBadge: RedactedCiiV45Badge | null;
  /** R3: the band the CII lands in and its award status (never the L6 qualification reasons). */
  candidateBadge?: RedactedCiiV45Badge | null;
  badgeStatus?: string | null;
  rubricVersion?: unknown;
  sectionScores: Array<{
    dimension: unknown;
    name: unknown;
    maximumPoints: unknown;
    score: unknown;
  }>;
  extraMileUplift: { total: unknown };
  integrityPenalty: { points: unknown };
  strengths?: unknown;
  developmentPriorities?: unknown;
  studentFeedback?: unknown;
}

export type CiiV45LockInput =
  | {
      locked?: boolean | string;
      hash?: string;
      lockedAt?: string;
      aiRecommendedScore?: number;
      adminApprovedScore?: number;
      scoreWasModerated?: boolean;
      scoreModerationReason?: string;
      badgeStatus?: string | null;
      rubricVersion?: string;
    }
  | null
  | undefined;

function redactBadge(badge: unknown): RedactedCiiV45Badge | null {
  if (!badge || typeof badge !== 'object') return null;
  const b = badge as Record<string, unknown>;
  return {
    code: b.code,
    name: b.name,
    level: b.level,
    numericLevel: b.numericLevel,
    gateCapped: b.gateCapped,
  };
}

function redactLock(
  ciiV45Lock: CiiV45LockInput,
  locked: boolean,
): RedactedCiiV45Lock | null {
  if (!ciiV45Lock) return null;
  if (!locked) return { locked: false };
  // R3 locks record the AI baseline and that criterion marks were reviewed; that is an Admin audit
  // detail, so a non-admin only ever sees the approved number (as before R3, when it was always
  // unmoderated).
  const r3 = Boolean(ciiV45Lock.rubricVersion);
  return {
    locked: true,
    hash: ciiV45Lock.hash,
    lockedAt: ciiV45Lock.lockedAt,
    aiRecommendedScore: r3
      ? ciiV45Lock.adminApprovedScore
      : ciiV45Lock.aiRecommendedScore,
    adminApprovedScore: ciiV45Lock.adminApprovedScore,
    scoreWasModerated: r3 ? false : ciiV45Lock.scoreWasModerated,
    scoreModerationReason: r3 ? undefined : ciiV45Lock.scoreModerationReason,
    ...(ciiV45Lock.badgeStatus ? { badgeStatus: ciiV45Lock.badgeStatus } : {}),
  };
}

export function redactCiiV45Fields(
  ciiV45: Record<string, unknown> | null | undefined,
  ciiV45Lock: CiiV45LockInput,
): {
  ciiV45: RedactedCiiV45 | null;
  ciiV45Lock: RedactedCiiV45Lock | null;
} {
  const locked = ciiV45Lock?.locked === true || ciiV45Lock?.locked === 'true';
  if (!ciiV45) {
    return { ciiV45: null, ciiV45Lock: redactLock(ciiV45Lock, locked) };
  }

  const sectionScores = Array.isArray(ciiV45.sectionScores)
    ? (ciiV45.sectionScores as Array<Record<string, unknown>>).map((s) => ({
        dimension: s.dimension,
        name: s.name,
        maximumPoints: s.maximumPoints,
        score: s.score,
      }))
    : [];

  const extraMileUplift = ciiV45.extraMileUplift as
    | { total?: unknown }
    | undefined;
  const integrityPenalty = ciiV45.integrityPenalty as
    | { points?: unknown }
    | undefined;

  return {
    ciiV45: {
      finalCII: ciiV45.finalCII,
      diagnosticCII: ciiV45.diagnosticCII,
      finalBadge: redactBadge(ciiV45.finalBadge),
      recommendedBadge: redactBadge(ciiV45.recommendedBadge),
      diagnosticBadge: redactBadge(ciiV45.diagnosticBadge),
      ...(locked && ciiV45.badgeStatus
        ? {
            candidateBadge: redactBadge(ciiV45.candidateBadge),
            badgeStatus: ciiV45.badgeStatus as string,
          }
        : {}),
      ...(ciiV45.rubricVersion ? { rubricVersion: ciiV45.rubricVersion } : {}),
      sectionScores,
      extraMileUplift: { total: extraMileUplift?.total ?? null },
      integrityPenalty: { points: integrityPenalty?.points ?? 0 },
      frameworkVersion: ciiV45.frameworkVersion,
      aiReportScore: ciiV45.aiReportScore,
      adminEvidenceScore: ciiV45.adminEvidenceScore,
      baseCII: ciiV45.baseCII,
      knownBasePoints: ciiV45.knownBasePoints,
      strengths: ciiV45.strengths,
      developmentPriorities: ciiV45.developmentPriorities,
      studentFeedback: ciiV45.studentFeedback,
    },
    ciiV45Lock: redactLock(ciiV45Lock, locked),
  };
}

/**
 * Independent (re-run) AI analyses for non-admin viewers: only once the CII v4.5 is locked/
 * published, and only the fields the Impact Wall trend needs. Never per-section scores, uplift /
 * integrity detail, student-feedback text or the runner's user id.
 */
export function redactIndependentAnalysesForExternal(
  analyses: unknown,
  ciiV45Lock: CiiV45LockInput,
): Array<Record<string, unknown>> | null {
  const locked = ciiV45Lock?.locked === true || ciiV45Lock?.locked === 'true';
  if (!locked || !Array.isArray(analyses)) return null;
  return (analyses as Array<Record<string, unknown>>)
    .filter((a) => a && typeof a === 'object')
    .map((a) => {
      const badge = redactBadge(a.badge);
      return {
        id: a.id,
        runAt: a.runAt,
        runByRole: a.runByRole,
        runByName: a.runByName,
        score: a.score,
        badge,
        note: a.note,
      };
    });
}
