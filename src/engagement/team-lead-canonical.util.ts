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
  participation?: Pick<
    Participation,
    'participationMode' | 'teamId'
  > | null,
): boolean {
  if (!participation) return false;
  if (participation.participationMode === 'team') return true;
  return Boolean((participation.teamId || '').trim());
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
    'id' | 'studentId' | 'teamId' | 'applicationId' | 'participationMode' | 'isTeamLead'
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
