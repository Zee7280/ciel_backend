import { resolveTeamSeatCap, teamCapacityError } from './team-capacity.util';

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
