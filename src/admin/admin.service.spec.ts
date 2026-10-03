import { BadRequestException, ConflictException } from '@nestjs/common';
import { AdminService } from './admin.service';
import { AttendanceLog } from '../engagement/entities/attendance-log.entity';
import { Payment } from '../payments/entities/payment.entity';
import { OrganizationMembershipFee } from '../organization-membership/entities/organization-membership-fee.entity';
import { IssueLog } from '../issue-logs/entities/issue-log.entity';
import { SupportTicket } from '../support/entities/support-ticket.entity';
import { MasterAnalyticsQueryDto } from './dto/master-analytics-query.dto';
import { ReportPartnerApprovalSettingsService } from '../reports/report-partner-approval-settings.service';

/** Chainable TypeORM query-builder double that resolves to the given raw rows / count. */
const makeQb = (rows: unknown[] = [], count = 0) => {
  const qb: Record<string, jest.Mock> = {};
  for (const m of [
    'select',
    'addSelect',
    'where',
    'andWhere',
    'innerJoin',
    'groupBy',
    'addGroupBy',
  ]) {
    qb[m] = jest.fn(() => qb);
  }
  qb.getRawMany = jest.fn().mockResolvedValue(rows);
  qb.getCount = jest.fn().mockResolvedValue(count);
  return qb;
};

const fakeDataSource = (repos: Map<unknown, unknown>) => ({
  getRepository: (entity: unknown) => repos.get(entity),
});

const makeAdminServiceForTests = (overrides: Record<string, unknown> = {}) => {
  const repositories = {
    usersRepository: {
      count: jest.fn().mockResolvedValue(0),
    },
    opportunityRepository: {
      find: jest.fn().mockResolvedValue([]),
    },
    reportRepository: {},
    timesheetRepository: {
      find: jest.fn().mockResolvedValue([]),
      createQueryBuilder: jest.fn(() => makeQb([])),
    },
    auditLogsService: {
      findPaginated: jest.fn().mockResolvedValue({
        logs: [],
        total: 0,
        page: 1,
        limit: 20,
      }),
    },
    settingRepository: {},
    participationRepository: {
      find: jest.fn().mockResolvedValue([]),
    },
    studentReportRepository: {
      find: jest.fn().mockResolvedValue([]),
    },
    opportunityApplicationsService: {},
    studentsService: {
      getAdminTeamRosterForParticipation: jest.fn().mockResolvedValue(null),
    },
    opportunityApplicationRepository: {},
    reportPartnerApprovalSettings: {
      reportRequiresPartnerApprovalSync: jest
        .fn()
        .mockImplementation(
          (report: { opportunity?: { requiresPartnerApproval?: boolean } }) =>
            Boolean(report?.opportunity?.requiresPartnerApproval),
        ),
      isEnabledCached: jest.fn().mockReturnValue(true),
    },
    organizationMembershipService: {
      releasePendingPartnerMembershipAccounts: jest.fn().mockResolvedValue(0),
    },
    partnerMembershipSettings: {
      invalidateCache: jest.fn(),
      refreshCache: jest.fn().mockResolvedValue(false),
    },
    feedbackService: {},
    mailService: {
      sendHoursLoggingReminder: jest.fn().mockResolvedValue(undefined),
    },
    notificationsService: {
      createNotification: jest.fn().mockResolvedValue(undefined),
    },
    ...overrides,
  };

  return new AdminService(
    repositories.usersRepository as any,
    repositories.opportunityRepository as any,
    repositories.reportRepository as any,
    repositories.timesheetRepository as any,
    repositories.auditLogsService as any,
    repositories.settingRepository as any,
    repositories.participationRepository as any,
    repositories.studentReportRepository as any,
    repositories.opportunityApplicationsService as any,
    repositories.studentsService as any,
    repositories.opportunityApplicationRepository as any,
    repositories.reportPartnerApprovalSettings as any,
    repositories.organizationMembershipService as any,
    repositories.partnerMembershipSettings as any,
    repositories.feedbackService as any,
    repositories.mailService as any,
    repositories.notificationsService as any,
    undefined,
    (repositories as any).dataSource,
    (repositories as any).platformSettings,
  );
};

