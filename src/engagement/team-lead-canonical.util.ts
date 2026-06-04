import { FindOptionsWhere, Repository } from 'typeorm';
import { Participation } from './entities/participant.entity';

export type TeamLeadScope = {
    teamId?: string | null;
    applicationId?: string | null;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function looksLikeParticipationProjectUuid(value?: string | null): boolean {
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

export function pickCanonicalTeamLeadFromMembers(members: Participation[]): Participation {
    if (!members.length) {
        throw new Error('pickCanonicalTeamLeadFromMembers requires at least one member');
    }
    const flagged = members.filter((m) => m.isTeamLead);
    const pool = flagged.length ? flagged : members;
    return [...pool].sort(
        (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id),
    )[0];
}
