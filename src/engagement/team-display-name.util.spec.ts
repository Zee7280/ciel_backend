import { buildTeamDisplayName } from './team-display-name.util';
import { Participation } from './entities/participant.entity';

describe('buildTeamDisplayName', () => {
  it('builds default label from project and lead', () => {
    const lead = { fullName: 'Ali Hassan' } as Participation;
    expect(buildTeamDisplayName({ title: 'Clean Water Drive' }, lead)).toBe(
      'Clean Water Drive · Ali Team',
    );
  });

  it('adds sequence suffix for multiple teams', () => {
    const lead = { fullName: 'Sara Ahmed' } as Participation;
    expect(buildTeamDisplayName({ title: 'Tree Planting' }, lead, 2)).toBe(
      'Tree Planting · Team 2 (Sara)',
    );
  });
});