describe('AdminService impact analytics', () => {
  it('builds trend, SDG impact, and beneficiaries from approved student reports', async () => {
    const submittedAt = new Date('2026-05-01T00:00:00.000Z');
    const service = makeAdminServiceForTests({
      usersRepository: {
        count: jest.fn().mockResolvedValue(3),
      },
      participationRepository: {
        find: jest.fn().mockResolvedValue([{ studentId: 'student-1' }]),
      },
      studentReportRepository: {
        find: jest.fn().mockResolvedValue([
          {
            id: 'report-1',
            studentId: 'student-1',
            opportunityId: 'project-1',
            status: 'verified',
            partner_status: 'approved',
            admin_status: 'approved',
            submission_date: submittedAt,
            createdAt: submittedAt,
            opportunity: {
              id: 'project-1',
              sdg: 'Quality Education',
            },
            section1: { metrics: { total_verified_hours: 24 } },
            section4: { total_beneficiaries: '150' },
          },
        ]),
      },
      opportunityRepository: {
        find: jest.fn().mockResolvedValue([
          {
            id: 'project-1',
            objectives: { beneficiaries_count: '100' },
          },
          {
            id: 'project-2',
            objectives: { beneficiaries_count: '25' },
          },
        ]),
      },
    });

    const result = await service.getImpactAnalytics();

    expect(result.data.hours_trend).toEqual([
      { month: 'May', hours: 24, period: '2026-05', label: 'May 2026' },
    ]);
    expect(result.data.impact_by_sdg).toEqual([
      { name: 'Quality Education', value: 24 },
    ]);
    // Reached beneficiaries come from the reported project only; the unreported
    // project's planned 25 is returned separately and never mixed in.
    expect(result.data.stats).toEqual({
      active_volunteers: 1,
      partner_ngos: 3,
      total_beneficiaries: 150,
      planned_beneficiaries: 25,
      verified_hours: 0,
    });
  });

  it('does not double-count report hours when verified timesheets cover the same student project', async () => {
    const createdAt = new Date('2026-04-10T00:00:00.000Z');
    const service = makeAdminServiceForTests({
      usersRepository: {
        count: jest.fn().mockResolvedValueOnce(57).mockResolvedValueOnce(3),
      },
      timesheetRepository: {
        createQueryBuilder: jest.fn(() =>
          makeQb([
            {
              studentId: 'student-1',
              opportunityId: 'project-1',
              period: '2026-04',
              hours: '10',
            },
          ]),
        ),
      },
      opportunityRepository: {
        find: jest.fn().mockResolvedValue([{ id: 'project-1', sdg: 'SDG 4' }]),
      },
      studentReportRepository: {
        find: jest.fn().mockResolvedValue([
          {
            studentId: 'student-1',
            opportunityId: 'project-1',
            status: 'verified',
            partner_status: 'approved',
            admin_status: 'approved',
            submission_date: createdAt,
            createdAt,
            opportunity: { id: 'project-1', sdg: 'SDG 4' },
            section1: { metrics: { total_verified_hours: 10 } },
          },
        ]),
      },
    });

    const result = await service.getImpactAnalytics();

    expect(result.data.hours_trend).toEqual([
      { month: 'Apr', hours: 10, period: '2026-04', label: 'Apr 2026' },
    ]);
    expect(result.data.impact_by_sdg).toEqual([{ name: 'SDG 4', value: 10 }]);
  });

  it('includes admin-approved report hours when partner approval is not required', async () => {
    const submittedAt = new Date('2026-05-01T00:00:00.000Z');
    const service = makeAdminServiceForTests({
      usersRepository: {
        count: jest.fn().mockResolvedValueOnce(57).mockResolvedValueOnce(3),
      },
      studentReportRepository: {
        find: jest.fn().mockResolvedValue([
          {
            studentId: 'student-1',
            opportunityId: 'project-1',
            status: 'submitted',
            partner_status: 'pending',
            admin_status: 'approved',
            submission_date: submittedAt,
            createdAt: submittedAt,
            opportunity: {
              id: 'project-1',
              sdg: 'SDG 4',
              requiresPartnerApproval: false,
            },
            section1: { metrics: { total_verified_hours: 118.2 } },
          },
        ]),
      },
    });

    const result = await service.getImpactAnalytics();

    expect(result.data.hours_trend).toEqual([
      { month: 'May', hours: 118.2, period: '2026-05', label: 'May 2026' },
    ]);
    expect(result.data.impact_by_sdg).toEqual([
      { name: 'SDG 4', value: 118.2 },
    ]);
  });
});

