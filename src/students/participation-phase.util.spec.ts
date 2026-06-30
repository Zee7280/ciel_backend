import {
  participationPhaseLabel,
  resolveParticipationPhase,
} from './participation-phase.util';

describe('resolveParticipationPhase', () => {
  it('returns not_applied for guide role none', () => {
    expect(resolveParticipationPhase({ guideRole: 'none' })).toBe(
      'not_applied',
    );
  });

  it('returns team_member_pending_verification when email not verified', () => {
    expect(
      resolveParticipationPhase({
        guideRole: 'team_member',
        emailVerified: false,
      }),
    ).toBe('team_member_pending_verification');
  });

  it('returns attendance_pending_partner when verification requested on partner project', () => {
    expect(
      resolveParticipationPhase({
        guideRole: 'individual_owner',
        attendanceVerificationPending: true,
        approverType: 'partner',
      }),
    ).toBe('attendance_pending_partner');
  });

  it('returns team_formed_lead for team lead in team mode', () => {
    expect(
      resolveParticipationPhase({
        guideRole: 'team_lead',
        participationMode: 'team',
        isTeamLead: true,
        reportStatus: 'draft',
      }),
    ).toBe('team_formed_lead');
  });

  it('returns verified for paid report status', () => {
    expect(
      resolveParticipationPhase({
        guideRole: 'team_lead',
        reportStatus: 'paid',
      }),
    ).toBe('verified');
  });

  it('provides human labels', () => {
    expect(participationPhaseLabel('team_member_active')).toContain(
      'attendance',
    );
  });
});
