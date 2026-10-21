import {
  MAX_TEAM_SIZE,
  resolveTeamSeatCap,
  resolveTeamSizeCap,
  teamCapacityError,
  teamSizeCapError,
} from './team-capacity.util';

describe('team size cap (builder team_mode)', () => {
  const big = { volunteers_required: 100 };

  it('leaves legacy listings (no team_mode) on the seats-only rule', () => {
    expect(resolveTeamSizeCap({ timeline: big })).toBe(100);
    expect(resolveTeamSizeCap({ timeline: {} })).toBe(0);
    expect(teamSizeCapError(30, { timeline: big })).toBeNull();
  });

  it('caps every report team at 20 on builder listings', () => {
    expect(MAX_TEAM_SIZE).toBe(20);
    expect(resolveTeamSizeCap({ timeline: big, team_mode: 'open' })).toBe(20);
    expect(resolveTeamSizeCap({ timeline: {}, team_mode: 'open' })).toBe(20);
    expect(
      resolveTeamSizeCap({
        timeline: { volunteers_required: 8 },
        team_mode: 'private_team',
      }),
    ).toBe(8);
  });

  it('words the error after the limit that was hit', () => {
    expect(
      teamSizeCapError(19, { timeline: big, team_mode: 'open' }),
    ).toBeNull();
    expect(teamSizeCapError(20, { timeline: big, team_mode: 'open' })).toMatch(
      /at most 20 members including the team lead/,
    );
    expect(
      teamSizeCapError(8, {
        timeline: { volunteers_required: 8 },
        team_mode: 'private_team',
      }),
    ).toMatch(/has 8 seats/);
  });
});

describe('team capacity', () => {
  it('treats unset / invalid volunteers_required as no cap', () => {
    expect(resolveTeamSeatCap(undefined)).toBe(0);
    expect(resolveTeamSeatCap(null)).toBe(0);
    expect(resolveTeamSeatCap('0')).toBe(0);
    expect(resolveTeamSeatCap('abc')).toBe(0);
    expect(resolveTeamSeatCap('5')).toBe(5);
  });
  it('allows up to the cap and rejects beyond it', () => {
    expect(teamCapacityError(9, 10)).toBeNull();
    expect(teamCapacityError(10, 10)).toContain('10 seats');
    expect(teamCapacityError(50, 0)).toBeNull();
  });
});