describe('AdminService getMasterAnalytics', () => {
  const qbChain = () => ({
    leftJoinAndSelect: jest.fn().mockReturnThis(),
    leftJoin: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue([]),
  });

  const userQbEmpty = () => ({
    select: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    getRawMany: jest.fn().mockResolvedValue([]),
  });

  it('without filters uses participation find and returns filter_meta.active false', async () => {
    const participationFind = jest.fn().mockResolvedValue([]);
    const participationUniQb = {
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue([]),
    };
    const service = makeAdminServiceForTests({
      usersRepository: {
        count: jest
          .fn()
          .mockResolvedValueOnce(100)
          .mockResolvedValueOnce(40)
          .mockResolvedValueOnce(90),
        createQueryBuilder: jest.fn().mockImplementation(userQbEmpty),
      },
      participationRepository: {
        find: participationFind,
        createQueryBuilder: jest.fn().mockReturnValue(participationUniQb),
      },
    });

    const result = await service.getMasterAnalytics(
      {} as MasterAnalyticsQueryDto,
    );

    expect(participationFind).toHaveBeenCalled();
    expect(participationUniQb.select).toHaveBeenCalled();
    expect(result.data.filter_meta).toEqual({ active: false });
    expect(result.data.growth_meta.basis).toBe('student_accounts');
    expect(result.data.system_growth_rate_percent).not.toBeNull();
  });

  it('with filters uses query builder and returns filter_meta.active true', async () => {
    const chain = qbChain();
    const participationFind = jest.fn();
    const participationQb = jest.fn().mockReturnValue(chain);
    const service = makeAdminServiceForTests({
      usersRepository: {
        count: jest.fn().mockResolvedValue(0),
        createQueryBuilder: jest.fn().mockImplementation(userQbEmpty),
      },
      participationRepository: {
        find: participationFind,
        createQueryBuilder: participationQb,
      },
    });

    const result = await service.getMasterAnalytics({
      university: 'LUMS',
    } as MasterAnalyticsQueryDto);

    expect(participationFind).not.toHaveBeenCalled();
    expect(participationQb).toHaveBeenCalledWith('p');
    expect(chain.getMany).toHaveBeenCalled();
    expect(result.data.filter_meta).toEqual({
      active: true,
      params: { university: 'LUMS' },
    });
    expect(result.data.system_growth_rate_percent).toBeNull();
    expect(result.data.growth_meta.basis).toBe('filtered_participation_cohort');
  });

  it('enables admin attendance override for a team member participation', async () => {
    const teamLead = {
      id: 'lead-1',
      projectId: 'proj-1',
      studentId: 'lead-stu',
      fullName: 'Team Lead',
      email: 'lead@test.com',
      participationMode: 'team',
      isTeamLead: true,
      teamId: 'team-1',
      attendanceLocked: true,
      attendanceVerificationRequested: true,
      adminAttendanceEditable: false,
      student: {
        profile_verified: true,
        identity_verified: true,
      },
    };
    const participation = {
      id: 'part-1',
      projectId: 'proj-1',
      studentId: 'stu-1',
      fullName: 'Team Member',
      email: 'member@test.com',
      participationMode: 'team',
      isTeamLead: false,
      teamId: 'team-1',
      attendanceLocked: true,
      attendanceVerificationRequested: true,
      adminAttendanceEditable: false,
      student: {
        profile_verified: false,
        identity_verified: false,
      },
    };
    const teammate = {
      id: 'part-2',
      projectId: 'proj-1',
      studentId: 'stu-2',
      fullName: 'Other Member',
      email: 'other@test.com',
      participationMode: 'team',
      isTeamLead: false,
      teamId: 'team-1',
      attendanceLocked: true,
      attendanceVerificationRequested: true,
      adminAttendanceEditable: false,
      student: {
        profile_verified: false,
        identity_verified: false,
      },
    };

    const findOne = jest.fn().mockResolvedValue(participation);
    const save = jest.fn().mockImplementation(async (row) => row);
    const find = jest
      .fn()
      .mockResolvedValue([teamLead, participation, teammate]);

    const service = makeAdminServiceForTests({
      participationRepository: {
        findOne,
        save,
        find,
      },
    });

    const result = await service.setParticipationAttendanceEditable(
      'part-1',
      true,
    );

    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'part-1',
        adminAttendanceEditable: true,
        attendanceLocked: false,
        attendanceVerificationRequested: false,
      }),
    );
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'lead-1',
        adminAttendanceEditable: true,
        attendanceLocked: false,
        attendanceVerificationRequested: false,
      }),
    );
    expect(save).not.toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'part-2',
      }),
    );
    expect(result.data.admin_attendance_editable).toBe(true);
    expect(result.data.attendance_logging_unlock_status.unlocked).toBe(true);
    expect(result.data.attendance_logging_unlock_status.admin_override).toBe(
      true,
    );
  });

  it('enables admin attendance override for teammates when team lead is enabled', async () => {
    const teamLead = {
      id: 'lead-1',
      projectId: 'proj-1',
      studentId: 'lead-stu',
      fullName: 'Team Lead',
      email: 'lead@test.com',
      participationMode: 'team',
      isTeamLead: true,
      teamId: 'team-1',
      attendanceLocked: true,
      attendanceVerificationRequested: true,
      adminAttendanceEditable: false,
      student: {
        profile_verified: true,
        identity_verified: true,
      },
    };
    const teammate = {
      id: 'part-1',
      projectId: 'proj-1',
      studentId: 'stu-1',
      fullName: 'Team Member',
      email: 'member@test.com',
      participationMode: 'team',
      isTeamLead: false,
      teamId: 'team-1',
      attendanceLocked: true,
      attendanceVerificationRequested: true,
      adminAttendanceEditable: false,
      student: {
        profile_verified: false,
        identity_verified: false,
      },
    };
    const otherMember = {
      id: 'part-2',
      projectId: 'proj-1',
      studentId: 'stu-2',
      fullName: 'Other Member',
      email: 'other@test.com',
      participationMode: 'team',
      isTeamLead: false,
      teamId: 'team-2',
      attendanceLocked: true,
      attendanceVerificationRequested: true,
      adminAttendanceEditable: false,
      student: {
        profile_verified: false,
        identity_verified: false,
      },
    };

    const findOne = jest.fn().mockResolvedValue(teamLead);
    const save = jest.fn().mockImplementation(async (row) => row);
    const find = jest.fn().mockResolvedValue([teamLead, teammate, otherMember]);

    const service = makeAdminServiceForTests({
      participationRepository: {
        findOne,
        save,
        find,
      },
    });

    const result = await service.setParticipationAttendanceEditable(
      'lead-1',
      true,
    );

    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'lead-1',
        adminAttendanceEditable: true,
        attendanceLocked: false,
        attendanceVerificationRequested: false,
      }),
    );
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'part-1',
        adminAttendanceEditable: true,
        attendanceLocked: false,
        attendanceVerificationRequested: false,
      }),
    );
    expect(save).not.toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'part-2',
      }),
    );
    expect(result.data.admin_attendance_editable).toBe(true);
  });
});

