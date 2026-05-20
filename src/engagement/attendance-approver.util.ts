import { UserRole } from '../users/enums/user-role.enum';

export type AssignedApproverType = 'faculty' | 'partner';

export type AttendanceApprovalStatus = 'pending' | 'approved' | 'rejected' | 'flagged';

/** Audit marker for the selected attendance approval queue. */
export type OpportunityCreatorKind = AssignedApproverType;

export interface AttendanceApproverRouting {
    approvalStatus: AttendanceApprovalStatus;
    assignedApproverType: AssignedApproverType;
    assignedApproverUserId: string | null;
    opportunityCreatorKind: OpportunityCreatorKind;
}

export function resolveAttendanceApproverRouting(
    assignedFacultyUserId: string | null,
    assignedApproverType: AssignedApproverType = 'faculty',
    assignedPartnerUserId: string | null = null,
): AttendanceApproverRouting {
    if (assignedApproverType === 'partner') {
        return {
            approvalStatus: 'pending',
            assignedApproverType: 'partner',
            assignedApproverUserId: assignedPartnerUserId,
            opportunityCreatorKind: 'partner',
        };
    }

    return {
        approvalStatus: 'pending',
        assignedApproverType: 'faculty',
        assignedApproverUserId: assignedFacultyUserId,
        opportunityCreatorKind: 'faculty',
    };
}

export function attendanceCountsTowardProgress(log: { approvalStatus?: string | null }): boolean {
    if (log.approvalStatus == null || log.approvalStatus === '') {
        return true;
    }
    return log.approvalStatus === 'approved';
}

export function canUserActOnAttendanceQueue(
    userId: string,
    userRole: string | undefined,
    userEmail: string | null,
    log: {
        assignedApproverType: string | null | undefined;
        assignedApproverUserId: string | null | undefined;
        approvalStatus: string | null | undefined;
    },
    participantFacultyEmails: string[],
    /** For legacy rows routed to the opportunity creator (partner queue). */
    opportunityCreatorId?: string | null,
    /** Partner org member acting on attendance logs with no `assignedApproverUserId` but same organization as the project. */
    partnerOrgHostsOpportunity?: boolean,
): boolean {
    if (log.approvalStatus && log.approvalStatus !== 'pending') {
        return false;
    }

    // Legacy rows before faculty-only routing: partner (NGO/creator) or CIEL admin queue.
    if (log.assignedApproverType === 'partner') {
        if (
            partnerOrgHostsOpportunity &&
            (userRole === UserRole.NGO ||
                userRole === UserRole.CORPORATE ||
                userRole === UserRole.ORGANIZATION_ADMIN)
        ) {
            return true;
        }
        const target = log.assignedApproverUserId || opportunityCreatorId || null;
        return !!target && target === userId;
    }
    if (log.assignedApproverType === 'admin') {
        return userRole === UserRole.SUPER_ADMIN;
    }

    if (userRole !== UserRole.FACULTY) {
        return false;
    }

    if (log.assignedApproverType !== 'faculty') {
        return false;
    }

    if (log.assignedApproverUserId) {
        return log.assignedApproverUserId === userId;
    }

    const normalizedActorEmail = (userEmail || '').trim().toLowerCase();
    if (!normalizedActorEmail) return false;
    return participantFacultyEmails.includes(normalizedActorEmail);
}

export function getParticipantFacultyEmails(participant: {
    facultySupervisorEmail?: string | null;
    primaryFacultyEmail?: string | null;
    secondaryFacultyEmail?: string | null;
}): string[] {
    const raw = [
        participant.facultySupervisorEmail,
        participant.primaryFacultyEmail,
        participant.secondaryFacultyEmail,
    ];
    return Array.from(
        new Set(
            raw
                .map((v) => (v || '').trim().toLowerCase())
                .filter(Boolean),
        ),
    );
}
