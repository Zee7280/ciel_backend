import { AdminService } from './admin.service';
import { MasterAnalyticsQueryDto } from './dto/master-analytics-query.dto';
import { ReportPartnerApprovalSettingsService } from '../reports/report-partner-approval-settings.service';

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
            reportRequiresPartnerApprovalSync: jest.fn().mockImplementation((report: { opportunity?: { requiresPartnerApproval?: boolean } }) =>
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
    );
};

describe('AdminService impact analytics', () => {
    it('builds trend, SDG impact, and beneficiaries from approved student reports', async () => {
        const submittedAt = new Date('2026-05-01T00:00:00.000Z');
        const service = makeAdminServiceForTests({
            usersRepository: {
                count: jest
                    .fn()
                    .mockResolvedValueOnce(57)
                    .mockResolvedValueOnce(3),
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

        expect(result.data.hours_trend).toEqual([{ month: 'May', hours: 24 }]);
        expect(result.data.impact_by_sdg).toEqual([{ name: 'Quality Education', value: 24 }]);
        expect(result.data.stats).toEqual({
            active_volunteers: 1,
            partner_ngos: 3,
            total_beneficiaries: 175,
        });
    });

    it('does not double-count report hours when verified timesheets cover the same student project', async () => {
        const createdAt = new Date('2026-04-10T00:00:00.000Z');
        const service = makeAdminServiceForTests({
            usersRepository: {
                count: jest
                    .fn()
                    .mockResolvedValueOnce(57)
                    .mockResolvedValueOnce(3),
            },
            timesheetRepository: {
                find: jest.fn().mockResolvedValue([
                    {
                        studentId: 'student-1',
                        opportunityId: 'project-1',
                        hours: 10,
                        createdAt,
                        opportunity: { id: 'project-1', sdg: 'SDG 4' },
                    },
                ]),
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

        expect(result.data.hours_trend).toEqual([{ month: 'Apr', hours: 10 }]);
        expect(result.data.impact_by_sdg).toEqual([{ name: 'SDG 4', value: 10 }]);
    });

    it('includes admin-approved report hours when partner approval is not required', async () => {
        const submittedAt = new Date('2026-05-01T00:00:00.000Z');
        const service = makeAdminServiceForTests({
            usersRepository: {
                count: jest
                    .fn()
                    .mockResolvedValueOnce(57)
                    .mockResolvedValueOnce(3),
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

        expect(result.data.hours_trend).toEqual([{ month: 'May', hours: 118.2 }]);
        expect(result.data.impact_by_sdg).toEqual([{ name: 'SDG 4', value: 118.2 }]);
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

        const result = await service.getMasterAnalytics({} as MasterAnalyticsQueryDto);

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

        const result = await service.getMasterAnalytics({ university: 'LUMS' } as MasterAnalyticsQueryDto);

        expect(participationFind).not.toHaveBeenCalled();
        expect(participationQb).toHaveBeenCalledWith('p');
        expect(chain.getMany).toHaveBeenCalled();
        expect(result.data.filter_meta).toEqual({ active: true, params: { university: 'LUMS' } });
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
        const find = jest.fn().mockResolvedValue([teamLead, participation, teammate]);

        const service = makeAdminServiceForTests({
            participationRepository: {
                findOne,
                save,
                find,
            },
        });

        const result = await service.setParticipationAttendanceEditable('part-1', true);

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
        expect(result.data.attendance_logging_unlock_status.admin_override).toBe(true);
    });
});
