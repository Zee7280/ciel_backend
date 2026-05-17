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
});
