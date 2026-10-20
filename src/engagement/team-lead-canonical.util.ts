import { FindOptionsWhere, Repository } from 'typeorm';
import { Participation } from './entities/participant.entity';

export type TeamLeadScope = {
  teamId?: string | null;
  applicationId?: string | null;
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function looksLikeParticipationProjectUuid(
  value?: string | null,
): boolean {
  return UUID_RE.test((value || '').trim());
}

/** Earliest `isTeamLead` row in scope; one lead per team/application group. */
export async function findCanonicalTeamLeadParticipation(
  repo: Repository<Participation>,
  projectId: string,
  scope?: TeamLeadScope,
): Promise<Participation | null> {
  const pid = projectId.trim();
  if (!looksLikeParticipationProjectUuid(pid)) {
    return null;
  }

  const teamId = (scope?.teamId || '').trim();
  const applicationId = (scope?.applicationId || '').trim();

  const where: FindOptionsWhere<Participation> = {
    projectId: pid,
    participationMode: 'team',
    isTeamLead: true,
  };
  if (teamId) {
    where.teamId = teamId;
  } else if (applicationId) {
    where.applicationId = applicationId;
  }

  const leads = await repo.find({
    where,
    order: { createdAt: 'ASC', id: 'ASC' },
  });
  return leads[0] ?? null;
}

export async function findCanonicalTeamLeadStudentId(
  repo: Repository<Participation>,
  projectId: string,
  scope?: TeamLeadScope,
): Promise<string | null> {
  const row = await findCanonicalTeamLeadParticipation(repo, projectId, scope);
  return row?.studentId ?? null;
}

/** Team seat: explicit team mode, or a shared `teamId` even if mode still defaults to individual. */
export function enrollmentLooksLikeTeam(
  participation?: Pick<Participation, 'participationMode' | 'teamId'> | null,
): boolean {
  if (!participation) return false;
  if (participation.participationMode === 'team') return true;
  return Boolean((participation.teamId || '').trim());
}

/**
 * One student can have an individual leftover row plus a later team seat on the same project.
 * Prefer the team seat so teammates resolve the shared lead report instead of an empty own draft.
 */
export function pickPreferredProjectEnrollment(
  rows: Participation[],
): Participation | null {
  if (!rows.length) return null;
  const teamish = rows.filter((row) => enrollmentLooksLikeTeam(row));
  const pool = teamish.length ? teamish : rows;
  return [...pool].sort((a, b) => {
    if (a.isTeamLead !== b.isTeamLead) return a.isTeamLead ? -1 : 1;
    const aTeam = a.participationMode === 'team' ? 1 : 0;
    const bTeam = b.participationMode === 'team' ? 1 : 0;
    if (aTeam !== bTeam) return bTeam - aTeam;
    const aTime = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    const bTime = b.createdAt ? new Date(b.createdAt).getTime() : 0;
    return (
      aTime - bTime || String(a.id || '').localeCompare(String(b.id || ''))
    );
  })[0];
}

export async function findPreferredProjectEnrollment(
  repo: Repository<Participation>,
  studentId: string,
  projectId: string,
  options?: { relations?: string[] },
): Promise<Participation | null> {
  const pid = projectId.trim();
  const sid = studentId.trim();
  if (!sid || !pid) return null;
  if (typeof repo.find === 'function') {
    const rows = await repo.find({
      where: { studentId: sid, projectId: pid },
      ...(options?.relations ? { relations: options.relations } : {}),
    });
    if (Array.isArray(rows) && rows.length > 0) {
      return pickPreferredProjectEnrollment(rows);
    }
  }
  if (typeof repo.findOne === 'function') {
    return repo.findOne({
      where: { studentId: sid, projectId: pid },
      ...(options?.relations ? { relations: options.relations } : {}),
    });
  }
  return null;
}

function rosterKey(row: Pick<Participation, 'id' | 'studentId'>): string {
  const id = (row.id || '').trim();
  if (id) return id;
  return `student:${(row.studentId || '').trim()}`;
}

/**
 * Everyone on the viewer's team for this project: same `teamId`, then same `applicationId`.
 * Does not require `participationMode === 'team'` on every row (Section 1 adds can leave it individual).
 */
export async function loadSameTeamParticipations(
  repo: Repository<Participation>,
  projectId: string,
  viewer: Pick<
    Participation,
    | 'id'
    | 'studentId'
    | 'teamId'
    | 'applicationId'
    | 'participationMode'
    | 'isTeamLead'
  >,
): Promise<Participation[]> {
  const pid = projectId.trim();
  if (!looksLikeParticipationProjectUuid(pid)) {
    return [viewer as Participation];
  }

  const merged = new Map<string, Participation>();
  merged.set(rosterKey(viewer), viewer as Participation);

  const teamId = (viewer.teamId || '').trim();
  const applicationId = (viewer.applicationId || '').trim();

  if (teamId) {
    const byTeam = await repo.find({ where: { projectId: pid, teamId } });
    for (const row of byTeam) {
      merged.set(rosterKey(row), row);
    }
  }

  if (applicationId && enrollmentLooksLikeTeam(viewer)) {
    const byApp = await repo.find({
      where: { projectId: pid, applicationId },
    });
    for (const row of byApp) {
      merged.set(rosterKey(row), row);
    }
  }

  return [...merged.values()];
}

/** Canonical lead studentId for the viewer's team, including mismatched scope / individual-mode members. */
export async function resolveCanonicalLeadStudentIdForViewer(
  repo: Repository<Participation>,
  projectId: string,
  viewer: Participation,
): Promise<string | null> {
  const scoped = await findCanonicalTeamLeadStudentId(repo, projectId, {
    teamId: viewer.teamId,
    applicationId: viewer.applicationId,
  });
  if (scoped) return scoped;

  const roster = await loadSameTeamParticipations(repo, projectId, viewer);
  const flagged = roster.filter(
    (row) => row.isTeamLead === true && Boolean(row.studentId),
  );
  if (flagged.length) {
    return pickCanonicalTeamLeadFromMembers(flagged).studentId ?? null;
  }

  const applicationId = (viewer.applicationId || '').trim();
  if (applicationId && viewer.participationMode === 'team') {
    return findCanonicalTeamLeadStudentId(repo, projectId, {
      teamId: null,
      applicationId,
    });
  }

  return null;
}

/** In-memory roster (admin team list): earliest flagged lead, else first member. */
/**
 * Ensures at most one `isTeamLead` per team/application on a project (keeps `keepParticipationId`).
 * Returns how many rows were demoted.
 */
export async function demoteExtraTeamLeadsInScope(
  repo: Repository<Participation>,
  projectId: string,
  scope: { teamId?: string | null; applicationId?: string | null },
  keepParticipationId: string,
): Promise<number> {
  const teamId = (scope.teamId || '').trim();
  const applicationId = (scope.applicationId || '').trim();
  if (!teamId && !applicationId) {
    return 0;
  }

  const qb = repo
    .createQueryBuilder('p')
    .where('p.projectId = :projectId', { projectId })
    .andWhere('p.isTeamLead = true')
    .andWhere('p.id != :keepId', { keepId: keepParticipationId });
  if (teamId) {
    qb.andWhere('p.teamId = :teamId', { teamId });
  } else {
    qb.andWhere('p.applicationId = :applicationId', { applicationId });
  }
  const others = await qb.getMany();
  if (!others.length) {
    return 0;
  }
  for (const row of others) {
    row.isTeamLead = false;
  }
  await repo.save(others);
  return others.length;
}

export function pickCanonicalTeamLeadFromMembers(
  members: Participation[],
): Participation {
  if (!members.length) {
    throw new Error(
      'pickCanonicalTeamLeadFromMembers requires at least one member',
    );
  }
  const flagged = members.filter((m) => m.isTeamLead);
  const pool = flagged.length ? flagged : members;
  return [...pool].sort(
    (a, b) =>
      a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id),
  )[0];
}

