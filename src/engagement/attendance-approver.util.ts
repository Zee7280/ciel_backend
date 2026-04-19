import { Opportunity } from '../opportunities/entities/opportunity.entity';
import { User } from '../users/entities/user.entity';
import { Organization } from '../organizations/entities/organization.entity';
import { UserRole } from '../users/enums/user-role.enum';

export type AssignedApproverType = 'partner' | 'admin';

export type AttendanceApprovalStatus = 'pending' | 'approved' | 'rejected' | 'flagged';

/** Audit: who created the hosting opportunity (NGO vs corporate vs faculty/student/admin). */
export type OpportunityCreatorKind =
    | 'ngo'
    | 'corporate'
    | 'faculty'
    | 'student'
    | 'university'
    | 'admin'
    | 'organization_admin'
    | 'unknown';

export interface AttendanceApproverRouting {
    approvalStatus: AttendanceApprovalStatus;
    assignedApproverType: AssignedApproverType;
    assignedApproverUserId: string | null;
    opportunityCreatorKind: OpportunityCreatorKind;
}

function orgTypeLabel(org: Organization | null | undefined): string {
    return (org?.orgType || '').trim().toUpperCase();
}

function resolveCreatorKind(
    creator: User | null | undefined,
    organization: Organization | null | undefined,
): OpportunityCreatorKind {
    if (!creator?.role) return 'unknown';
    const role = creator.role as UserRole;
    const ot = orgTypeLabel(organization);

    if (role === UserRole.FACULTY) return 'faculty';
    if (role === UserRole.STUDENT) return 'student';
    if (role === UserRole.UNIVERSITY) return 'university';
    if (role === UserRole.SUPER_ADMIN) return 'admin';
    if (role === UserRole.CORPORATE || ot === 'CORPORATE') return 'corporate';
    if (role === UserRole.NGO || ot === 'NGO') return 'ngo';
    if (role === UserRole.ORGANIZATION_ADMIN) {
        if (ot === 'CORPORATE') return 'corporate';
        if (ot === 'NGO') return 'ngo';
        return 'organization_admin';
    }
    return 'unknown';
}

/**
 * Canonical rule (server-side):
 * — Opportunity created by NGO / corporate / org-admin poster → partner queue (creator user).
 * — Faculty, student, university, CIEL admin, or unknown → CIEL admin queue.
 */
export function resolveAttendanceApproverRouting(
    opportunity: Opportunity,
    creator: User | null | undefined,
    organization: Organization | null | undefined,
): AttendanceApproverRouting {
    const role = creator?.role as UserRole | undefined;
    const orgPartnerRoles = new Set<UserRole>([
        UserRole.NGO,
        UserRole.PARTNER,
        UserRole.CORPORATE,
        UserRole.ORGANIZATION_ADMIN,
    ]);
    const isOrgSideCreator = !!creator && role != null && orgPartnerRoles.has(role);
    const creatorKind = resolveCreatorKind(creator, organization);

    if (isOrgSideCreator && opportunity.creatorId) {
        const hostKind: OpportunityCreatorKind =
            creatorKind === 'corporate' ? 'corporate' : creatorKind === 'ngo' ? 'ngo' : 'ngo';
        return {
            approvalStatus: 'pending',
            assignedApproverType: 'partner',
            assignedApproverUserId: opportunity.creatorId,
            opportunityCreatorKind: hostKind,
        };
    }

    return {
        approvalStatus: 'pending',
        assignedApproverType: 'admin',
        assignedApproverUserId: null,
        opportunityCreatorKind: creatorKind,
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
    log: {
        assignedApproverType: string | null | undefined;
        assignedApproverUserId: string | null | undefined;
        approvalStatus: string | null | undefined;
    },
    opportunityCreatorId: string | null | undefined,
): boolean {
    if (log.approvalStatus && log.approvalStatus !== 'pending') {
        return false;
    }
    if (log.assignedApproverType === 'partner') {
        const target = log.assignedApproverUserId || opportunityCreatorId;
        return !!target && target === userId;
    }
    if (log.assignedApproverType === 'admin') {
        return userRole === UserRole.SUPER_ADMIN;
    }
    return false;
}
