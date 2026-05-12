/**
 * Single source of truth: when a browse/join application counts as "team apply".
 * Keep `StudentsService` apply path and `OpportunityApplicationsService` listings aligned.
 */
export function applyPayloadHasTeamMemberEmails(teamMembers: unknown): boolean {
    return (
        Array.isArray(teamMembers) &&
        teamMembers.some(
            (m) =>
                typeof (m as { email?: unknown })?.email === 'string' &&
                (m as { email: string }).email.trim() !== '',
        )
    );
}

function normalizeParticipationTypeInput(participationType: unknown): string {
    if (typeof participationType !== 'string') {
        return '';
    }
    return participationType.trim().toLowerCase();
}

/** Mirrors `StudentsService` apply: `normalize(participation_type) === 'team'` OR non-empty teammate emails. */
export function isTeamApplyFromParticipationAndMembers(
    participationType: unknown,
    teamMembers: unknown,
): boolean {
    return (
        normalizeParticipationTypeInput(participationType) === 'team' ||
        applyPayloadHasTeamMemberEmails(teamMembers)
    );
}
