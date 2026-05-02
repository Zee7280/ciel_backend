import { StudentsService } from './students.service';

describe('StudentsService impact history', () => {
  const makeService = (overrides: Record<string, unknown> = {}) => {
    const repositories = {
      usersRepository: {},
      opportunitiesRepository: {},
      timesheetsRepository: { find: jest.fn().mockResolvedValue([]) },
      participantRepository: { find: jest.fn().mockResolvedValue([]) },
      studentReportsRepository: { find: jest.fn().mockResolvedValue([]) },
      orgRepository: {},
      otpRepository: {},
      usersService: {},
      mailService: {},
      engagementService: {},
      opportunityWorkflow: {},
      opportunitiesService: {},
      opportunityApplicationsService: {},
      ...overrides,
    };

    return new StudentsService(
      repositories.usersRepository as any,
      repositories.opportunitiesRepository as any,
      repositories.timesheetsRepository as any,
      repositories.participantRepository as any,
      repositories.studentReportsRepository as any,
      repositories.orgRepository as any,
      repositories.otpRepository as any,
      repositories.usersService as any,
      repositories.mailService as any,
      repositories.engagementService as any,
      repositories.opportunityWorkflow as any,
      repositories.opportunitiesService as any,
      repositories.opportunityApplicationsService as any,
    );
  };

  it('uses approved report hours when no verified timesheet exists', async () => {
    const now = new Date();
    const service = makeService({
      studentReportsRepository: {
        find: jest.fn().mockResolvedValue([
          {
            id: 'report-1',
            studentId: 'student-1',
            opportunityId: 'project-1',
            status: 'verified',
            partner_status: 'approved',
            admin_status: 'approved',
            submission_date: now,
            createdAt: now,
            section1: { metrics: { total_verified_hours: 12 } },
            section11: { ai_generated_impact_score: 88 },
          },
        ]),
      },
    });

    const result = await service.getImpactHistory('student-1', 'student');

    expect(result.data.total_hours).toBe(12);
    expect(result.data.pending_hours).toBe(0);
    expect(result.data.total_logged_hours).toBe(12);
    expect(result.data.hours_this_month).toBe(12);
    expect(result.data.projects_completed).toBe(1);
    expect(result.data.impact_score).toBe(88);
    expect(result.data.activities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'report-1',
          hours: 12,
          record_type: 'cii_report',
          status: 'certified',
        }),
      ]),
    );
  });

  it('treats admin-approved reports without partner approval requirement as certified', async () => {
    const now = new Date();
    const service = makeService({
      studentReportsRepository: {
        find: jest.fn().mockResolvedValue([
          {
            id: 'report-admin-approved',
            studentId: 'student-1',
            opportunityId: 'project-admin-approved',
            status: 'submitted',
            partner_status: 'pending',
            admin_status: 'approved',
            submission_date: now,
            createdAt: now,
            opportunity: { requiresPartnerApproval: false },
            section1: { metrics: { total_verified_hours: 118.2 } },
          },
        ]),
      },
    });

    const result = await service.getImpactHistory('student-1', 'student');

    expect(result.data.total_hours).toBe(118.2);
    expect(result.data.pending_hours).toBe(0);
    expect(result.data.projects_completed).toBe(1);
    expect(result.data.activities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'report-admin-approved',
          hours: 118.2,
          status: 'certified',
        }),
      ]),
    );
  });

  it('uses under-review report hours as pending when no pending timesheet exists', async () => {
    const now = new Date();
    const service = makeService({
      studentReportsRepository: {
        find: jest.fn().mockResolvedValue([
          {
            id: 'report-2',
            studentId: 'student-1',
            project_id: 'project-2',
            status: 'submitted',
            partner_status: 'pending',
            admin_status: 'pending',
            submission_date: now,
            createdAt: now,
            section1: {
              attendance_logs: [{ hours: '3.5 hours' }, { hours: 2 }],
            },
          },
        ]),
      },
    });

    const result = await service.getImpactHistory('student-1', 'student');

    expect(result.data.total_hours).toBe(0);
    expect(result.data.pending_hours).toBe(5.5);
    expect(result.data.total_logged_hours).toBe(5.5);
    expect(result.data.pending_hours_this_month).toBe(5.5);
    expect(result.data.activities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'report-2',
          hours: 5.5,
          project_id: 'project-2',
          status: 'under_review',
        }),
      ]),
    );
  });
});