describe('AdminService verified hours / dashboard', () => {
  it('attendance wins over timesheets for the same student+project (no double count)', async () => {
    const attendanceRepo = {
      createQueryBuilder: jest.fn(() =>
        makeQb([
          { studentId: 's1', opportunityId: 'p1', period: '2026-03', hours: '5.5' },
        ]),
      ),
    };
    const service = makeAdminServiceForTests({
      dataSource: fakeDataSource(new Map([[AttendanceLog, attendanceRepo]])),
      timesheetRepository: {
        createQueryBuilder: jest.fn(() =>
          makeQb([
            { studentId: 's1', opportunityId: 'p1', period: '2026-03', hours: '10' },
            { studentId: 's2', opportunityId: 'p1', period: '2026-03', hours: '2' },
          ]),
        ),
      },
    });
    const result = await (service as any).computeVerifiedHours();
    expect(result.total).toBe(7.5);
    expect(result.byOpportunity.get('p1')).toBe(7.5);
  });

  it('dashboard pendingApprovals includes the opportunity queue and reports both report counts', async () => {
    const service = makeAdminServiceForTests({
      usersRepository: { count: jest.fn().mockResolvedValue(2) },
      opportunityRepository: {
        count: jest.fn().mockResolvedValue(9),
        find: jest.fn().mockResolvedValue([]),
        createQueryBuilder: jest.fn(() => makeQb([], 4)),
      },
      reportRepository: { count: jest.fn().mockResolvedValue(6) },
      participationRepository: { count: jest.fn().mockResolvedValue(3) },
      studentReportRepository: { count: jest.fn().mockResolvedValue(11) },
      opportunityApplicationsService: {
        countPendingAdmin: jest.fn().mockResolvedValue(1),
      },
    });
    const { data } = await service.getDashboardStats();
    // 4 opportunities + 2 users + 3 participations + 1 join application
    expect(data.metrics.pendingApprovals).toBe(10);
    expect(data.metrics.totalReports).toBe(6);
    expect(data.metrics.issueReports).toBe(6);
    expect(data.metrics.studentReports).toBe(11);
  });

  it('getPendingCounts returns numeric counts and degrades a failing count to 0', async () => {
    const service = makeAdminServiceForTests({
      usersRepository: { count: jest.fn().mockResolvedValue(2) },
      opportunityRepository: {
        createQueryBuilder: jest.fn(() => makeQb([], 5)),
      },
      participationRepository: { count: jest.fn().mockResolvedValue(1) },
      studentReportRepository: { count: jest.fn().mockResolvedValue(7) },
      opportunityApplicationsService: {
        countPendingAdmin: jest.fn().mockRejectedValue(new Error('boom')),
      },
      dataSource: fakeDataSource(
        new Map<unknown, unknown>([
          [Payment, { count: jest.fn().mockResolvedValue(4) }],
          [OrganizationMembershipFee, { count: jest.fn().mockResolvedValue(3) }],
          [IssueLog, { count: jest.fn().mockResolvedValue(8) }],
          [SupportTicket, { count: jest.fn().mockResolvedValue(6) }],
        ]),
      ),
    });
    expect(await service.getPendingCounts()).toEqual({
      opportunityApprovals: 5,
      userApprovals: 3,
      joinApplications: 0,
      payments: 4,
      orgMembership: 3,
      reportsAwaitingAdmin: 7,
      issueLogsOpen: 8,
      supportOpen: 6,
    });
  });
});

