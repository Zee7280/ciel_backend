import { NotFoundException } from '@nestjs/common';
import { StudentsService } from './students.service';
import { ReportPartnerApprovalSettingsService } from '../reports/report-partner-approval-settings.service';

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
      studentReportsService: {
        getMergedReportsForParticipant: jest.fn().mockResolvedValue([]),
      },
      reportPartnerApprovalSettings: {
        reportRequiresPartnerApprovalSync: jest.fn().mockImplementation((report: { opportunity?: { requiresPartnerApproval?: boolean } }) =>
          Boolean(report?.opportunity?.requiresPartnerApproval),
        ),
        isEnabledCached: jest.fn().mockReturnValue(true),
      },
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
      repositories.studentReportsService as any,
      repositories.reportPartnerApprovalSettings as any,
    );
  };

describe('StudentsService impact history', () => {
  it('includes an approved student-created opportunity in the student browse listing', async () => {
    const opportunities = [
      {
        id: 'opp-team-1',
        isStudentCreated: true,
        status: 'active',
        admin_approved: true,
        workflowStage: 'live',
        types: [],
        organization: null,
        timeline: {},
        objectives: {},
      },
      {
        id: 'opp-normal-1',
        isStudentCreated: false,
        status: 'active',
        admin_approved: true,
        workflowStage: 'live',
        types: [],
        organization: null,
        timeline: {},
        objectives: {},
      },
    ];
    const service = makeService({
      opportunitiesRepository: {
        find: jest.fn().mockResolvedValue(opportunities),
      },
      participantRepository: {
        find: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
      opportunityApplicationsService: {
        mapCurrentApplicationsForOpportunities: jest.fn().mockResolvedValue(new Map()),
        resolveStudentJoinOverlay: jest.fn().mockResolvedValue({
          applicationStatus: null,
          hasApplied: false,
          app: null,
        }),
        countSeatsInFlight: jest.fn().mockResolvedValue(0),
      },
      opportunitiesService: {
        getFacultyOrgFallback: jest.fn().mockResolvedValue(null),
      },
    });

    const result = await service.getOpportunities({}, 'user-1');

    expect(result.data.map((o: any) => o.id)).toEqual(['opp-team-1', 'opp-normal-1']);
    expect(result.path_counts).toEqual({
      all: 2,
      community_service: 2,
      coursework: 0,
      fyp: 0,
      startup: 0,
    });
    expect(result.data[0].path_key).toBe('community_service');
    expect(result.data[0].path_label).toBe('Community Service');
    expect(result.data[0].created_by_role).toBe('student');
    expect(result.data[1].created_by_role).toBeNull();
  });

  it('omits Super Admin-hidden opportunities from the student browse listing', async () => {
    const opportunities = [
      {
        id: 'opp-visible',
        isStudentCreated: false,
        status: 'active',
        admin_approved: true,
        workflowStage: 'live',
        types: [],
        organization: null,
        timeline: {},
        objectives: {},
      },
      {
        id: 'opp-hidden',
        isStudentCreated: false,
        status: 'active',
        admin_approved: true,
        workflowStage: 'live',
        admin_hidden: true,
        types: [],
        organization: null,
        timeline: {},
        objectives: {},
      },
    ];
    const service = makeService({
      opportunitiesRepository: {
        find: jest.fn().mockResolvedValue(opportunities),
      },
      participantRepository: {
        find: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
      opportunityApplicationsService: {
        mapCurrentApplicationsForOpportunities: jest.fn().mockResolvedValue(new Map()),
        resolveStudentJoinOverlay: jest.fn().mockResolvedValue({
          applicationStatus: null,
          hasApplied: false,
          app: null,
        }),
        countSeatsInFlight: jest.fn().mockResolvedValue(0),
      },
      opportunitiesService: {
        getFacultyOrgFallback: jest.fn().mockResolvedValue(null),
      },
    });

    const result = await service.getOpportunities({}, 'user-1');
    expect(result.data.map((o: any) => o.id)).toEqual(['opp-visible']);
  });

  it('getOpportunityById: a stranger gets 404 on a hidden opportunity, but an already-applied student still sees it', async () => {
    const hidden = {
      id: 'opp-hidden',
      isStudentCreated: false,
      status: 'active',
      admin_approved: true,
      workflowStage: 'live',
      admin_hidden: true,
      types: [],
      organization: null,
      timeline: {},
      objectives: {},
    };

    const strangerService = makeService({
      opportunitiesRepository: { findOne: jest.fn().mockResolvedValue(hidden) },
      participantRepository: {
        findOne: jest.fn().mockResolvedValue(null),
        count: jest.fn().mockResolvedValue(0),
      },
      opportunityApplicationsService: {
        resolveStudentJoinOverlay: jest.fn().mockResolvedValue({
          applicationStatus: null,
          applicationStage: null,
          applicationInternalStatus: null,
          hasApplied: false,
        }),
        countSeatsInFlight: jest.fn().mockResolvedValue(0),
      },
    });
    await expect(
      strangerService.getOpportunityById('opp-hidden', 'stranger-user'),
    ).rejects.toBeInstanceOf(NotFoundException);

    const enrolledService = makeService({
      opportunitiesRepository: { findOne: jest.fn().mockResolvedValue(hidden) },
      participantRepository: {
        findOne: jest.fn().mockResolvedValue({ studentId: 'enrolled-user', projectId: 'opp-hidden' }),
        count: jest.fn().mockResolvedValue(0),
      },
      opportunityApplicationsService: {
        resolveStudentJoinOverlay: jest.fn().mockResolvedValue({
          applicationStatus: 'accepted',
          applicationStage: null,
          applicationInternalStatus: null,
          hasApplied: true,
        }),
        countSeatsInFlight: jest.fn().mockResolvedValue(0),
      },
    });
    const result = await enrolledService.getOpportunityById('opp-hidden', 'enrolled-user');
    expect(result.success).toBe(true);
    expect(result.data.id).toBe('opp-hidden');
  });

  it('attributes a faculty-created opportunity (no Organization row) to the faculty institution instead of "Unknown"', async () => {
    const opportunities = [
      {
        id: 'opp-faculty-1',
        isStudentCreated: false,
        facultyId: 'faculty-1',
        organizationId: null,
        status: 'active',
        admin_approved: true,
        workflowStage: 'live',
        types: [],
        organization: null,
        timeline: {},
        objectives: {},
      },
    ];
    const service = makeService({
      opportunitiesRepository: {
        find: jest.fn().mockResolvedValue(opportunities),
      },
      participantRepository: {
        find: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
      opportunityApplicationsService: {
        mapCurrentApplicationsForOpportunities: jest.fn().mockResolvedValue(new Map()),
        resolveStudentJoinOverlay: jest.fn().mockResolvedValue({
          applicationStatus: null,
          hasApplied: false,
          app: null,
        }),
        countSeatsInFlight: jest.fn().mockResolvedValue(0),
      },
      opportunitiesService: {
        getFacultyOrgFallback: jest.fn().mockResolvedValue({
          id: null,
          name: 'Acme University',
          logo_url: null,
        }),
      },
    });

    const result = await service.getOpportunities({}, 'user-1');

    expect(result.data[0].organization).toBe('Acme University');
    expect(result.data[0].organization_name).toBe('Acme University');
    expect(result.data[0].created_by_role).toBe('faculty');
  });

  it('uses approved report hours when no verified timesheet exists', async () => {
    const now = new Date();
    const queryBuilder = {
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue([]),
    };
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
        createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
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
      {
        getMergedReportsForParticipant: jest.fn().mockResolvedValue([]),
      } as any,
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
      {
        getMergedReportsForParticipant: jest.fn().mockResolvedValue([]),
      } as any,
      {} as any,
    );

    const result = await service.getDashboard('student-1');
    expect(result.data.student_analytics?.verified).toBe(false);
    expect(result.data.activeProjects[0]?.required_hours_per_student).toBe(24);
    expect(result.data.activeProjects[0]?.team_size).toBe(1);
  });
});

describe('StudentsService.sendTeamMemberOtp', () => {
  const makeOtpService = (existingSeat: { id: string; isTeamLead: boolean } | null) => {
    const qb = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue(existingSeat),
    };
    return makeService({
      participantRepository: {
        find: jest.fn().mockResolvedValue([]),
        createQueryBuilder: jest.fn().mockReturnValue(qb),
      },
      otpRepository: {
        findOne: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockImplementation((row) => row),
        save: jest.fn().mockImplementation((row) => row),
      },
      mailService: {
        sendTeamMemberOtp: jest.fn().mockResolvedValue(undefined),
      },
    });
  };

  it('rejects OTP when the email belongs to the team lead on the project', async () => {
    const service = makeOtpService({ id: 'lead-1', isTeamLead: true });
    await expect(
      service.sendTeamMemberOtp('lead@test.edu', 'proj-1', true),
    ).rejects.toThrow(/already used by the team lead/);
  });

  it('rejects OTP when the email is already a teammate on the project', async () => {
    const service = makeOtpService({ id: 'member-1', isTeamLead: false });
    await expect(
      service.sendTeamMemberOtp('member@test.edu', 'proj-1', true),
    ).rejects.toThrow(/already on this team/);
  });

  it('sends OTP when the email is not already on the project', async () => {
    const service = makeOtpService(null);
    const result = await service.sendTeamMemberOtp('new@test.edu', 'proj-1', true);
    expect(result).toEqual({
      success: true,
      message: 'OTP sent successfully',
    });
  });

  it('still sends OTP for self-verify when the caller is already seated', async () => {
    const service = makeOtpService({ id: 'lead-1', isTeamLead: true });
    const result = await service.sendTeamMemberOtp('lead@test.edu', 'proj-1');
    expect(result).toEqual({
      success: true,
      message: 'OTP sent successfully',
    });
  });

  it('stores the OTP record against a normalized (trimmed, lowercased) email', async () => {
    const save = jest.fn().mockImplementation((row) => row);
    const service = makeService({
      participantRepository: { find: jest.fn().mockResolvedValue([]) },
      otpRepository: {
        findOne: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockImplementation((row) => row),
        save,
      },
      mailService: { sendTeamMemberOtp: jest.fn().mockResolvedValue(undefined) },
    });
    await service.sendTeamMemberOtp('  New@Test.EDU  ');
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'new@test.edu' }),
    );
  });

  it('skips a broken roster duplicate-check instead of 500ing the whole OTP send', async () => {
    const save = jest.fn().mockImplementation((row) => row);
    const service = makeService({
      participantRepository: {
        find: jest.fn().mockResolvedValue([]),
        createQueryBuilder: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnThis(),
          andWhere: jest.fn().mockReturnThis(),
          getOne: jest.fn().mockRejectedValue(new Error('invalid input syntax for type uuid')),
        }),
      },
      otpRepository: {
        findOne: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockImplementation((row) => row),
        save,
      },
      mailService: { sendTeamMemberOtp: jest.fn().mockResolvedValue(undefined) },
    });
    const result = await service.sendTeamMemberOtp('new@test.edu', 'not-a-real-uuid', true);
    expect(result).toEqual({ success: true, message: 'OTP sent successfully' });
    expect(save).toHaveBeenCalled();
  });

  it('turns an OTP-record save failure into a clean message instead of an unhandled 500', async () => {
    const service = makeService({
      participantRepository: { find: jest.fn().mockResolvedValue([]) },
      otpRepository: {
        findOne: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockImplementation((row) => row),
        save: jest.fn().mockRejectedValue(new Error('relation "otps" has no column "foo"')),
      },
      mailService: { sendTeamMemberOtp: jest.fn().mockResolvedValue(undefined) },
    });
    await expect(service.sendTeamMemberOtp('new@test.edu')).rejects.toThrow(
      /Failed to send verification code/,
    );
  });
});

