import {
  isPrivateTeamOpportunity,
  isTeamMode,
  PRIVATE_TEAM_MAX_SEATS,
  privateTeamSeatsError,
  teamModeError,
} from './team-mode.util';

describe('team mode util', () => {
  it('accepts the two modes and empty values, rejects anything else', () => {
    expect(isTeamMode('private_team')).toBe(true);
    expect(isTeamMode('open')).toBe(true);
    expect(isTeamMode('private')).toBe(false);
    expect(teamModeError(undefined)).toBeNull();
    expect(teamModeError(null)).toBeNull();
    expect(teamModeError('')).toBeNull();
    expect(teamModeError('open')).toBeNull();
    expect(teamModeError('private')).toMatch(/private_team, open/);
    expect(teamModeError(5)).toMatch(/team_mode must be one of/);
  });

  it('treats only private_team as private (legacy null and open are not)', () => {
    expect(isPrivateTeamOpportunity({ team_mode: 'private_team' })).toBe(true);
    expect(isPrivateTeamOpportunity({ team_mode: 'open' })).toBe(false);
    expect(isPrivateTeamOpportunity({ team_mode: null })).toBe(false);
    expect(isPrivateTeamOpportunity({})).toBe(false);
    expect(isPrivateTeamOpportunity(null)).toBe(false);
  });

  it('requires 1–20 whole seats for a private team', () => {
    expect(PRIVATE_TEAM_MAX_SEATS).toBe(20);
    expect(privateTeamSeatsError({ volunteers_required: 1 })).toBeNull();
    expect(privateTeamSeatsError({ volunteers_required: 20 })).toBeNull();
    expect(privateTeamSeatsError({ volunteers_required: '10' })).toBeNull();
    expect(privateTeamSeatsError({ volunteers_required: 21 })).toMatch(
      /1–20 seats/,
    );
    expect(privateTeamSeatsError({ volunteers_required: 0 })).not.toBeNull();
    expect(privateTeamSeatsError({ volunteers_required: 2.5 })).not.toBeNull();
    expect(privateTeamSeatsError({})).not.toBeNull();
    expect(privateTeamSeatsError(null)).not.toBeNull();
  });
});