describe('AdminService participation review', () => {
  it('rejects re-reviewing a participation that is no longer pending', async () => {
    const save = jest.fn();
    const service = makeAdminServiceForTests({
      participationRepository: {
        findOne: jest.fn().mockResolvedValue({ id: 'a', status: 'approved' }),
        save,
      },
    });
    await expect(service.approveApplication('a', 'admin-1')).rejects.toThrow(
      ConflictException,
    );
    await expect(
      service.rejectApplication('a', 'nope', 'admin-1'),
    ).rejects.toThrow(ConflictException);
    expect(save).not.toHaveBeenCalled();
  });

  it('approves a pending participation and notifies the student', async () => {
    const notificationsService = {
      createNotification: jest.fn().mockResolvedValue(undefined),
    };
    const service = makeAdminServiceForTests({
      notificationsService,
      participationRepository: {
        findOne: jest
          .fn()
          .mockResolvedValue({ id: 'a', status: 'pending', studentId: 'st-1' }),
        save: jest.fn(),
      },
    });
    await service.approveApplication('a', 'admin-1');
    expect(notificationsService.createNotification).toHaveBeenCalledWith(
      'st-1',
      expect.objectContaining({ type: 'approval' }),
    );
  });

  it('persists reviewer, time and reason on participation approve/reject', async () => {
    const seat: any = { id: 'a', status: 'pending', studentId: 'st-1' };
    const save = jest.fn();
    const service = makeAdminServiceForTests({
      participationRepository: { findOne: jest.fn().mockResolvedValue(seat), save },
    });
    await service.rejectApplication('a', '  Missing documents ', 'admin-9');
    expect(seat).toMatchObject({ status: 'rejected', reviewedBy: 'admin-9', reviewReason: 'Missing documents' });
    expect(seat.reviewedAt).toBeInstanceOf(Date);
  });
});