describe('StudentsService.confirmTeamMemberOtp', () => {
  it('looks up the OTP record by normalized email', async () => {
    const findOne = jest.fn().mockResolvedValue(null);
    const service = makeService({ otpRepository: { findOne } });
    await expect(
      service.confirmTeamMemberOtp(' New@Test.EDU ', '123456'),
    ).rejects.toThrow(/Invalid OTP/);
    expect(findOne).toHaveBeenCalledWith({
      where: { email: 'new@test.edu', otp: '123456' },
    });
  });

  it('turns an OTP lookup failure into a clean message instead of an unhandled 500', async () => {
    const service = makeService({
      otpRepository: {
        findOne: jest.fn().mockRejectedValue(new Error('connection terminated')),
      },
    });
    await expect(
      service.confirmTeamMemberOtp('new@test.edu', '123456'),
    ).rejects.toThrow(/Could not verify the code right now/);
  });

  it('still reports success when verification passed but the cleanup delete fails', async () => {
    const record = { email: 'new@test.edu', otp: '123456', expiresAt: new Date(Date.now() + 60000) };
    const service = makeService({
      otpRepository: {
        findOne: jest.fn().mockResolvedValue(record),
        remove: jest.fn().mockRejectedValue(new Error('row locked')),
      },
    });
    const result = await service.confirmTeamMemberOtp('new@test.edu', '123456');
    expect(result).toEqual({ success: true, message: 'Email verified' });
  });
});

