import {
  demoteExtraTeamLeadsInScope,
  enrollmentLooksLikeTeam,
  loadSameTeamParticipations,
  pickCanonicalTeamLeadFromMembers,
  resolveCanonicalLeadStudentIdForViewer,
} from './team-lead-canonical.util';
import { Repository } from 'typeorm';
import { Participation } from './entities/participant.entity';

function member(
  partial: Partial<Participation> & { id: string; createdAt: Date },
): Participation {
  return {
    participationMode: 'team',
    isTeamLead: false,
    studentId: partial.id,
    projectId: 'proj-1',
    ...partial,
  } as Participation;
}

describe('pickCanonicalTeamLeadFromMembers', () => {
  it('picks earliest flagged lead when multiple isTeamLead rows exist', () => {
    const hamza = member({
      id: 'hamza',
      fullName: 'Hamza',
      isTeamLead: true,
      createdAt: new Date('2019-01-01'),
    });
    const moeez = member({
      id: 'moeez',
      fullName: 'moeez',
      isTeamLead: true,
      createdAt: new Date('2020-01-01'),
    });
    const amna = member({
      id: 'amna',
      fullName: 'Amna',
      isTeamLead: false,
      createdAt: new Date('2021-01-01'),
    });

    const canonical = pickCanonicalTeamLeadFromMembers([moeez, amna, hamza]);
    expect(canonical.id).toBe('hamza');
  });
});

describe('demoteExtraTeamLeadsInScope', () => {
  it('clears isTeamLead on other rows in the same team', async () => {
    const moeez = {
      id: 'moeez',
      isTeamLead: true,
      teamId: 'team-1',
    } as Participation;
    const hamza = {
      id: 'hamza',
      isTeamLead: true,
      teamId: 'team-1',
    } as Participation;
    const qb = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([moeez]),
    };
    const repo = {
      createQueryBuilder: jest.fn().mockReturnValue(qb),
      save: jest.fn().mockResolvedValue(undefined),
    } as unknown as Repository<Participation>;

    const n = await demoteExtraTeamLeadsInScope(
      repo,
      'proj-1',
      { teamId: 'team-1' },
      'hamza',
    );

    expect(n).toBe(1);
    expect(moeez.isTeamLead).toBe(false);
    expect(repo.save).toHaveBeenCalledWith([moeez]);
  });
});

const TEAM_PROJECT = '582da802-e41e-488d-bd3d-d6dee59982b7';

describe('enrollmentLooksLikeTeam', () => {
  it('treats a shared teamId as a team seat even when mode is still individual', () => {
    expect(
      enrollmentLooksLikeTeam({
        participationMode: 'individual',
        teamId: 'team-5',
      } as Participation),
    ).toBe(true);
  });

  it('does not treat a solo individual without teamId as a team seat', () => {
    expect(
      enrollmentLooksLikeTeam({
        participationMode: 'individual',
        teamId: null,
      } as unknown as Participation),
    ).toBe(false);
  });
});

describe('loadSameTeamParticipations / resolveCanonicalLeadStudentIdForViewer', () => {
  it('returns all five teammates on the same teamId and the flagged lead', async () => {
    const lead = member({
      id: 'p-lead',
      studentId: 'lead-1',
      isTeamLead: true,
      teamId: 'team-5',
      projectId: TEAM_PROJECT,
      createdAt: new Date('2020-01-01'),
    });
    const others = [2, 3, 4, 5].map((n) =>
      member({
        id: `p-m${n}`,
        studentId: `member-${n}`,
        isTeamLead: false,
        teamId: 'team-5',
        projectId: TEAM_PROJECT,
        createdAt: new Date(`2020-01-0${n}`),
      }),
    );
    const roster = [lead, ...others];
    const repo = {
      find: jest.fn().mockResolvedValue(roster),
    } as unknown as Repository<Participation>;

    const loaded = await loadSameTeamParticipations(
      repo,
      TEAM_PROJECT,
      others[2],
    );
    expect(loaded).toHaveLength(5);

    const leadId = await resolveCanonicalLeadStudentIdForViewer(
      repo,
      TEAM_PROJECT,
      others[2],
    );
    expect(leadId).toBe('lead-1');
  });
});
