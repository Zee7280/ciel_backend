import { Opportunity } from './entities/opportunity.entity';
import {
    LINE_STATUS,
    OpportunityWorkflowService,
    WORKFLOW_STAGE,
} from './opportunity-workflow.service';

describe('OpportunityWorkflowService', () => {
    const service = new OpportunityWorkflowService();

    it('afterAdminApproved sets status active for student-created opportunities', () => {
        const opp = { isStudentCreated: true, admin_approved: false, status: 'pending_approval' } as Opportunity;
        service.afterAdminApproved(opp);
        expect(opp.workflowStage).toBe(WORKFLOW_STAGE.LIVE);
        expect(opp.admin_approved).toBe(true);
        expect(opp.adminApprovalStatus).toBe(LINE_STATUS.APPROVED);
        expect(opp.status).toBe('active');
    });

    it('afterAdminApproved sets status active for faculty/org flow when execution is not verified', () => {
        const opp = {
            isStudentCreated: false,
            execution_verified: false,
            admin_approved: false,
            status: 'pending_execution',
        } as Opportunity;
        service.afterAdminApproved(opp);
        expect(opp.workflowStage).toBe(WORKFLOW_STAGE.LIVE);
        expect(opp.admin_approved).toBe(true);
        expect(opp.partnerVerified).toBe(true);
        expect(opp.status).toBe('active');
    });

    it('afterAdminRevision sets revision stage without terminal reject', () => {
        const opp = { isStudentCreated: true, admin_approved: false } as Opportunity;
        service.afterAdminRevision(opp, 'Add partner email');
        expect(opp.workflowStage).toBe(WORKFLOW_STAGE.REVISION);
        expect(opp.adminApprovalStatus).toBe(LINE_STATUS.REVISION_REQUESTED);
        expect(opp.rejectionReason).toBe('Add partner email');
    });

    it('afterFacultyRevision resets faculty verification for student-created rows', () => {
        const opp = {
            isStudentCreated: true,
            faculty_verified: true,
            facultyApprovalStatus: LINE_STATUS.APPROVED,
        } as Opportunity;
        service.afterFacultyRevision(opp, 'Update department');
        expect(opp.workflowStage).toBe(WORKFLOW_STAGE.REVISION);
        expect(opp.faculty_verified).toBe(false);
        expect(opp.facultyApprovalStatus).toBe(LINE_STATUS.REVISION_REQUESTED);
    });

    it('afterPartnerRevision resets partner verification for student-created rows', () => {
        const opp = {
            isStudentCreated: true,
            partnerVerified: true,
            partnerApprovalStatus: LINE_STATUS.APPROVED,
        } as Opportunity;
        service.afterPartnerRevision(opp, 'Wrong org contact');
        expect(opp.workflowStage).toBe(WORKFLOW_STAGE.REVISION);
        expect(opp.partnerVerified).toBe(false);
        expect(opp.partnerApprovalStatus).toBe(LINE_STATUS.REVISION_REQUESTED);
    });

    it('afterAdminRejected remains terminal rejected', () => {
        const opp = { isStudentCreated: true } as Opportunity;
        service.afterAdminRejected(opp, 'Not eligible');
        expect(opp.workflowStage).toBe(WORKFLOW_STAGE.REJECTED);
        expect(opp.adminApprovalStatus).toBe(LINE_STATUS.REJECTED);
    });
});
