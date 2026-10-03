import type { CielPkAiEvaluationPayload } from './build-ciel-pk-ai-evaluation-payload.util';

/**
 * Admin/faculty-only integrity checks shown beside the CII v2 score (hold = blocks verification
 * until resolved, review = needs a human look). Additive to `ciiV2` — never feeds the score
 * and never released to student/partner/university (see cii-v2-redaction.util.ts).
 */
export type CiiIntegrityCheck = {
  level: 'hold' | 'review';
  title: string;
  detail: string;
  source: 'system' | 'ai';
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Deterministic checks computed from the canonical AI payload (no extra AI call). */
export function buildSystemIntegrityChecks(
  payload: Pick<
    CielPkAiEvaluationPayload,
    | 'section1_participation_identity_attendance'
    | 'uploaded_evidence_files'
    | 'system_validation'
  >,
): CiiIntegrityCheck[] {
  const checks: CiiIntegrityCheck[] = [];

  const summary = asRecord(
    payload.section1_participation_identity_attendance?.attendance_summary,
  );
  const below = Array.isArray(summary.students_below_required_hours)
    ? summary.students_below_required_hours
    : [];
  if (summary.required_hours_met === false && below.length > 0) {
    checks.push({
      level: 'hold',
      title: 'Team hours incomplete',
      detail: `${below.length} team member(s) are below the ${Number(summary.minimum_required_hours_per_student) || ''} required hours. Aggregate team hours cannot replace the individual minimum.`,
      source: 'system',
    });
  }

  const files = payload.uploaded_evidence_files ?? [];
  if (files.length === 0) {
    checks.push({
      level: 'hold',
      title: 'No evidence files attached',
      detail:
        'The report has no uploaded evidence files to verify its claims against.',
      source: 'system',
    });
  }

  const warnings = payload.system_validation?.validation_warnings;
  if (Array.isArray(warnings)) {
    for (const w of warnings) {
      if (typeof w === 'string' && w.trim()) {
        checks.push({
          level: 'review',
          title: 'Validation warning',
          detail: w.trim(),
          source: 'system',
        });
      }
    }
  }

  return checks;
}

/** System checks first, then AI-supplied ones; exact duplicates (same title+detail) dropped. */
export function mergeIntegrityChecks(
  system: CiiIntegrityCheck[],
  ai: Array<Omit<CiiIntegrityCheck, 'source'>> | undefined,
): CiiIntegrityCheck[] {
  const out = [...system];
  const seen = new Set(out.map((c) => `${c.title}|${c.detail}`.toLowerCase()));
  for (const c of ai ?? []) {
    const key = `${c.title}|${c.detail}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...c, source: 'ai' });
  }
  return out;
}
