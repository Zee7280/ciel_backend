/** Platform-wide maximum team size (team lead included). */
export const MAX_TEAM_SIZE = 20;

/** Opportunity `timeline.volunteers_required` as a positive integer cap, or 0 when unset (no cap). */
export function resolveTeamSeatCap(volunteersRequired: unknown): number {
  const n = Math.floor(Number(volunteersRequired));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Lead + members cap for one team. Listings built with a `team_mode` (private team / open
 * opportunity) also cap every report team at MAX_TEAM_SIZE; legacy listings (`team_mode` null)
 * keep the seats-only rule so their behaviour does not change.
 */
export function resolveTeamSizeCap(opportunity: {
  timeline?: unknown;
  team_mode?: string | null;
}): number {
  const seats = resolveTeamSeatCap(
    opportunity.timeline && typeof opportunity.timeline === 'object'
      ? (opportunity.timeline as { volunteers_required?: unknown })
          .volunteers_required
      : undefined,
  );
  if (!opportunity.team_mode) return seats;
  return seats ? Math.min(seats, MAX_TEAM_SIZE) : MAX_TEAM_SIZE;
}

/**
 * Message when the team (team lead + `memberCount` members) would exceed the opportunity's seats,
 * i.e. members may not exceed seats − 1; null when allowed.
 */
export function teamCapacityError(
  memberCount: number,
  seats: number,
): string | null {
  if (!seats || memberCount + 1 <= seats) return null;
  const maxMembers = Math.max(0, seats - 1);
  return `This opportunity has ${seats} seat${seats === 1 ? '' : 's'} (team lead + ${maxMembers} member${maxMembers === 1 ? '' : 's'}). Remove a member before adding another.`;
}

/** `teamCapacityError` against `resolveTeamSizeCap`, worded for whichever limit is hit. */
export function teamSizeCapError(
  memberCount: number,
  opportunity: { timeline?: unknown; team_mode?: string | null },
): string | null {
  const cap = resolveTeamSizeCap(opportunity);
  if (!cap || memberCount + 1 <= cap) return null;
  const seats = resolveTeamSizeCap({ timeline: opportunity.timeline });
  if (!seats || cap < seats) {
    return `A team can have at most ${MAX_TEAM_SIZE} members including the team lead. Remove a member before adding another.`;
  }
  return teamCapacityError(memberCount, cap);
}
