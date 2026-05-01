import { AdminService } from './admin.service';

describe('AdminService impact analytics', () => {
    const makeService = (overrides: Record<string, unknown> = {}) => {
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
        );
    };

    it('builds trend, SDG impact, and beneficiaries from approved student reports', async () => {
        const submittedAt = new Date('2026-05-01T00:00:00.000Z');
        const service = makeService({
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
        const service = makeService({
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
        const service = makeService({
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
