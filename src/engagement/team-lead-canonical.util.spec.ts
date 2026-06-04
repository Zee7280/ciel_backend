import {
    demoteExtraTeamLeadsInScope,
    pickCanonicalTeamLeadFromMembers,
} from './team-lead-canonical.util';
import { Repository } from 'typeorm';
import { Participation } from './entities/participant.entity';
import { Participation } from './entities/participant.entity';

function member(partial: Partial<Participation> & { id: string; createdAt: Date }): Participation {
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
        const moeez = { id: 'moeez', isTeamLead: true, teamId: 'team-1' } as Participation;
        const hamza = { id: 'hamza', isTeamLead: true, teamId: 'team-1' } as Participation;
        const qb = {
            where: jest.fn().mockReturnThis(),
            andWhere: jest.fn().mockReturnThis(),
            getMany: jest.fn().mockResolvedValue([moeez]),
        };
        const repo = {
            createQueryBuilder: jest.fn().mockReturnValue(qb),
            save: jest.fn().mockResolvedValue(undefined),
        } as unknown as Repository<Participation>;

        const n = await demoteExtraTeamLeadsInScope(repo, 'proj-1', { teamId: 'team-1' }, 'hamza');

        expect(n).toBe(1);
        expect(moeez.isTeamLead).toBe(false);
        expect(repo.save).toHaveBeenCalledWith([moeez]);
    });
});