describe('StudentsService.sendTeamMemberVerification', () => {
  it('turns a mail-send failure into a clean message instead of an unhandled 500', async () => {
    const service = makeService({
      mailService: {
        sendTeamMemberInvite: jest.fn().mockRejectedValue(new Error('SMTP auth failed')),
      },
    });
    await expect(service.sendTeamMemberVerification('new@test.edu')).rejects.toThrow(
      /Failed to send the invitation email/,
    );
  });
});

describe('StudentsService.updateStudentOpportunity — same guards as create', () => {
  const baseOpp = () => ({
    id: 'opp-1',
    creatorId: 'stu-1',
    isStudentCreated: true,
    admin_approved: false,
    status: 'pending_faculty',
    workflowStage: 'pending_faculty',
    executing_context: { student_pathway: 'university' },
    restricted_universities: ['BNU'],
    participation_scope: { rule: 'own_university_only' },
  });

  const setup = () => {
    const opp = baseOpp();
    const save = jest.fn(async (row: unknown) => row);
    const validateEditPatch = jest.fn();
    const service = makeService({
      opportunitiesRepository: { findOne: jest.fn().mockResolvedValue(opp), save },
      usersRepository: { findOne: jest.fn().mockResolvedValue({ id: 'stu-1', university: 'BNU' }) },
      opportunitiesService: {
        validateEditPatch,
        validateLocation: jest.fn(),
        validateTimeline: jest.fn(),
        snapshotStudentOpportunityResubmit: jest.fn(),
      },
    });
    return { service, opp, save, validateEditPatch };
  };

  it('refuses to widen the scope to all universities', async () => {
    const { service } = setup();
    await expect(
      service.updateStudentOpportunity('stu-1', 'opp-1', {
        participation_scope: { rule: 'open_all_universities' },
      } as any),
    ).rejects.toThrow(/own university/);
  });

  it('forces restricted_universities to the student\'s own university, ignoring the client value', async () => {
    const { service, opp } = setup();
    await service.updateStudentOpportunity('stu-1', 'opp-1', {
      title: 'New title',
      restricted_universities: ['LUMS', 'IBA'],
      participation_scope: { rule: 'own_university_only', university_names: ['LUMS'] },
    } as any);
    expect(opp.restricted_universities).toEqual(['BNU']);
    expect((opp.participation_scope as any).university_names).toEqual(['BNU']);
    expect((opp.participation_scope as any).creator_university_name).toBe('BNU');
  });

  it('runs the create-time validators on the edited keys', async () => {
    const { service, validateEditPatch } = setup();
    await service.updateStudentOpportunity('stu-1', 'opp-1', {
      supervision: { contact: 'teacher@uni.edu' },
    } as any);
    expect(validateEditPatch).toHaveBeenCalledWith(
      expect.objectContaining({ supervision: { contact: 'teacher@uni.edu' } }),
    );
  });

  it('propagates a validator rejection (nothing is saved)', async () => {
    const { service, save, validateEditPatch } = setup();
    validateEditPatch.mockImplementation(() => {
      throw new Error('All safety_declaration checks must be true');
    });
    await expect(
      service.updateStudentOpportunity('stu-1', 'opp-1', { safety_declaration: {} } as any),
    ).rejects.toThrow(/safety_declaration/);
    expect(save).not.toHaveBeenCalled();
  });
});

