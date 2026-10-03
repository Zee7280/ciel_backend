/** Opportunity `timeline.volunteers_required` as a positive integer cap, or 0 when unset (no cap). */
export function resolveTeamSeatCap(volunteersRequired: unknown): number {
  const n = Math.floor(Number(volunteersRequired));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Message when the team (team lead + `memberCount` members) would exceed the opportunity's seats,
 * i.e. members may not exceed seats − 1; null when allowed.
 */
export function teamCapacityError(memberCount: number, seats: number): string | null {
  if (!seats || memberCount + 1 <= seats) return null;
  const maxMembers = Math.max(0, seats - 1);
  return `This opportunity has ${seats} seat${seats === 1 ? '' : 's'} (team lead + ${maxMembers} member${maxMembers === 1 ? '' : 's'}). Remove a member before adding another.`;
}
