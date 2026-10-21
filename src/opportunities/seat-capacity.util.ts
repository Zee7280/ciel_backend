import { In, IsNull, type EntityManager } from 'typeorm';
import { Participation } from '../engagement/entities/participant.entity';
import { OpportunityApplication } from './entities/opportunity-application.entity';
import { isTeamApplyFromParticipationAndMembers } from './apply-team-payload.util';

/**
 * Seat accounting shared by every path that can take a place on a listing (Apply Now, report-stage
 * teammate registration). Seats = participations in an occupied status + people on applications
 * still in the join pipeline. Callers lock the listing first so check-then-insert is atomic.
 */

/** Participation statuses that hold a seat. */
export const OCCUPIED_SEAT_STATUSES = [
  'pending',
  'accepted',
  'approved',
  'verified',
  'paid',
  'pending_payment_approval',
  'pending_ciel_approval',
  'pending_faculty_approval',
] as const;

/** Join applications still waiting for a decision (each holds its lead + listed teammates). */
export const PENDING_PIPELINE_STATUSES = [
  'pending_faculty',
  'pending_partner',
  'pending_admin',
] as const;

const normEmail = (email: unknown) =>
  typeof email === 'string' ? email.trim().toLowerCase() : '';

/**
 * Seats one pending application holds: 1 for an individual, or the lead plus every distinct teammate
 * email (blank and lead duplicates ignored) for a team application.
 */
export function pendingApplicationSeatCount(
  applyPayload: Record<string, unknown> | null | undefined,
  leadEmail: string | null | undefined,
): number {
  const payload =
    applyPayload && typeof applyPayload === 'object' ? applyPayload : {};
  const raw = Array.isArray(payload['team_members'])
    ? (payload['team_members'] as Array<{ email?: unknown }>)
    : [];
  const pt =
    typeof payload['participation_type'] === 'string'
      ? payload['participation_type'].trim().toLowerCase()
      : '';
  const isTeam =
    pt === 'team' ||
    isTeamApplyFromParticipationAndMembers(payload['participation_type'], raw);
  if (!isTeam) return 1;
  const lead = normEmail(leadEmail);
  const seen = new Set<string>();
  for (const m of raw) {
    const e = normEmail(m?.email);
    if (e && e !== lead) seen.add(e);
  }
  return 1 + seen.size;
}

/** Occupied + in-flight seats on a listing, read through `manager` (use the locking transaction's). */
export async function countOccupiedSeats(
  manager: EntityManager,
  opportunityId: string,
): Promise<number> {
  const [participations, pending] = await Promise.all([
    manager.count(Participation, {
      where: {
        projectId: opportunityId,
        status: In([...OCCUPIED_SEAT_STATUSES]),
      },
    }),
    manager.find(OpportunityApplication, {
      where: {
        opportunityId,
        withdrawnAt: IsNull(),
        internalStatus: In([...PENDING_PIPELINE_STATUSES]),
      },
      relations: ['studentUser'],
    }),
  ]);
  let inFlight = 0;
  for (const app of pending) {
    inFlight += pendingApplicationSeatCount(
      app.applyPayload,
      app.studentUser?.email,
    );
  }
  return participations + inFlight;
}

/**
 * Serialises seat-taking on one listing until the surrounding transaction commits or rolls back.
 * Must be called inside `manager.transaction(...)`; every seat path uses the same key.
 */
export async function lockOpportunitySeats(
  manager: EntityManager,
  opportunityId: string,
): Promise<void> {
  await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
    `opportunity_seats:${opportunityId}`,
  ]);
}

/** Message when `requested` more seats do not fit; null when they do (or the listing has no cap). */
export function seatsUnavailableMessage(
  seats: number,
  occupied: number,
  requested: number,
): string | null {
  if (!seats || occupied + requested <= seats) return null;
  const free = Math.max(0, seats - occupied);
  return free === 0
    ? 'All seats for this opportunity are taken.'
    : `Only ${free} seat${free === 1 ? '' : 's'} left, but this application needs ${requested}.`;
}
