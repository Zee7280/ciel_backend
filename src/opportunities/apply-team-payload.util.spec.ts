import {
    applyPayloadHasTeamMemberEmails,
    isTeamApplyFromParticipationAndMembers,
} from './apply-team-payload.util';

describe('apply-team-payload.util (sync with StudentsService apply)', () => {
    it('isTeamApply when participation_type normalizes to team', () => {
        expect(isTeamApplyFromParticipationAndMembers('Team', [])).toBe(true);
        expect(isTeamApplyFromParticipationAndMembers('  TEAM  ', [])).toBe(true);
    });

    it('isTeamApply when team_members has a non-empty email (even if participation_type omitted)', () => {
        expect(isTeamApplyFromParticipationAndMembers(undefined, [{ email: 'a@x.com' }])).toBe(true);
        expect(isTeamApplyFromParticipationAndMembers('', [{ email: '  a@x.com  ' }])).toBe(true);
    });

    it('not team when no members with email and type is not team', () => {
        expect(isTeamApplyFromParticipationAndMembers('individual', [])).toBe(false);
        expect(isTeamApplyFromParticipationAndMembers('individual', [{ name: 'x' }])).toBe(false);
        expect(isTeamApplyFromParticipationAndMembers(undefined, [{ email: '   ' }])).toBe(false);
    });

    it('applyPayloadHasTeamMemberEmails matches member-email rule only', () => {
        expect(applyPayloadHasTeamMemberEmails([{ email: 'a@b.co' }])).toBe(true);
        expect(applyPayloadHasTeamMemberEmails([])).toBe(false);
        expect(applyPayloadHasTeamMemberEmails([{}])).toBe(false);
    });
});
