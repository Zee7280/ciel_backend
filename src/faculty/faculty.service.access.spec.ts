import { NotFoundException } from '@nestjs/common';
import { FacultyService } from './faculty.service';

function makeFacultyService(opp: Record<string, unknown> | null, scopedIds: string[] = []) {
  const service = new FacultyService(
    { findOne: jest.fn().mockResolvedValue(opp) } as any, // opportunitiesRepository
    { findOne: jest.fn().mockResolvedValue(null) } as any, // usersRepository
    { find: jest.fn().mockResolvedValue([]) } as any, // studentReportsRepository
    {} as any, // participationRepository
    {} as any, // timesheetsRepository
    {} as any, // opportunityApplicationsRepository
    {} as any, // facultyUniversityScopeService
    { isAwaitingPartnerDashboardReview: () => true } as any, // opportunitiesService
  );
  (service as any).resolveFacultyScopedOpportunityIds = jest.fn().mockResolvedValue(scopedIds);
  return service;
}

describe('FacultyService — a row on the approvals list is always openable / routed correctly', () => {
  const firOpp = {
    id: 'opp-1',
    creatorId: 'c1',
    facultyId: null,
    supervision: {},
    visibility_and_academic_linkage: { faculty_institutional_representative: { official_email: 'fir@uni.edu' } },
  };

  it('GET /faculty/approvals/:id opens a row listed only via the NGO faculty-link email', async () => {
    const service = makeFacultyService(firOpp, []); // not in the dashboard scope
    const res: any = await service.getProjectDetail('fac-1', 'FIR@uni.edu', 'opp-1');
    expect(res.data.opportunity.id).toBe('opp-1');
  });

  it('still 404s for a faculty that is neither scoped nor named on the record', async () => {
    const service = makeFacultyService(firOpp, []);
    await expect(service.getProjectDetail('fac-2', 'other@uni.edu', 'opp-1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('partner_ack routing recognises every partner contact email, not just the first source', () => {
    const service = makeFacultyService(null);
    const opp: any = {
      id: 'opp-2',
      creatorId: 'c1',
      isStudentCreated: false,
      facultyId: null,
      requiresPartnerApproval: true,
      partnerVerified: false,
      supervision: { contact: 'sup@uni.edu' },
      external_partner_collaboration: { official_email: 'first@ngo.org' },
      partner_organization: { official_email: 'second@ngo.org' },
      workflowStage: 'pending_partner',
      status: 'pending_partner',
      faculty_verified: true,
    };
    const action = (fe: string) => (service as any).approvalActionForRow(opp, 'fac-9', fe, new Set(), false);
    expect(action('second@ngo.org')).toBe('partner_ack');
    expect(action('first@ngo.org')).toBe('partner_ack');
    expect(action('nobody@x.org')).toBe('faculty_review');
  });
});
