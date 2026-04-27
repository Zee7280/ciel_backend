import { UserRole } from '../users/enums/user-role.enum';

export type AssignedApproverType = 'faculty';

export type AttendanceApprovalStatus = 'pending' | 'approved' | 'rejected' | 'flagged';

/** Audit: attendance approval queue is faculty-gated. */
export type OpportunityCreatorKind = 'faculty';

export interface AttendanceApproverRouting {
    approvalStatus: AttendanceApprovalStatus;
    assignedApproverType: AssignedApproverType;
    assignedApproverUserId: string | null;
    opportunityCreatorKind: OpportunityCreatorKind;
}

export function resolveAttendanceApproverRouting(
    assignedFacultyUserId: string | null,
): AttendanceApproverRouting {
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
): boolean {
    if (log.approvalStatus && log.approvalStatus !== 'pending') {
        return false;
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
