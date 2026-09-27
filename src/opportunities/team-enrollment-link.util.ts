/**
 * Admin roster: a seat is "wrong account link" when its student_id is not the
 * login account that owns the seat's email (same lookup as student login).
 */
export function participationStudentIdMislinked(args: {
  emailOwnerId?: string | null;
  studentId?: string | null;
}): boolean {
  const owner = (args.emailOwnerId || '').trim();
  const sid = (args.studentId || '').trim();
  return Boolean(owner && sid && owner !== sid);
}

/**
 * When a mislinked team seat and the email-owner's existing seat both exist,
 * keep the row that preserves team membership (do not yank the teammate into
 * a leftover individual enrollment).
 */
export function pickSeatToKeepWhenRelinking<
  T extends { id: string; teamId?: string | null; isTeamLead?: boolean },
>(ownerSeat: T, mislinkedSeat: T): T {
  const misTeam = (mislinkedSeat.teamId || '').trim();
  const ownTeam = (ownerSeat.teamId || '').trim();
  if (misTeam && !ownTeam) return mislinkedSeat;
  if (ownTeam && !misTeam) return ownerSeat;
  if (mislinkedSeat.isTeamLead && !ownerSeat.isTeamLead) return mislinkedSeat;
  if (ownerSeat.isTeamLead && !mislinkedSeat.isTeamLead) return ownerSeat;
  return mislinkedSeat;
}
