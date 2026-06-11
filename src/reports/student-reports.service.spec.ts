import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { StudentReportsService } from './student-reports.service';
import { Opportunity } from '../opportunities/entities/opportunity.entity';
import { Participation } from '../engagement/entities/participant.entity';
import { StudentReport } from './entities/student-report.entity';
import { AttendanceLog } from '../engagement/entities/attendance-log.entity';
import { User } from '../users/entities/user.entity';
import { Payment } from '../payments/entities/payment.entity';
import { S3Service } from '../common/s3.service';
import { EngagementService } from '../engagement/engagement.service';
import { MailService } from '../mail/mail.service';
import { ConfigService } from '@nestjs/config';
import { ReportPartnerApprovalSettingsService } from './report-partner-approval-settings.service';
import { evaluateReportRequiresPartnerApproval } from './report-partner-approval.util';

describe('StudentReportsService', () => {
    let service: StudentReportsService;

    const mockOpportunityRepository = {
        findOne: jest.fn(),
    };
    const mockParticipantRepository = {
        findOne: jest.fn().mockResolvedValue(null),
        find: jest.fn().mockResolvedValue([]),
    };
    const mockStudentReportsRepository = {
        findOne: jest.fn(),
        find: jest.fn().mockResolvedValue([]),
        create: jest.fn(),
        save: jest.fn(),
    };
    const mockAttendanceLogsRepository = {
        find: jest.fn().mockResolvedValue([]),
    };
    const mockUsersRepository = {
        findOne: jest.fn(),
    };
    const mockPaymentRepository = {
        findOne: jest.fn().mockResolvedValue(null),
    };
    const mockS3Service = {
        uploadFile: jest.fn(),
    };
    const mockEngagementService = {
        getProjectTeamForReportDossier: jest.fn().mockResolvedValue([]),
        decryptCnicInternal: jest.fn((v: string) => v),
    };
    const mockMailService = {
        sendAdminStudentReportSubmitted: jest.fn().mockResolvedValue(undefined),
        sendFacultyInvite: jest.fn().mockResolvedValue(undefined),
    };
    const mockConfigService = {
        get: jest.fn().mockReturnValue(''),
    };
    let reportPartnerGateGloballyEnabled = true;
    const evaluateGate = (report: unknown, hasMeaningful: (v: unknown) => boolean) =>
        evaluateReportRequiresPartnerApproval(
            report as Parameters<typeof evaluateReportRequiresPartnerApproval>[0],
            reportPartnerGateGloballyEnabled,
            hasMeaningful,
        );
    const mockReportPartnerApprovalSettings = {
        onModuleInit: jest.fn(),
        reportRequiresPartnerApproval: jest.fn().mockImplementation(async (report: unknown, hasMeaningful: (v: unknown) => boolean) =>
            evaluateGate(report, hasMeaningful),
        ),
        reportRequiresPartnerApprovalSync: jest.fn().mockImplementation((report: unknown, hasMeaningful: (v: unknown) => boolean) =>
            evaluateGate(report, hasMeaningful),
        ),
        isEnabled: jest.fn().mockResolvedValue(true),
        isEnabledCached: jest.fn().mockImplementation(() => reportPartnerGateGloballyEnabled),
    };

    beforeEach(async () => {
        jest.clearAllMocks();
        reportPartnerGateGloballyEnabled = true;

        mockParticipantRepository.findOne.mockReset();
        mockParticipantRepository.findOne.mockResolvedValue(null);
        mockParticipantRepository.find.mockReset();
        mockParticipantRepository.find.mockResolvedValue([]);

        mockOpportunityRepository.findOne.mockResolvedValue({
            id: 'opp-1',
            title: 'Test Opportunity',
            isStudentCreated: false,
            timeline: null,
        });
        mockStudentReportsRepository.findOne.mockResolvedValue(null);
        mockStudentReportsRepository.create.mockImplementation((payload: any) => payload);
        mockStudentReportsRepository.save.mockImplementation(async (report: any) => {
            if (!report.id) report.id = 'report-1';
            if (!report.verificationPublicSlug) report.verificationPublicSlug = null;
            return report;
        });
        mockUsersRepository.findOne.mockResolvedValue({ id: 'student-1', name: 'Test Student' });

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                StudentReportsService,
                { provide: getRepositoryToken(Opportunity), useValue: mockOpportunityRepository },
                { provide: getRepositoryToken(Participation), useValue: mockParticipantRepository },
                { provide: getRepositoryToken(StudentReport), useValue: mockStudentReportsRepository },
                { provide: getRepositoryToken(AttendanceLog), useValue: mockAttendanceLogsRepository },
                { provide: getRepositoryToken(User), useValue: mockUsersRepository },
                { provide: getRepositoryToken(Payment), useValue: mockPaymentRepository },
                { provide: S3Service, useValue: mockS3Service },
                { provide: EngagementService, useValue: mockEngagementService },
                { provide: MailService, useValue: mockMailService },
                { provide: ConfigService, useValue: mockConfigService },
                {
                    provide: ReportPartnerApprovalSettingsService,
                    useValue: mockReportPartnerApprovalSettings,
                },
            ],
        }).compile();

        service = module.get<StudentReportsService>(StudentReportsService);
    });

    it('keeps status as draft when no submit intent is provided', async () => {
        const result = await service.createReport(
            'student-1',
            { opportunityId: 'opp-1', section2: { problem_statement: 'test', baseline_evidence: 'Survey', discipline: 'CS' } },
            [],
            false,
        );

        expect(result.message).toBe('Report saved as draft.');
        expect(mockStudentReportsRepository.create).toHaveBeenCalledWith(
            expect.objectContaining({
                status: 'draft',
                opportunityId: 'opp-1',
            }),
        );
        expect(mockMailService.sendAdminStudentReportSubmitted).not.toHaveBeenCalled();
    });

    it('submits when forceSubmit is true (submit route behavior)', async () => {
        const result = await service.createReport(
            'student-1',
            { opportunityId: 'opp-1', section2: { problem_statement: 'test', baseline_evidence: 'Survey', discipline: 'CS' } },
            [],
            true,
        );

        expect(result.message).toBe('Report submitted successfully.');
        expect(mockStudentReportsRepository.save).toHaveBeenCalledWith(
            expect.objectContaining({
                status: 'payment_pending',
                opportunityId: 'opp-1',
                project_id: 'opp-1',
            }),
        );
        expect(mockMailService.sendAdminStudentReportSubmitted).toHaveBeenCalledTimes(1);
    });

    const SAMPLE_OPP_UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

    const TEAM_ONLY_GUARD_MESSAGE =
        'Only the team lead can edit and submit the impact report for this team project. You may update your attendance in Section 1; your team lead files the report.';

    const TEAM_SCOPE = { teamId: 'team-scope-1', applicationId: 'app-scope-1' };

    function mockCanonicalLeadRows(leadStudentId: string, createdAt = '2020-01-01T00:00:00.000Z') {
        mockParticipantRepository.find.mockImplementation((opts: { where?: Record<string, unknown> }) => {
            const w = opts?.where ?? {};
            if (
                w.projectId === SAMPLE_OPP_UUID &&
                w.participationMode === 'team' &&
                w.isTeamLead === true
            ) {
                return Promise.resolve([
                    {
                        id: 'lead-participation',
                        studentId: leadStudentId,
                        createdAt: new Date(createdAt),
                        isTeamLead: true,
                        participationMode: 'team',
                        ...TEAM_SCOPE,
                    },
                ]);
            }
            return Promise.resolve([]);
        });
    }

    function mockTeamMemberAndLeadOnProject() {
        mockOpportunityRepository.findOne.mockResolvedValue({
            id: SAMPLE_OPP_UUID,
            title: 'Team Project',
            isStudentCreated: false,
            timeline: null,
        });
        mockCanonicalLeadRows('team-lead-student');
        mockParticipantRepository.findOne.mockImplementation((opts: { where?: Record<string, unknown> }) => {
            const w = opts?.where ?? {};
            if (w.studentId === 'student-member' && w.projectId === SAMPLE_OPP_UUID) {
                return Promise.resolve({
                    participationMode: 'team',
                    isTeamLead: false,
                    studentId: w.studentId,
                    projectId: w.projectId,
                    ...TEAM_SCOPE,
                });
            }
            return Promise.resolve(null);
        });
    }

    describe('team report submit authorization', () => {
        it('blocks final submit for team members when a team lead exists on the project', async () => {
            mockTeamMemberAndLeadOnProject();

            await expect(
                service.createReport(
                    'student-member',
                    {
                        opportunityId: SAMPLE_OPP_UUID,
                        section2: { problem_statement: 'test', baseline_evidence: 'Survey', discipline: 'CS' },
                    },
                    [],
                    true,
                ),
            ).rejects.toThrow(TEAM_ONLY_GUARD_MESSAGE);
        });

        it('blocks submit when submit intent comes from body (not only forceSubmit)', async () => {
            mockTeamMemberAndLeadOnProject();

            await expect(
                service.createReport(
                    'student-member',
                    {
                        opportunityId: SAMPLE_OPP_UUID,
                        submit: true,
                        section2: { problem_statement: 'test', baseline_evidence: 'Survey', discipline: 'CS' },
                    },
                    [],
                    false,
                ),
            ).rejects.toThrow(TEAM_ONLY_GUARD_MESSAGE);
        });

        it('blocks draft save for team members when a team lead exists on the project', async () => {
            mockTeamMemberAndLeadOnProject();

            await expect(
                service.createReport(
                    'student-member',
                    {
                        opportunityId: SAMPLE_OPP_UUID,
                        section2: { problem_statement: 'test', baseline_evidence: 'Survey', discipline: 'CS' },
                    },
                    [],
                    false,
                ),
            ).rejects.toThrow(TEAM_ONLY_GUARD_MESSAGE);
        });

        it('allows team lead to submit for team participation', async () => {
            mockOpportunityRepository.findOne.mockResolvedValue({
                id: SAMPLE_OPP_UUID,
                title: 'Team Project',
                isStudentCreated: false,
                timeline: null,
            });
            mockCanonicalLeadRows('team-lead-student');
            mockParticipantRepository.findOne.mockImplementation((opts: { where?: Record<string, unknown> }) => {
                const w = opts?.where ?? {};
                if (w.studentId === 'team-lead-student' && w.projectId === SAMPLE_OPP_UUID) {
                    return Promise.resolve({
                        participationMode: 'team',
                        isTeamLead: true,
                        studentId: w.studentId,
                        projectId: w.projectId,
                        ...TEAM_SCOPE,
                    });
                }
                return Promise.resolve(null);
            });

            const result = await service.createReport(
                'team-lead-student',
                {
                    opportunityId: SAMPLE_OPP_UUID,
                    section2: { problem_statement: 'test', baseline_evidence: 'Survey', discipline: 'CS' },
                },
                [],
                true,
            );

            expect(result.message).toBe('Report submitted successfully.');
        });

        it('blocks submit for a duplicate team lead when an earlier canonical lead exists', async () => {
            mockOpportunityRepository.findOne.mockResolvedValue({
                id: SAMPLE_OPP_UUID,
                title: 'Team Project',
                isStudentCreated: false,
                timeline: null,
            });
            mockCanonicalLeadRows('hamza-lead', '2019-06-01T00:00:00.000Z');
            mockParticipantRepository.findOne.mockImplementation((opts: { where?: Record<string, unknown> }) => {
                const w = opts?.where ?? {};
                if (w.studentId === 'moeez-duplicate-lead' && w.projectId === SAMPLE_OPP_UUID) {
                    return Promise.resolve({
                        participationMode: 'team',
                        isTeamLead: true,
                        studentId: w.studentId,
                        projectId: w.projectId,
                        ...TEAM_SCOPE,
                    });
                }
                return Promise.resolve(null);
            });

            await expect(
                service.createReport(
                    'moeez-duplicate-lead',
                    {
                        opportunityId: SAMPLE_OPP_UUID,
                        section2: { problem_statement: 'test', baseline_evidence: 'Survey', discipline: 'CS' },
                    },
                    [],
                    true,
                ),
            ).rejects.toThrow(TEAM_ONLY_GUARD_MESSAGE);
        });

        it('allows team member submit when no lead row exists (legacy data)', async () => {
            mockOpportunityRepository.findOne.mockResolvedValue({
                id: SAMPLE_OPP_UUID,
                title: 'Team Project',
                isStudentCreated: false,
                timeline: null,
            });
            mockParticipantRepository.find.mockResolvedValue([]);
            mockParticipantRepository.findOne.mockImplementation((opts: { where?: Record<string, unknown> }) => {
                const w = opts?.where ?? {};
                if (w.studentId === 'legacy-member' && w.projectId === SAMPLE_OPP_UUID) {
                    return Promise.resolve({
                        participationMode: 'team',
                        isTeamLead: false,
                        studentId: w.studentId,
                        projectId: w.projectId,
                    });
                }
                return Promise.resolve(null);
            });

            const result = await service.createReport(
                'legacy-member',
                {
                    opportunityId: SAMPLE_OPP_UUID,
                    section2: { problem_statement: 'test', baseline_evidence: 'Survey', discipline: 'CS' },
                },
                [],
                true,
            );

            expect(result.message).toBe('Report submitted successfully.');
        });

        it('allows individual participation submit even when isTeamLead is false', async () => {
            mockOpportunityRepository.findOne.mockResolvedValue({
                id: SAMPLE_OPP_UUID,
                title: 'Solo Project',
                isStudentCreated: false,
                timeline: null,
            });
            mockParticipantRepository.findOne.mockImplementation((opts: { where?: Record<string, unknown> }) => {
                const w = opts?.where ?? {};
                if (w.studentId === 'solo-student' && w.projectId === SAMPLE_OPP_UUID) {
                    return Promise.resolve({
                        participationMode: 'individual',
                        isTeamLead: false,
                        studentId: w.studentId,
                        projectId: w.projectId,
                    });
                }
                return Promise.resolve(null);
            });

            const result = await service.createReport(
                'solo-student',
                {
                    opportunityId: SAMPLE_OPP_UUID,
                    section2: { problem_statement: 'test', baseline_evidence: 'Survey', discipline: 'CS' },
                },
                [],
                true,
            );

            expect(result.message).toBe('Report submitted successfully.');
        });

        it('allows submit when student has no participation row (creator / legacy)', async () => {
            mockOpportunityRepository.findOne.mockResolvedValue({
                id: SAMPLE_OPP_UUID,
                title: 'Project',
                isStudentCreated: false,
                timeline: null,
            });
            mockParticipantRepository.findOne.mockResolvedValue(null);

            const result = await service.createReport(
                'no-participation-user',
                {
                    opportunityId: SAMPLE_OPP_UUID,
                    section2: { problem_statement: 'test', baseline_evidence: 'Survey', discipline: 'CS' },
                },
                [],
                true,
            );

            expect(result.message).toBe('Report submitted successfully.');
            expect(mockParticipantRepository.findOne).toHaveBeenCalled();
        });
    });

    it('blocks partner or admin approve until reporting fee is cleared', async () => {
        const report = {
            id: 'report-1',
            status: 'payment_pending',
            partner_status: 'pending',
            admin_status: 'pending',
            studentId: 'student-1',
            opportunityId: 'opp-1',
            project_id: 'opp-1',
            opportunity: { requiresPartnerApproval: false },
        };
        mockStudentReportsRepository.findOne.mockResolvedValue(report);
        mockPaymentRepository.findOne.mockResolvedValue(null);

        await expect(service.verifyReport('report-1', 'approve', 'admin')).rejects.toThrow(
            'Reporting fee must be submitted and approved',
        );
    });

    it('marks no-partner reports verified when admin approves', async () => {
        const report = {
            id: 'report-1',
            status: 'paid',
            partner_status: 'pending',
            admin_status: 'pending',
            partnerApprovedAt: null,
            adminApprovedAt: null,
            opportunity: { requiresPartnerApproval: false },
        };
        mockStudentReportsRepository.findOne.mockResolvedValue(report);

        const result = await service.verifyReport('report-1', 'approve', 'admin');

        expect(report.status).toBe('verified');
        expect(report.admin_status).toBe('approved');
        expect(result.data.status).toBe('verified');
        expect(mockStudentReportsRepository.save).toHaveBeenCalledWith(report);
    });

    it('marks partner-required reports verified on admin approve when platform partner gate is disabled', async () => {
        reportPartnerGateGloballyEnabled = false;
        const report = {
            id: 'report-1',
            status: 'paid',
            partner_status: 'pending',
            admin_status: 'pending',
            partnerApprovedAt: null,
            adminApprovedAt: null,
            opportunity: { requiresPartnerApproval: true },
            section7: { has_partners: 'yes' },
        };
        mockStudentReportsRepository.findOne.mockResolvedValue(report);

        const result = await service.verifyReport('report-1', 'approve', 'admin');

        expect(report.status).toBe('verified');
        expect(report.partner_status).toBe('not_applicable');
        expect(result.data.status).toBe('verified');
    });

    it('keeps reports pending partner approval when that approval is required', async () => {
        const report = {
            id: 'report-1',
            status: 'paid',
            partner_status: 'pending',
            admin_status: 'pending',
            partnerApprovedAt: null,
            adminApprovedAt: null,
            opportunity: { requiresPartnerApproval: true },
        };
        mockStudentReportsRepository.findOne.mockResolvedValue(report);

        const result = await service.verifyReport('report-1', 'approve', 'admin');

        expect(report.status).toBe('paid');
        expect(report.admin_status).toBe('approved');
        expect(result.data.status).toBe('paid');
    });

    it('marks partner-required reports verified when partner approves after admin', async () => {
        const report = {
            id: 'report-1',
            status: 'paid',
            partner_status: 'pending',
            admin_status: 'approved',
            partnerApprovedAt: null,
            adminApprovedAt: new Date('2026-05-01T00:00:00.000Z'),
            opportunity: { organizationId: 'org-1', requiresPartnerApproval: true },
        };
        mockStudentReportsRepository.findOne.mockResolvedValue(report);

        const result = await service.verifyReport('report-1', 'approve', 'partner', undefined, 'org-1');

        expect(report.status).toBe('verified');
        expect(report.partner_status).toBe('approved');
        expect(result.data.status).toBe('verified');
    });

    it('sets revision status when admin rejects so students can edit', async () => {
        const report = {
            id: 'report-1',
            status: 'submitted',
            partner_status: 'pending',
            admin_status: 'pending',
            partnerApprovedAt: null,
            adminApprovedAt: new Date('2026-05-01T00:00:00.000Z'),
            opportunity: { requiresPartnerApproval: false },
        };
        mockStudentReportsRepository.findOne.mockResolvedValue(report);

        await service.verifyReport('report-1', 'reject', 'admin', 'Please fix attendance hours.');

        expect(report.status).toBe('revision');
        expect(report.admin_status).toBe('rejected');
        expect(report.admin_feedback).toBe('Please fix attendance hours.');
        expect(report.adminApprovedAt).toBeNull();
    });

    it('returns admin feedback and editable flag from checkReportStatus', async () => {
        const OPP = '582da802-e41e-488d-bd3d-d6dee59982b7';
        const report = {
            id: 'report-1',
            studentId: 'student-1',
            opportunityId: OPP,
            project_id: OPP,
            status: 'submitted',
            admin_status: 'rejected',
            partner_status: 'pending',
            admin_feedback: 'Revise Section 4 outputs.',
            section11: null,
            submission_date: new Date(),
            reportSubmittedAt: new Date(),
            partnerApprovedAt: null,
            adminApprovedAt: null,
            opportunity: { title: 'Test' },
        };
        mockParticipantRepository.findOne.mockResolvedValue(null);
        mockStudentReportsRepository.findOne.mockImplementation(async () => report);

        const result = await service.checkReportStatus('student-1', OPP);

        expect(result.data.feedback).toBe('Revise Section 4 outputs.');
        expect(result.data.is_editable).toBe(true);
        expect(result.data.status).toBe('revision');
    });

    it('persists admin-regenerated section11 AI score', async () => {
        const report = {
            id: 'report-ai-1',
            studentId: 'student-1',
            opportunityId: 'opp-1',
            project_id: 'opp-1',
            status: 'submitted',
            section11: { summary_text: 'Old summary' },
            student: { name: 'Student' },
            opportunity: { id: 'opp-1', title: 'Test' },
        };
        mockStudentReportsRepository.findOne.mockResolvedValue(report);
        mockStudentReportsRepository.save.mockImplementation(async (row) => row);

        const result = await service.updateReportAiScore('report-ai-1', {
            section11: {
                summary_text: 'New AI audit',
                is_ai_generated: true,
            },
            cii_index: { totalScore: 82, level: 'High Impact Engagement' },
        });

        expect(mockStudentReportsRepository.save).toHaveBeenCalled();
        expect((report.section11 as { ai_generated_impact_score?: number }).ai_generated_impact_score).toBe(82);
        expect(result.success).toBe(true);
    });

    it('admin findAll returns only canonical team lead report per team project', async () => {
        const opp = '582da802-e41e-488d-bd3d-d6dee59982b8';
        const leadReport = {
            id: 'report-lead',
            studentId: 'lead-student',
            opportunityId: opp,
            project_id: opp,
            status: 'submitted',
            partner_status: 'pending',
            admin_status: 'pending',
            submission_date: new Date(),
            reportSubmittedAt: new Date(),
            createdAt: new Date(),
            student: { name: 'Lead', email: 'lead@test.com' },
            opportunity: { title: 'Team Project', organizationId: 'org-1', organization: { name: 'Org' } },
            section11: null,
        };
        const memberReport = {
            ...leadReport,
            id: 'report-member',
            studentId: 'member-student',
            status: 'draft',
            student: { name: 'Member', email: 'member@test.com' },
        };

        mockStudentReportsRepository.find.mockResolvedValue([memberReport, leadReport]);
        mockParticipantRepository.find
            .mockResolvedValueOnce([
                {
                    studentId: 'lead-student',
                    projectId: opp,
                    participationMode: 'team',
                    teamId: 'TEAM-1',
                    isTeamLead: true,
                    createdAt: new Date(1),
                    id: 'p-lead',
                },
                {
                    studentId: 'member-student',
                    projectId: opp,
                    participationMode: 'team',
                    teamId: 'TEAM-1',
                    isTeamLead: false,
                    createdAt: new Date(2),
                    id: 'p-member',
                },
            ])
            .mockResolvedValueOnce([
                {
                    studentId: 'lead-student',
                    projectId: opp,
                    participationMode: 'team',
                    teamId: 'TEAM-1',
                    isTeamLead: true,
                    createdAt: new Date(1),
                    id: 'p-lead',
                },
            ]);

        const result = await service.findAll({ page: 1, limit: 50 });

        expect(result.success).toBe(true);
        expect(result.data).toHaveLength(1);
        expect(result.data[0].id).toBe('report-lead');
        expect(result.pagination.total).toBe(1);
    });
});
