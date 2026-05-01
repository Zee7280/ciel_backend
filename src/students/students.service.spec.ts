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
