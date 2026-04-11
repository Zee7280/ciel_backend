import { Injectable, NotFoundException } from '@nestjs/common';
import { Opportunity } from './entities/opportunity.entity';

/** Canonical stages aligned with CIEL frontend (`opportunityWorkflow.ts`). */
export const WORKFLOW_STAGE = {
    PENDING_FACULTY: 'pending_faculty',
    PENDING_PARTNER: 'pending_partner',
    PENDING_ADMIN: 'pending_admin',
    LIVE: 'live',
    REJECTED: 'rejected',
    REVISION: 'revision',
} as const;

export const LINE_STATUS = {
    PENDING: 'pending',
    APPROVED: 'approved',
    REJECTED: 'rejected',
    SKIPPED: 'skipped',
    NOT_APPLICABLE: 'not_applicable',
    NOT_REQUIRED: 'not_required',
} as const;

/**
 * Centralizes student-created opportunity lifecycle without breaking legacy `status` consumers.
 */
@Injectable()
export class OpportunityWorkflowService {
    initStudentCreated(opp: Opportunity, requiresPartner: boolean): void {
        opp.isStudentCreated = true;
        opp.requiresPartnerApproval = requiresPartner;
        opp.workflowStage = WORKFLOW_STAGE.PENDING_FACULTY;
        opp.facultyApprovalStatus = LINE_STATUS.PENDING;
        opp.partnerApprovalStatus = requiresPartner ? LINE_STATUS.PENDING : LINE_STATUS.NOT_APPLICABLE;
        opp.adminApprovalStatus = LINE_STATUS.PENDING;
    }

    /**
     * Faculty-authored posting: no separate faculty-approval step; optional partner gate then admin.
     */
    initFacultyCreated(opp: Opportunity, requiresPartner: boolean): void {
        opp.isStudentCreated = false;
        opp.requiresPartnerApproval = requiresPartner;
        opp.facultyApprovalStatus = LINE_STATUS.APPROVED;
        opp.partnerApprovalStatus = requiresPartner ? LINE_STATUS.PENDING : LINE_STATUS.NOT_APPLICABLE;
        opp.adminApprovalStatus = LINE_STATUS.PENDING;
        if (requiresPartner) {
            opp.workflowStage = WORKFLOW_STAGE.PENDING_PARTNER;
            opp.status = 'pending_partner';
            opp.partnerVerified = false;
        } else {
            opp.workflowStage = WORKFLOW_STAGE.PENDING_ADMIN;
            opp.status = 'pending_approval';
        }
    }

    /**
     * After faculty verifies via token link.
     */
    afterFacultyVerified(opp: Opportunity): void {
        if (!opp.isStudentCreated) {
            // Legacy: liaison / older student path used pending_verification
            opp.faculty_verified = true;
            opp.faculty_verification_status = 'faculty_verified';
            if (opp.status === 'pending_faculty' || opp.status === 'pending_verification') {
                opp.status = 'pending_approval';
            }
            return;
        }

        opp.faculty_verified = true;
        opp.faculty_verification_status = 'faculty_verified';
        opp.facultyApprovalStatus = LINE_STATUS.APPROVED;

        if (opp.requiresPartnerApproval) {
            opp.workflowStage = WORKFLOW_STAGE.PENDING_PARTNER;
            opp.status = 'pending_partner';
            if (!opp.partnerApprovalStatus || opp.partnerApprovalStatus === LINE_STATUS.NOT_APPLICABLE) {
                opp.partnerApprovalStatus = LINE_STATUS.PENDING;
            }
        } else {
            opp.workflowStage = WORKFLOW_STAGE.PENDING_ADMIN;
            opp.status = 'pending_approval';
        }
    }

    /**
     * Partner clicked verify link (student-created flow, `partnerToken`).
     */
    afterPartnerVerified(opp: Opportunity): void {
        if (!opp.isStudentCreated) return;

        opp.partnerVerified = true;
        opp.partnerApprovalStatus = LINE_STATUS.APPROVED;
        opp.workflowStage = WORKFLOW_STAGE.PENDING_ADMIN;
        opp.status = 'pending_approval';
    }

    /** Faculty-authored opportunity: partner used magic link → CIEL admin queue. */
    afterFacultyCreatedPartnerVerified(opp: Opportunity): void {
        if (opp.isStudentCreated) return;
        opp.partnerVerified = true;
        opp.partnerApprovalStatus = LINE_STATUS.APPROVED;
        opp.workflowStage = WORKFLOW_STAGE.PENDING_ADMIN;
        opp.status = 'pending_approval';
    }

    /** Faculty rejects a student-created proposal (dashboard or future API). */
    afterFacultyRejected(opp: Opportunity, reason?: string | null): void {
        if (opp.isStudentCreated) {
            opp.faculty_verified = false;
            opp.faculty_verification_status = 'rejected';
            opp.facultyApprovalStatus = LINE_STATUS.REJECTED;
            opp.workflowStage = WORKFLOW_STAGE.REJECTED;
            opp.status = 'rejected';
            if (reason) {
                opp.rejectionReason = reason;
            }
            return;
        }
        opp.faculty_verification_status = 'rejected';
        opp.status = 'rejected';
        opp.workflowStage = WORKFLOW_STAGE.REJECTED;
        opp.facultyApprovalStatus = LINE_STATUS.REJECTED;
        if (reason) {
            opp.rejectionReason = reason;
        }
    }

    afterAdminApproved(opp: Opportunity): void {
        opp.admin_approved = true;
        opp.adminApprovalStatus = LINE_STATUS.APPROVED;
        opp.workflowStage = WORKFLOW_STAGE.LIVE;

        if (opp.isStudentCreated) {
            opp.status = 'active';
            return;
        }

        // Legacy org / faculty flows
        opp.partnerVerified = true;
        opp.status = opp.execution_verified ? 'active' : 'pending_execution';
    }

    afterAdminRejected(opp: Opportunity): void {
        opp.adminApprovalStatus = LINE_STATUS.REJECTED;
        opp.workflowStage = WORKFLOW_STAGE.REJECTED;
        opp.status = 'rejected';
    }

    /**
     * API card for "My Projects" / student lists (snake_case for frontend).
     */
    toStudentProjectCard(opp: Opportunity, extra?: { teamMembers?: unknown[] }): Record<string, unknown> {
        const org = (opp as any).organization;
        return {
            id: opp.id,
            title: opp.title,
            organization: org?.name || 'Unknown',
            category: opp.sdg_info?.sdg_id || opp.sdg || 'General',
            status: opp.status,
            submitted_at: opp.createdAt?.toISOString?.() ?? opp.createdAt,
            description: opp.objectives?.description || '',
            teamMembers: extra?.teamMembers ?? [],
            workflow_stage: opp.workflowStage,
            faculty_approval_status: opp.facultyApprovalStatus,
            partner_approval_status: opp.partnerApprovalStatus,
            admin_approval_status: opp.adminApprovalStatus,
            is_student_created: opp.isStudentCreated,
            source: opp.isStudentCreated ? 'student_created' : 'participant',
            faculty_verified: opp.faculty_verified,
            faculty_verification_status: opp.faculty_verification_status,
            requires_partner_approval: opp.requiresPartnerApproval,
            liaison_verified: opp.liaisonVerified,
        };
    }

    assertThrowsIfNotFound<T>(opp: T | null): asserts opp is T {
        if (!opp) throw new NotFoundException('Opportunity not found');
    }
}
