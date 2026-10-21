/**
 * Who may join a student-created listing (opportunity builder v7).
 *
 * - `private_team`: only the creator starts the report and adds teammates there (1–20 seats,
 *   creator included). Nobody applies.
 * - `open`: today's flow — eligible students apply; report teams stay within MAX_TEAM_SIZE.
 *
 * Stored on `opportunities.team_mode`. `null` is every legacy row and behaves exactly like the
 * pre-builder flow (open, no per-team 20 cap). Unrelated to the "Private / Independent Candidate"
 * pathway (`executing_context.student_pathway === 'private'`).
 */
export const TEAM_MODES = ['private_team', 'open'] as const;
export type TeamMode = (typeof TEAM_MODES)[number];

/** Private team capacity, creator included. */
export const PRIVATE_TEAM_MAX_SEATS = 20;

export const PRIVATE_TEAM_APPLY_BLOCKED_MESSAGE =
  'This is a private team. Only the creator adds members, from their report — ask them to add you.';

export const PRIVATE_TEAM_DISABLED_MESSAGE =
  'Private teams are not available yet. Choose Open Opportunity.';

export function isTeamMode(value: unknown): value is TeamMode {
  return (TEAM_MODES as readonly unknown[]).includes(value);
}

/** Error for a sent `team_mode` that is neither a known mode nor empty; null when acceptable. */
export function teamModeError(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  return isTeamMode(value)
    ? null
    : `team_mode must be one of: ${TEAM_MODES.join(', ')}`;
}

export function isPrivateTeamOpportunity(
  opportunity: { team_mode?: string | null } | null | undefined,
): boolean {
  return opportunity?.team_mode === 'private_team';
}

/** A private team must reserve 1–20 seats (`timeline.volunteers_required`, creator included). */
export function privateTeamSeatsError(timeline: unknown): string | null {
  const raw =
    timeline && typeof timeline === 'object'
      ? (timeline as { volunteers_required?: unknown }).volunteers_required
      : undefined;
  const n = Number(raw);
  if (Number.isInteger(n) && n >= 1 && n <= PRIVATE_TEAM_MAX_SEATS) return null;
  return `A private team has 1–${PRIVATE_TEAM_MAX_SEATS} seats including you. Choose Open Opportunity for larger campaigns.`;
}
