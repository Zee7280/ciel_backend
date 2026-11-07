import { OpportunitiesService } from './opportunities.service';
import { Opportunity } from './entities/opportunity.entity';
import { OpportunityWorkflowService } from './opportunity-workflow.service';

/**
 * Pure-predicate checks: a reviewer's own line status may still read "pending" after CIEL PK (or
 * another reviewer) rejected the listing or sent it back for revision. A closed stage must win —
 * otherwise a faculty / partner dashboard click would resurrect a rejected opportunity or skip the
 * creator's required resubmit.
 */
function makeBareService() {
  const unused = {} as never;
  return new OpportunitiesService(
    unused,
    unused,
    unused,
    unused,
    unused,
    unused,
    unused,
    unused,
    unused,
    unused,
    unused,
  );
}

type Privates = {
  isAwaitingFacultyDashboardReview(opp: Opportunity): boolean;
};

const asOpp = (o: Record<string, unknown>) => o as unknown as Opportunity;

describe('closed-stage guards on faculty / partner dashboard review', () => {
  const service = makeBareService();
  const facultyOpen = (o: Record<string, unknown>) =>
    (service as unknown as Privates).isAwaitingFacultyDashboardReview(asOpp(o));

  const studentAtPartner = {
    id: 'o1',
    creatorId: 'student-1',
    isStudentCreated: true,
    requiresPartnerApproval: true,
    partnerVerified: false,
    faculty_verified: true,
    admin_approved: false,
    facultyApprovalStatus: 'approved',
    partnerApprovalStatus: 'pending',
    workflowStage: 'pending_partner',
    status: 'pending_partner',
  };

  const studentAtFaculty = {
    id: 'o2',
    creatorId: 'student-1',
    isStudentCreated: true,
    requiresPartnerApproval: false,
    partnerVerified: true,
    faculty_verified: false,
    admin_approved: false,
    facultyApprovalStatus: 'pending',
    faculty_verification_status: 'pending_faculty',
    partnerApprovalStatus: 'not_applicable',
    workflowStage: 'pending_faculty',
    status: 'pending_faculty',
  };

  it('baseline: partner / faculty can review while their line is genuinely open', () => {
    expect(
      service.isAwaitingPartnerDashboardReview(asOpp(studentAtPartner)),
    ).toBe(true);
    expect(facultyOpen(studentAtFaculty)).toBe(true);
  });

  it.each([
    ['rejected by CIEL PK', { workflowStage: 'rejected', status: 'rejected' }],
    [
      'sent back for revision',
      { workflowStage: 'revision', status: 'revision' },
    ],
    ['closed', { status: 'closed' }],
    ['cancelled', { status: 'cancelled' }],
  ])('partner cannot act once the listing is %s', (_label, patch) => {
    expect(
      service.isAwaitingPartnerDashboardReview(
        asOpp({ ...studentAtPartner, ...patch }),
      ),
    ).toBe(false);
  });

  it.each([
    ['rejected by CIEL PK', { workflowStage: 'rejected', status: 'rejected' }],
    [
      'sent back for revision',
      { workflowStage: 'revision', status: 'revision' },
    ],
    ['closed', { status: 'closed' }],
    ['cancelled', { status: 'cancelled' }],
  ])('faculty cannot act once the listing is %s', (_label, patch) => {
    expect(facultyOpen({ ...studentAtFaculty, ...patch })).toBe(false);
  });
});

describe('update(): who may edit a STUDENT-created opportunity', () => {
  /** A student-created row's organizationId is the HOST PARTNER's org — its members are reviewers,
   * not editors. Only the student creator (resubmit path) and CIEL PK may change the content. */
  function makeUpdateService(
    row: Record<string, unknown>,
    user: Record<string, unknown>,
  ) {
    const unused = {} as never;
    const save = jest.fn((r: unknown) => Promise.resolve(r));
    const service = new OpportunitiesService(
      { findOne: jest.fn().mockResolvedValue(row), save } as never,
      unused,
      { findOne: jest.fn().mockResolvedValue(user) } as never,
      unused,
      { getMyOrganization: jest.fn().mockResolvedValue(null) } as never,
      unused,
      unused,
      unused,
      new OpportunityWorkflowService(),
      unused,
      unused,
    );
    return { service, save };
  }

  const liveStudentRow = () => ({
    id: 'opp-live',
    creatorId: 'student-1',
    isStudentCreated: true,
    organizationId: 'host-org',
    admin_approved: true,
    status: 'active',
    workflowStage: 'live',
    title: 'Original title',
  });

  it('refuses a host-partner organisation member rewriting a live student listing', async () => {
    const { service, save } = makeUpdateService(liveStudentRow(), {
      id: 'ngo-1',
      role: 'ngo',
    });
    await expect(
      service.update(
        'ngo-1',
        { id: 'opp-live', title: 'Hijacked' } as never,
        'host-org',
      ),
    ).rejects.toThrow(/only the student who created/i);
    expect(save).not.toHaveBeenCalled();
  });

  it("refuses an unrelated student editing someone else's listing", async () => {
    const { service, save } = makeUpdateService(liveStudentRow(), {
      id: 'student-2',
      role: 'student',
    });
    await expect(
      service.update('student-2', {
        id: 'opp-live',
        title: 'Hijacked',
      } as never),
    ).rejects.toBeDefined();
    expect(save).not.toHaveBeenCalled();
  });
});
