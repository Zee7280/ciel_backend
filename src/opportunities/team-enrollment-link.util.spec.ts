import {
  participationStudentIdMislinked,
  pickSeatToKeepWhenRelinking,
} from './team-enrollment-link.util';

describe('participationStudentIdMislinked', () => {
  it('is false when the seat already points at the login account for that email', () => {
    expect(
      participationStudentIdMislinked({
        emailOwnerId: 'alina',
        studentId: 'alina',
      }),
    ).toBe(false);
  });

  it('is true when the seat is attached to a different user id than the email owner', () => {
    expect(
      participationStudentIdMislinked({
        emailOwnerId: 'alina-login',
        studentId: 'spaher-or-ghost',
      }),
    ).toBe(true);
  });

  it('is false when student_id is missing (orphan row, not a wrong link)', () => {
    expect(
      participationStudentIdMislinked({
        emailOwnerId: 'alina-login',
        studentId: null,
      }),
    ).toBe(false);
  });
});

describe('pickSeatToKeepWhenRelinking', () => {
  it('keeps the team member seat instead of collapsing onto an individual leftover', () => {
    const ownerIndividual = { id: 'individual', teamId: null, isTeamLead: false };
    const teamMember = {
      id: 'team-row',
      teamId: 'cf890ae9-46a6-4de0-9f18-dabad608c19a',
      isTeamLead: false,
    };
    expect(pickSeatToKeepWhenRelinking(ownerIndividual, teamMember).id).toBe(
      'team-row',
    );
  });

  it('keeps the already-correct team lead when the mislinked row is not on a team', () => {
    const ownerLead = { id: 'lead', teamId: 'team-1', isTeamLead: true };
    const stray = { id: 'stray', teamId: null, isTeamLead: false };
    expect(pickSeatToKeepWhenRelinking(ownerLead, stray).id).toBe('lead');
  });
});
