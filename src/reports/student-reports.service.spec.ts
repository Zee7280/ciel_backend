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

describe('StudentReportsService', () => {
    let service: StudentReportsService;

    const mockOpportunityRepository = {
        findOne: jest.fn(),
    };
    const mockParticipantRepository = {};
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

    beforeEach(async () => {
        jest.clearAllMocks();

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
