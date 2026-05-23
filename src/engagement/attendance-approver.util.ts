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

/** Opportunity JSON fields used to decide partner vs faculty attendance routing. */
export type OpportunityPartnerRoutingSource = {
    requiresPartnerApproval?: boolean;
    isStudentCreated?: boolean;
    organization?: { contactEmail?: string | null } | null;
    partner_organization?: unknown;
    external_partner_collaboration?: unknown;
    executing_context?: unknown;
    supervision?: unknown;
};

function normalizeEmailList(values: Array<string | null | undefined>): string[] {
    return Array.from(
        new Set(
            values
                .map((v) => (v || '').trim().toLowerCase())
                .filter((v) => v.length > 0 && v.includes('@')),
        ),
    );
}

/**
 * Partner contact emails that mean attendance should go to the partner queue.
 * Aligns with admin project tracker "Partner contact email" — not host `organizationId`
 * or university `organization.contactEmail` alone.
 */
export function extractPartnerContactEmailsForAttendance(
    opportunity: OpportunityPartnerRoutingSource | null | undefined,
): string[] {
    if (!opportunity) return [];

    const partnerOrg =
        opportunity.partner_organization && typeof opportunity.partner_organization === 'object'
            ? (opportunity.partner_organization as Record<string, unknown>)
            : {};
    const externalCollab =
        opportunity.external_partner_collaboration &&
        typeof opportunity.external_partner_collaboration === 'object'
            ? (opportunity.external_partner_collaboration as Record<string, unknown>)
            : {};
    const executingContext =
        opportunity.executing_context && typeof opportunity.executing_context === 'object'
            ? (opportunity.executing_context as Record<string, unknown>)
            : {};
    const contextPartner =
        executingContext.partner && typeof executingContext.partner === 'object'
            ? (executingContext.partner as Record<string, unknown>)
            : {};
    const supervision =
        opportunity.supervision && typeof opportunity.supervision === 'object'
            ? (opportunity.supervision as Record<string, unknown>)
            : {};

    return normalizeEmailList([
        typeof partnerOrg.official_email === 'string' ? partnerOrg.official_email : null,
        typeof partnerOrg.officialEmail === 'string' ? partnerOrg.officialEmail : null,
        typeof partnerOrg.email === 'string' ? partnerOrg.email : null,
        typeof partnerOrg.contact_email === 'string' ? partnerOrg.contact_email : null,
        typeof partnerOrg.contactEmail === 'string' ? partnerOrg.contactEmail : null,
        typeof supervision.partner_email === 'string' ? supervision.partner_email : null,
        typeof supervision.external_partner_email === 'string' ? supervision.external_partner_email : null,
        typeof externalCollab.official_email === 'string' ? externalCollab.official_email : null,
        typeof externalCollab.officialEmail === 'string' ? externalCollab.officialEmail : null,
        typeof contextPartner.official_email === 'string' ? contextPartner.official_email : null,
        typeof contextPartner.officialEmail === 'string' ? contextPartner.officialEmail : null,
    ]);
}

export function opportunityHasActionablePartnerForAttendance(
    opportunity: OpportunityPartnerRoutingSource | null | undefined,
): boolean {
    return extractPartnerContactEmailsForAttendance(opportunity).length > 0;
}

/** Stored participation type corrected when the project has no partner contact to review. */
export function resolveEffectiveAttendanceApproverType(
    stored: string | null | undefined,
    opportunity: OpportunityPartnerRoutingSource | null | undefined,
): AssignedApproverType {
    if (opportunityHasActionablePartnerForAttendance(opportunity)) {
        return 'partner';
    }
    if (opportunity?.isStudentCreated) {
        return 'faculty';
    }
    return stored === 'partner' ? 'partner' : 'faculty';
}

export function effectiveAssignedApproverTypeForLog(
    logAssignedType: string | null | undefined,
    opportunity: OpportunityPartnerRoutingSource | null | undefined,
): AssignedApproverType {
    const normalized = logAssignedType === 'partner' ? 'partner' : 'faculty';
    if (normalized === 'partner' && !opportunityHasActionablePartnerForAttendance(opportunity)) {
        return 'faculty';
    }
    return normalized;
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
