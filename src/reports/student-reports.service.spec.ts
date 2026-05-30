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
    };
    const mockStudentReportsRepository = {
        findOne: jest.fn(),
        create: jest.fn(),
        save: jest.fn(),
    };
    const mockAttendanceLogsRepository = {};
    const mockUsersRepository = {
        findOne: jest.fn(),
    };
    const mockPaymentRepository = {};
    const mockS3Service = {
        uploadFile: jest.fn(),
    };
    const mockEngagementService = {};
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
        expect(mockStudentReportsRepository.create).toHaveBeenCalledWith(
            expect.objectContaining({
                status: 'submitted',
                opportunityId: 'opp-1',
            }),
        );
        expect(mockMailService.sendAdminStudentReportSubmitted).toHaveBeenCalledTimes(1);
    });

    const SAMPLE_OPP_UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

    const TEAM_ONLY_GUARD_MESSAGE =
        'Only the team lead can submit the impact report for this team project. Your team lead should submit on behalf of the team.';

    function mockTeamMemberAndLeadOnProject() {
        mockOpportunityRepository.findOne.mockResolvedValue({
            id: SAMPLE_OPP_UUID,
            title: 'Team Project',
            isStudentCreated: false,
            timeline: null,
        });
        mockParticipantRepository.findOne.mockImplementation((opts: { where?: Record<string, unknown> }) => {
            const w = opts?.where ?? {};
            if (w.studentId === 'student-member' && w.projectId === SAMPLE_OPP_UUID) {
                return Promise.resolve({
                    participationMode: 'team',
                    isTeamLead: false,
                    studentId: w.studentId,
                    projectId: w.projectId,
                });
            }
            if (
                w.projectId === SAMPLE_OPP_UUID &&
                w.participationMode === 'team' &&
                w.isTeamLead === true
            ) {
                return Promise.resolve({ id: 'lead-participation' });
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

        it('does not block draft saves for team members when a lead exists', async () => {
            mockTeamMemberAndLeadOnProject();

            const result = await service.createReport(
                'student-member',
                {
                    opportunityId: SAMPLE_OPP_UUID,
                    section2: { problem_statement: 'test', baseline_evidence: 'Survey', discipline: 'CS' },
                },
                [],
                false,
            );

            expect(result.message).toBe('Report saved as draft.');
            expect(mockParticipantRepository.findOne).not.toHaveBeenCalled();
        });

        it('allows team lead to submit for team participation', async () => {
            mockOpportunityRepository.findOne.mockResolvedValue({
                id: SAMPLE_OPP_UUID,
                title: 'Team Project',
                isStudentCreated: false,
                timeline: null,
            });
            mockParticipantRepository.findOne.mockImplementation((opts: { where?: Record<string, unknown> }) => {
                const w = opts?.where ?? {};
                if (w.studentId === 'team-lead-student' && w.projectId === SAMPLE_OPP_UUID) {
                    return Promise.resolve({
                        participationMode: 'team',
                        isTeamLead: true,
                        studentId: w.studentId,
                        projectId: w.projectId,
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
            expect(mockParticipantRepository.findOne).toHaveBeenCalledTimes(1);
        });

        it('allows team member submit when no lead row exists (legacy data)', async () => {
            mockOpportunityRepository.findOne.mockResolvedValue({
                id: SAMPLE_OPP_UUID,
                title: 'Team Project',
                isStudentCreated: false,
                timeline: null,
            });
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
                if (
                    w.projectId === SAMPLE_OPP_UUID &&
                    w.participationMode === 'team' &&
                    w.isTeamLead === true
                ) {
                    return Promise.resolve(null);
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

    it('marks no-partner reports verified when admin approves', async () => {
        const report = {
            id: 'report-1',
            status: 'submitted',
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
            status: 'submitted',
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
            status: 'submitted',
            partner_status: 'pending',
            admin_status: 'pending',
            partnerApprovedAt: null,
            adminApprovedAt: null,
            opportunity: { requiresPartnerApproval: true },
        };
        mockStudentReportsRepository.findOne.mockResolvedValue(report);

        const result = await service.verifyReport('report-1', 'approve', 'admin');

        expect(report.status).toBe('submitted');
        expect(report.admin_status).toBe('approved');
        expect(result.data.status).toBe('submitted');
    });

    it('marks partner-required reports verified when partner approves after admin', async () => {
        const report = {
            id: 'report-1',
            status: 'submitted',
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
});
