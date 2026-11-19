import { StudentsService } from './students.service';

type Args = ConstructorParameters<typeof StudentsService>;

/** `GET /student/projects/:id` — the payload the report page builds its mission card, Section 3 and package from. */
function makeService(row: Record<string, unknown>) {
  const args: unknown[] = [
    // usersRepository
    {
      findOne: jest.fn().mockResolvedValue({
        id: 'student-1',
        email: 'student@uni.edu',
        role: 'student',
        university: 'BNU',
      }),
    },
    // opportunitiesRepository
    { findOne: jest.fn().mockResolvedValue(row) },
    // timesheetsRepository
    {
      findOne: jest.fn().mockResolvedValue(null),
      find: jest.fn().mockResolvedValue([]),
    },
    // participantRepository
    {
      findOne: jest.fn().mockResolvedValue(null),
      find: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
    // studentReportsRepository
    {
      findOne: jest.fn().mockResolvedValue(null),
      find: jest.fn().mockResolvedValue([]),
    },
    // orgRepository
    { findOne: jest.fn().mockResolvedValue(null) },
    // otpRepository
    {},
    // usersService
    {},
    // mailService
    {},
    // engagementService
    {},
    // opportunityWorkflow
    {},
    // opportunitiesService
    {
      assertViewerMayOpenOpportunity: jest
        .fn()
        .mockResolvedValue({ privileged: true }),
    },
    // opportunityApplicationsService
    {
      resolveStudentJoinOverlay: jest.fn().mockResolvedValue({
        applicationStatus: null,
        applicationStage: null,
        applicationInternalStatus: null,
        hasApplied: false,
      }),
      countSeatsInFlight: jest.fn().mockResolvedValue(0),
    },
    // studentReportsService
    { getMergedReportsForParticipant: jest.fn().mockResolvedValue([]) },
    // reportPartnerApprovalSettings
    {
      reportRequiresPartnerApprovalSync: jest.fn().mockReturnValue(false),
      isEnabledCached: jest.fn().mockReturnValue(true),
    },
  ];
  return new StudentsService(...(args as Args));
}

const liveStudentOpportunity = {
  id: '77777777-7777-4777-8777-777777777777',
  title: 'TEST – Campus Clean-Up and Recycling Drive',
  isStudentCreated: true,
  creatorId: 'student-1',
  organizationId: 'org-1',
  organization: { name: 'NGO' },
  status: 'active',
  admin_approved: true,
  workflowStage: 'live',
  types: ['Environment'],
  timeline: {
    expected_hours: 40,
    start_date: '2026-11-02',
    end_date: '2026-11-20',
  },
  objectives: {},
  sdg_info: { sdg_id: '12', target_id: '12.5' },
  secondary_sdgs: [
    { sdg_id: '11', target_id: '11.6', justification: 'Cleaner campus' },
  ],
  supervision: { supervisor_name: 'Zubair Faculty', contact: 'zubair@uni.edu' },
};

describe('student project detail — registered SDGs reach the report', () => {
  it('carries the supporting SDGs next to sdg_info', async () => {
    const service = makeService(liveStudentOpportunity);
    const result = (await service.getProjectById(
      liveStudentOpportunity.id,
      'student-1',
    )) as { data: Record<string, unknown> };
    expect(result.data.sdg_info).toEqual({ sdg_id: '12', target_id: '12.5' });
    expect(result.data.secondary_sdgs).toEqual([
      { sdg_id: '11', target_id: '11.6', justification: 'Cleaner campus' },
    ]);
  });

  it('an opportunity without supporting SDGs sends an empty list (never undefined)', async () => {
    const service = makeService({
      ...liveStudentOpportunity,
      secondary_sdgs: null,
    });
    const result = (await service.getProjectById(
      liveStudentOpportunity.id,
      'student-1',
    )) as { data: Record<string, unknown> };
    expect(result.data.secondary_sdgs).toEqual([]);
  });
});