describe('AdminService settings', () => {
  const makeSettingsService = (existing: any) => {
    const settingRepository = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(existing),
      create: jest.fn((x) => ({ ...x })),
      save: jest.fn(async (x) => x),
    };
    const auditLogsService = { recordMutation: jest.fn() };
    const platformSettings = { invalidate: jest.fn() };
    const service = makeAdminServiceForTests({
      settingRepository,
      auditLogsService,
      platformSettings,
    });
    return { service, settingRepository, auditLogsService, platformSettings };
  };

  it('rejects unknown keys and bad values with 400', async () => {
    const { service, settingRepository } = makeSettingsService(null);
    await expect(service.updateSetting('JWT_SECRET', 'x')).rejects.toThrow(
      BadRequestException,
    );
    await expect(
      service.updateSetting('maintenance_mode', 'maybe'),
    ).rejects.toThrow(BadRequestException);
    expect(settingRepository.save).not.toHaveBeenCalled();
  });

  it('creates with type+description, invalidates the cache and writes an audit entry', async () => {
    const { service, settingRepository, auditLogsService, platformSettings } =
      makeSettingsService(null);
    await service.updateSetting('REPORTING_FEE_PKR', '2500', {
      id: 'admin-1',
      email: 'a@b.co',
    });
    expect(settingRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'REPORTING_FEE_PKR',
        value: '2500',
        type: 'number',
        description: expect.any(String),
      }),
    );
    expect(platformSettings.invalidate).toHaveBeenCalledWith('REPORTING_FEE_PKR');
    expect(auditLogsService.recordMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        details: {
          adminId: 'admin-1',
          key: 'REPORTING_FEE_PKR',
          old: null,
          new: '2500',
        },
      }),
    );
  });

  it('getSettings is read-only and returns only registry keys', async () => {
    const { service, settingRepository } = makeSettingsService(null);
    settingRepository.find.mockResolvedValue([
      { id: '1', key: 'site_name', value: 'X', type: 'string', updatedAt: new Date() },
      { id: '2', key: 'SECRET_THING', value: 'y', type: 'string', updatedAt: new Date() },
    ]);
    const res = await service.getSettings();
    expect(res.data.map((r) => r.key)).toEqual(['site_name']);
    expect(settingRepository.save).not.toHaveBeenCalled();
  });
});

describe('AdminService remindStudentsOnZeroHourProjects', () => {
  const setup = (over: Record<string, unknown> = {}) => {
    const mailService = {
      sendHoursLoggingReminder: jest
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('smtp down'))
        .mockResolvedValue(undefined),
    };
    const notificationsService = {
      createNotification: jest.fn().mockResolvedValue(undefined),
    };
    const service = makeAdminServiceForTests({
      mailService,
      notificationsService,
      opportunityRepository: {
        find: jest.fn().mockResolvedValue([{ id: 'p1', title: 'Live' }]),
      },
      participationRepository: {
        find: jest.fn().mockResolvedValue([
          { projectId: 'p1', email: 'a@x.co', fullName: 'A', studentId: 'sa' },
          { projectId: 'p1', email: 'b@x.co', fullName: 'B', studentId: 'sb' },
        ]),
      },
      ...over,
    });
    return { service, mailService, notificationsService };
  };

  it('dry run counts without sending', async () => {
    const { service, mailService } = setup();
    const res = await service.remindStudentsOnZeroHourProjects({ dryRun: true });
    expect(res.would_notify).toBe(2);
    expect(res.students_notified).toBe(0);
    expect(mailService.sendHoursLoggingReminder).not.toHaveBeenCalled();
  });

  it('one failing recipient does not stop the run, and a second run is on cooldown', async () => {
    const { service, notificationsService } = setup();
    const res = await service.remindStudentsOnZeroHourProjects();
    // b's email failed but the in-app notification still went out, so both count as notified.
    expect(res.students_notified).toBe(2);
    expect(notificationsService.createNotification).toHaveBeenCalledTimes(2);
    const again = await service.remindStudentsOnZeroHourProjects();
    expect(again.students_skipped_cooldown).toBe(2);
    expect(again.students_notified).toBe(0);
  });
});