describe('StudentsService getDashboard analytics', () => {
  it('exposes student_analytics and per-project fields including team_size', async () => {
    const createdAt = new Date('2025-01-15T12:00:00Z');
    const participantFind = jest.fn().mockImplementation((opts: { select?: string[] }) => {
      if (opts?.select) {
        return Promise.resolve([
          {
            id: 'self-p',
            projectId: 'proj-1',
            teamId: 'team-a',
            applicationId: null,
            participationMode: 'team',
          },
          {
            id: 'mate-1',
            projectId: 'proj-1',
            teamId: 'team-a',
            applicationId: null,
            participationMode: 'team',
          },
          {
            id: 'mate-2',
            projectId: 'proj-1',
            teamId: 'team-a',
            applicationId: null,
            participationMode: 'team',
          },
        ]);
      }
      return Promise.resolve([
        {
          projectId: 'proj-1',
          createdAt,
          status: 'approved',
          participationMode: 'team',
          teamId: 'team-a',
          applicationId: null,
          academicIntegrationType: 'Course-Linked',
          id: 'self-p',
          project: {
            title: 'Community Lab',
            sdg_info: { sdg_id: '4' },
            timeline: { expected_hours: 40 },
            requiredHours: 16,
          },
        },
      ]);
    });

    const service = new StudentsService(
      {
        findOne: jest.fn().mockResolvedValue({
          id: 'student-1',
          name: 'Ada',
          email: 'ada@test.edu',
          phone: '0300',
          city: 'Lahore',
          university: 'UET',
          department: 'CS',
          requires_cnic: false,
          requires_profile_verification: false,
          profile_verified: true,
          identity_verified: true,
        }),
      } as any,
      {} as any,
      { find: jest.fn().mockResolvedValue([]) } as any,
      {
        count: jest.fn().mockResolvedValue(0),
        find: participantFind,
      } as any,
      { find: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0) } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );

    const result = await service.getDashboard('student-1');

    expect(result.data.student_analytics).toEqual({
      profile_completion_percent: 100,
      completed_required_fields: 6,
      total_required_fields: 6,
      verified: true,
    });

    expect(result.data.activeProjects[0]).toEqual(
      expect.objectContaining({
        id: 'proj-1',
        required_hours_per_student: 40,
        participation_type: 'team',
        academic_integration_type: 'Course-Linked',
        team_size: 3,
      }),
    );
  });

  it('falls back to opportunity.requiredHours when timeline expected_hours is absent', async () => {
    const participantFind = jest.fn().mockImplementation((opts: { select?: string[] }) => {
      if (opts?.select) {
        return Promise.resolve([]);
      }
      return Promise.resolve([
        {
          projectId: 'proj-2',
          createdAt: new Date(),
          status: 'approved',
          participationMode: 'individual',
          teamId: null,
          applicationId: null,
          academicIntegrationType: null,
          id: 'solo-p',
          project: {
            title: 'Solo',
            sdg_info: {},
            timeline: {},
            requiredHours: 24,
          },
        },
      ]);
    });

    const service = new StudentsService(
      {
        findOne: jest.fn().mockResolvedValue({
          id: 'student-1',
          name: 'Bob',
          email: 'bob@test.edu',
          phone: '1',
          city: 'c',
          university: 'u',
          department: 'd',
          requires_cnic: false,
          requires_profile_verification: false,
          profile_verified: false,
          identity_verified: false,
        }),
      } as any,
      {} as any,
      { find: jest.fn().mockResolvedValue([]) } as any,
      { count: jest.fn().mockResolvedValue(0), find: participantFind } as any,
      { find: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0) } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );

    const result = await service.getDashboard('student-1');
    expect(result.data.student_analytics?.verified).toBe(false);
    expect(result.data.activeProjects[0]?.required_hours_per_student).toBe(24);
    expect(result.data.activeProjects[0]?.team_size).toBe(1);
  });
});
