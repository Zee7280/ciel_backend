import { NotFoundException } from '@nestjs/common';
import type { Repository } from 'typeorm';
import type { FacultyUniversityScopeService } from '../faculty-university-scope/faculty-university-scope.service';
import type { Opportunity } from '../opportunities/entities/opportunity.entity';
import type { OpportunityApplication } from '../opportunities/entities/opportunity-application.entity';
import type { OpportunitiesService } from '../opportunities/opportunities.service';
import type { StudentReport } from '../reports/entities/student-report.entity';
import type { Participation } from '../engagement/entities/participant.entity';
import type { Timesheet } from '../timesheets/entities/timesheet.entity';
import type { User } from '../users/entities/user.entity';
import { FacultyService } from './faculty.service';

/** Private surface of FacultyService exercised by these tests. */
type ServicePrivate = {
  resolveFacultyScopedOpportunityIds: (
    facultyId: string,
    facultyEmail: string,
  ) => Promise<string[]>;
  approvalActionForRow: (
    opp: Opportunity,
    facultyId: string,
    fe: string,
    delegatedIds: Set<string>,
    reportAwaitingFacultyGate: boolean,
  ) => 'faculty_review' | 'partner_ack';
};

function makeFacultyService(
  opp: Record<string, unknown> | null,
  scopedIds: string[] = [],
) {
  const service = new FacultyService(
    {
      findOne: jest.fn().mockResolvedValue(opp),
    } as unknown as Repository<Opportunity>, // opportunitiesRepository
    {
      findOne: jest.fn().mockResolvedValue(null),
    } as unknown as Repository<User>, // usersRepository
    {
      find: jest.fn().mockResolvedValue([]),
    } as unknown as Repository<StudentReport>, // studentReportsRepository
    {} as unknown as Repository<Participation>, // participationRepository
    {} as unknown as Repository<Timesheet>, // timesheetsRepository
    {} as unknown as Repository<OpportunityApplication>, // opportunityApplicationsRepository
    {} as unknown as FacultyUniversityScopeService, // facultyUniversityScopeService
    {
      isAwaitingPartnerDashboardReview: () => true,
    } as unknown as OpportunitiesService, // opportunitiesService
  );
  (service as unknown as ServicePrivate).resolveFacultyScopedOpportunityIds =
    jest.fn().mockResolvedValue(scopedIds);
  return service;
}

describe('FacultyService — a row on the approvals list is always openable / routed correctly', () => {
  const firOpp = {
    id: 'opp-1',
    creatorId: 'c1',
    facultyId: null,
    supervision: {},
    visibility_and_academic_linkage: {
      faculty_institutional_representative: { official_email: 'fir@uni.edu' },
    },
  };

  it('GET /faculty/approvals/:id opens a row listed only via the NGO faculty-link email', async () => {
    const service = makeFacultyService(firOpp, []); // not in the dashboard scope
    const res = await service.getProjectDetail('fac-1', 'FIR@uni.edu', 'opp-1');
    expect(res.data.opportunity.id).toBe('opp-1');
  });

  it('still 404s for a faculty that is neither scoped nor named on the record', async () => {
    const service = makeFacultyService(firOpp, []);
    await expect(
      service.getProjectDetail('fac-2', 'other@uni.edu', 'opp-1'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('partner_ack routing recognises every partner contact email, not just the first source', () => {
    const service = makeFacultyService(null);
    const opp = {
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
    } as unknown as Opportunity;
    const action = (fe: string) =>
      (service as unknown as ServicePrivate).approvalActionForRow(
        opp,
        'fac-9',
        fe,
        new Set(),
        false,
      );
    expect(action('second@ngo.org')).toBe('partner_ack');
    expect(action('first@ngo.org')).toBe('partner_ack');
    expect(action('nobody@x.org')).toBe('faculty_review');
  });
});