/**
 * A student can end up with several seats on one project (an individual leftover, a re-registered
 * teammate seat, an email-only seat later linked to their account). Hours must follow the PERSON, not
 * whichever seat id a screen happened to hold, or the lead sees an entry the member never does.
 *
 * Seats are grouped per account (`studentId`, or email for seats not linked yet) and then per TEAM:
 * seats sharing a `teamId` / `applicationId` form one group; loose seats (no team / application link)
 * join the person's preferred group. One person on two different teams keeps two separate groups, so
 * hours never cross a team boundary. Each seat maps to its group's canonical seat (what the member's own
 * dashboard resolves via `pickPreferredProjectEnrollment`) plus every sibling seat in the group.
 */
export function groupSiblingSeats(
  rows: Participation[],
): Map<string, { canonical: Participation; siblings: Participation[] }> {
  rows = Array.isArray(rows) ? rows : [];
  const norm = (v?: string | null) => (v || '').trim().toLowerCase();
  const studentByEmail = new Map<string, string>();
  for (const r of rows) {
    if (r.studentId && norm(r.email))
      studentByEmail.set(norm(r.email), r.studentId);
  }
  const byPerson = new Map<string, Participation[]>();
  for (const r of rows) {
    const key =
      r.studentId ||
      (norm(r.email) ? studentByEmail.get(norm(r.email)) : undefined) ||
      (norm(r.email) ? `email:${norm(r.email)}` : `seat:${r.id}`);
    byPerson.set(key, [...(byPerson.get(key) ?? []), r]);
  }

  const out = new Map<
    string,
    { canonical: Participation; siblings: Participation[] }
  >();
  for (const seats of byPerson.values()) {
    // union-find over team / application links
    const parent = new Map<string, string>();
    const find = (id: string): string => {
      const p = parent.get(id) ?? id;
      if (p === id) return id;
      const root = find(p);
      parent.set(id, root);
      return root;
    };
    const union = (a: string, b: string) => parent.set(find(a), find(b));
    const byTeam = new Map<string, string>();
    const byApp = new Map<string, string>();
    const loose: Participation[] = [];
    for (const r of seats) {
      const t = (r.teamId || '').trim();
      const ap = (r.applicationId || '').trim();
      if (!t && !ap) {
        loose.push(r);
        continue;
      }
      if (t) {
        if (byTeam.has(t)) union(r.id, byTeam.get(t)!);
        else byTeam.set(t, r.id);
      }
      if (ap) {
        if (byApp.has(ap)) union(r.id, byApp.get(ap)!);
        else byApp.set(ap, r.id);
      }
    }
    const clusters = new Map<string, Participation[]>();
    for (const r of seats) {
      if (!(r.teamId || '').trim() && !(r.applicationId || '').trim()) continue;
      const root = find(r.id);
      clusters.set(root, [...(clusters.get(root) ?? []), r]);
    }
    if (clusters.size === 0) {
      clusters.set('loose', loose);
    } else if (loose.length) {
      // loose leftovers follow the person's preferred seat
      const preferred = pickPreferredProjectEnrollment(seats) ?? seats[0];
      const target =
        [...clusters.entries()].find(([, list]) =>
          list.some((x) => x.id === preferred.id),
        )?.[0] ?? [...clusters.keys()][0];
      clusters.set(target, [...clusters.get(target)!, ...loose]);
    }
    for (const list of clusters.values()) {
      const canonical = pickPreferredProjectEnrollment(list) ?? list[0];
      for (const r of list) out.set(r.id, { canonical, siblings: list });
    }
  }
  return out;
}