describe('StudentsService.applyToOpportunity — dates, seats and team eligibility', () => {
  const TODAY = new Date().toISOString().slice(0, 10);
  const addDays = (d: number) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);

  const build = (opts: {
    timeline?: Record<string, unknown>;
    occupied?: number;
    scope?: Record<string, unknown>;
    memberUsers?: Array<Record<string, unknown>>;
  }) => {
    const opportunity: any = {
      id: '11111111-1111-4111-8111-111111111111',
      title: 'Project',
      status: 'active',
      admin_approved: true,
      workflowStage: 'live',
      timeline: opts.timeline ?? { start_date: addDays(-5), end_date: addDays(20), volunteers_required: 10 },
      participation_scope: opts.scope ?? { rule: 'open_all_universities' },
      supervision: { contact: 'faculty@uni.edu' },
    };
    const user = { id: 'lead', name: 'Lead', email: 'lead@uni.edu', university: 'BNU', department: 'Arch' };
    const qb = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue(null),
      getMany: jest.fn().mockResolvedValue(opts.memberUsers ?? []),
    };
    const createApplication = jest.fn().mockResolvedValue({ id: 'app-1', internalStatus: 'pending_faculty' });
    const chain: any = new Proxy(
      {},
      {
        get: (_t, prop: string) => {
          if (prop === 'getMany' || prop === 'getRawMany') return jest.fn().mockResolvedValue([]);
          if (prop === 'getOne' || prop === 'getRawOne') return jest.fn().mockResolvedValue(null);
          if (prop === 'getCount') return jest.fn().mockResolvedValue(0);
          return jest.fn().mockReturnValue(chain);
        },
      },
    );
    const apps = {
      hasOpenPipelineApplication: jest.fn().mockResolvedValue(false),
      findLatestForStudentOpportunity: jest.fn().mockResolvedValue(null),
      isTerminalRejection: jest.fn().mockReturnValue(false),
      collectClaimedEmailsOnOpenApplications: jest.fn().mockResolvedValue(new Set()),
      isTeamSlugInUseOnOpportunity: jest.fn().mockResolvedValue(false),
      countSeatsInFlight: jest.fn().mockResolvedValue(0),
      createApplication,
      toPublicApplicationStatus: jest.fn().mockReturnValue('pending'),
      applicationStage: jest.fn().mockReturnValue('faculty'),
    };
    const service = makeService({
      opportunitiesRepository: { findOne: jest.fn().mockResolvedValue(opportunity) },
      usersRepository: { findOne: jest.fn().mockResolvedValue(user), createQueryBuilder: jest.fn(() => qb) },
      participantRepository: {
        findOne: jest.fn().mockResolvedValue(null),
        find: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(opts.occupied ?? 0),
        createQueryBuilder: jest.fn(() => chain),
      },
      opportunityApplicationsService: apps,
      mailService: {
        sendFacultyApprovalRequest: jest.fn(),
        sendFacultyCollaboratorNotice: jest.fn(),
        sendApplicationSubmitted: jest.fn(),
      },
    });
    return { service, opportunity, createApplication };
  };

  const dto = (over: Record<string, unknown> = {}) =>
    ({
      opportunityId: '11111111-1111-4111-8111-111111111111',
      participation_type: 'individual',
      primary_faculty_email: 'faculty@uni.edu',
      contact_phone_e164: '+923001234567',
      ...over,
    }) as any;

  it('accepts an eligible individual application while the project is running', async () => {
    const { service, createApplication } = build({});
    await expect(service.applyToOpportunity('lead', dto())).resolves.toMatchObject({ success: true });
    expect(createApplication).toHaveBeenCalled();
  });

  it('refuses NEW applications after the project end date, even inside the 60-day reporting window', async () => {
    const { service, createApplication } = build({
      timeline: { start_date: addDays(-40), end_date: addDays(-10), volunteers_required: 10 },
    });
    await expect(service.applyToOpportunity('lead', dto())).rejects.toThrow(/has ended, so new applications are closed/);
    expect(createApplication).not.toHaveBeenCalled();
  });

  it('refuses when every seat is taken', async () => {
    const { service, createApplication } = build({ occupied: 10 });
    await expect(service.applyToOpportunity('lead', dto())).rejects.toThrow(/All seats .* are taken/);
    expect(createApplication).not.toHaveBeenCalled();
  });

  it('refuses a team that needs more seats than are still free', async () => {
    const { service } = build({ occupied: 8 }); // 2 free; lead + 2 members needs 3
    await expect(
      service.applyToOpportunity(
        'lead',
        dto({
          participation_type: 'team',
          team_members: [
            { email: 'a@uni.edu', name: 'A', mobile: '03001111111' },
            { email: 'b@uni.edu', name: 'B', mobile: '03002222222' },
          ],
        }),
      ),
    ).rejects.toThrow(/Only 2 seats left/);
  });

  it("refuses a team member whose account is not eligible (different university than the opportunity allows)", async () => {
    const { service, createApplication } = build({
      scope: { rule: 'own_university_only', creator_university_name: 'BNU', university_names: ['BNU'] },
      memberUsers: [{ id: 'm1', email: 'a@other.edu', university: 'LUMS', department: 'CS' }],
    });
    await expect(
      service.applyToOpportunity(
        'lead',
        dto({
          participation_type: 'team',
          team_members: [{ email: 'a@other.edu', name: 'A', mobile: '03001111111' }],
        }),
      ),
    ).rejects.toThrow(/a@other.edu cannot join/);
    expect(createApplication).not.toHaveBeenCalled();
  });
});
