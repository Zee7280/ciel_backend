import { Test, TestingModule } from '@nestjs/testing';
import { EngagementService } from './engagement.service';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Participation } from './entities/participant.entity';
import { AttendanceLog } from './entities/attendance-log.entity';
import { Opportunity } from '../opportunities/entities/opportunity.entity';
import { User } from '../users/entities/user.entity';
// import { OpportunityTeamMember } from '../opportunities/entities/opportunity-team-member.entity';
import { ConfigService } from '@nestjs/config';
import { S3Service } from '../common/s3.service';
import { MailService } from '../mail/mail.service';

describe('EngagementService', () => {
    let service: EngagementService;

    const mockParticipationRepository = {
        findOne: jest.fn(),
        find: jest.fn(),
        create: jest.fn(),
        save: jest.fn(),
    };

    const mockAttendanceLogRepository = {
        create: jest.fn(),
        save: jest.fn(),
        delete: jest.fn(),
    };

    const mockOpportunityRepository = {
        findOne: jest.fn(),
    };

    const mockUserRepository = {
        findOne: jest.fn(),
        createQueryBuilder: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnThis(),
            andWhere: jest.fn().mockReturnThis(),
            getOne: jest.fn().mockResolvedValue({
                id: 'faculty-1',
                email: 'faculty@example.com',
                role: 'faculty',
                name: 'Dr. A',
            }),
        }),
    };

    // const mockTeamMemberRepository = {
    //     findOne: jest.fn(),
    // };

    const mockConfigService = {
        get: jest.fn().mockReturnValue('test-secret-key-32-chars-long-!!!'),
    };

    const mockS3Service = {
        uploadFile: jest.fn(),
    };

    const mockMailService = {
        sendFacultyInvite: jest.fn(),
        sendAttendancePendingPartnerReview: jest.fn(),
        sendAttendancePendingAdminReview: jest.fn(),
    };

    beforeEach(async () => {
        const module: TestingModule = await Test.createTestingModule({
            providers: [
                EngagementService,
                {
                    provide: getRepositoryToken(Participation),
                    useValue: mockParticipationRepository,
                },
                {
                    provide: getRepositoryToken(AttendanceLog),
                    useValue: mockAttendanceLogRepository,
                },
                {
                    provide: getRepositoryToken(Opportunity),
                    useValue: mockOpportunityRepository,
                },
                {
                    provide: getRepositoryToken(User),
                    useValue: mockUserRepository,
                },
                // {
                //     provide: getRepositoryToken(OpportunityTeamMember),
                //     useValue: mockTeamMemberRepository,
                // },
                {
                    provide: ConfigService,
                    useValue: mockConfigService,
                },
                {
                    provide: S3Service,
                    useValue: mockS3Service,
                },
                {
                    provide: MailService,
                    useValue: mockMailService,
                },
            ],
        }).compile();

        service = module.get<EngagementService>(EngagementService);
    });

    it('should be defined', () => {
        expect(service).toBeDefined();
    });

    describe('getEngagementMetrics', () => {
        it('should calculate metrics correctly', async () => {
            const mockLogs: any[] = [
                { dateOfEngagement: '2023-10-01', sessionHours: 4, evidenceUploaded: true },
                { dateOfEngagement: '2023-10-02', sessionHours: 4, evidenceUploaded: true },
                { dateOfEngagement: '2023-10-08', sessionHours: 4, evidenceUploaded: false },
            ];

            mockParticipationRepository.findOne.mockResolvedValue({
                id: 'participation-id',
                attendanceLogs: mockLogs,
            });

            const metrics = await service.getEngagementMetrics('participation-id');

            expect(metrics.totalHours).toBe(12);
            expect(metrics.activeDays).toBe(3);
            expect(metrics.spanWeeks).toBe(2);
            expect(metrics.frequency).toBe(1.5);
            expect(metrics.weeklyContinuity).toBe(100);
            expect(metrics.eis).toBeGreaterThan(0);
        });
    });

    describe('EIS Engine Logic', () => {
        it('should give 100 for perfect engagement', async () => {
            const mockLogs: any[] = [];
            for (let i = 0; i < 16; i++) {
                const date1 = new Date(2023, 0, 1 + (i * 7));
                const date2 = new Date(2023, 0, 2 + (i * 7));
                mockLogs.push({ dateOfEngagement: date1.toISOString().split('T')[0], sessionHours: 1.5, evidenceUploaded: true });
                mockLogs.push({ dateOfEngagement: date2.toISOString().split('T')[0], sessionHours: 1.5, evidenceUploaded: true });
            }

            mockParticipationRepository.findOne.mockResolvedValue({
                id: 'participation-id',
                attendanceLogs: mockLogs,
            });

            const metrics = await service.getEngagementMetrics('participation-id');
            expect(metrics.eis).toBe(100);
        });
    });

    describe('addAttendanceLog', () => {
        it('should create and save an attendance log', async () => {
            const mockParticipation = {
                id: 'p1',
                studentId: 'u1',
                projectId: 'proj1',
                status: 'approved',
                primaryFacultyEmail: 'faculty@example.com',
            };
            const dto = {
                dateOfEngagement: '2023-10-01',
                startTime: '09:00',
                endTime: '12:00',
                description: 'Valid description with fewer than 40 words.',
                organizationName: 'Org',
                activityType: 'Activity',
            } as any;

            mockParticipationRepository.findOne.mockResolvedValue(mockParticipation);
            mockOpportunityRepository.findOne.mockResolvedValue({
                id: 'proj1',
                title: 'Project',
                creatorId: 'faculty-1',
                organization: null,
            });
            mockUserRepository.findOne.mockResolvedValue({ id: 'faculty-1', role: 'faculty', name: 'Dr. A' });
            mockAttendanceLogRepository.create.mockReturnValue({ ...dto, participantId: 'p1', projectId: 'proj1', sessionHours: 3 });
            mockAttendanceLogRepository.save.mockResolvedValue({ id: 'log1', ...dto });

            const result = await service.addAttendanceLog('u1', 'p1', dto);

            expect(result).toBeDefined();
            expect(mockAttendanceLogRepository.create).toHaveBeenCalledWith(expect.objectContaining({
                participantId: 'p1',
                projectId: 'proj1',
                sessionHours: 3,
                approvalStatus: 'pending',
                assignedApproverType: 'faculty',
            }));
            expect(mockAttendanceLogRepository.save).toHaveBeenCalled();
        });

        it('should throw error if session exceeds 12 hours', async () => {
            const mockParticipation = { id: 'p1', studentId: 'u1', status: 'approved' };
            const dto = {
                dateOfEngagement: '2023-10-01',
                startTime: '08:00',
                endTime: '21:00',
                description: 'Desc',
            } as any;

            mockParticipationRepository.findOne.mockResolvedValue(mockParticipation);

            await expect(service.addAttendanceLog('u1', 'p1', dto)).rejects.toThrow('Daily attendance cannot exceed 12 hours');
        });

        it('should throw error if participation is not approved', async () => {
            const mockParticipation = { id: 'p1', studentId: 'u1', status: 'pending_ciel_approval' };
            const dto = {
                dateOfEngagement: '2023-10-01',
                startTime: '09:00',
                endTime: '10:00',
                description: 'Desc',
            } as any;

            mockParticipationRepository.findOne.mockResolvedValue(mockParticipation);

            await expect(service.addAttendanceLog('u1', 'p1', dto)).rejects.toThrow('Attendance logging is only allowed for approved/verified records');
        });
    });
    describe('registerParticipant', () => {
        it('should create a NEW record if the email is different, even for same studentId', async () => {
            const studentId = 'u1';
            const projectId = 'proj1';
            const dto = {
                projectId,
                email: 'new@example.com',
                fullName: 'Fatima',
                cnic: '1234567890123',
                mobile: '03001234567',
            } as any;

            const mockOpportunity = { id: projectId, title: 'Project 1', status: 'active', admin_approved: true };
            
            // Mock transaction manager
            const mockManager = {
                findOne: jest.fn()
                    .mockResolvedValueOnce(null) // User by email
                    .mockResolvedValueOnce(mockOpportunity) // Opportunity
                    .mockResolvedValueOnce(null) // existingByCnic
                    .mockResolvedValueOnce(null), // existingByTarget (email)
                create: jest.fn().mockReturnValue({}),
                save: jest.fn().mockImplementation((entity, data) => ({ id: 'new-id', ...data })),
            };

            (mockParticipationRepository as any).manager = {
                transaction: jest.fn().mockImplementation((cb) => cb(mockManager)),
            };

            const result = await service.registerParticipant(studentId, dto);

            expect(result).toBeDefined();
            expect(mockManager.create).toHaveBeenCalled();
            expect(mockManager.save).toHaveBeenCalled();
        });

        it('should OVERRIDE if the email matches', async () => {
            const studentId = 'u1';
            const projectId = 'proj1';
            const dto = {
                projectId,
                email: 'existing@example.com',
                fullName: 'Fatima Updated',
                cnic: '1234567890123',
                mobile: '03001234567',
            } as any;

            const mockOpportunity = { id: projectId, title: 'Project 1', status: 'active', admin_approved: true };
            const existingParticipation = { id: 'old-id', email: 'existing@example.com' };

            // Mock transaction manager
            const mockManager = {
                findOne: jest.fn()
                    .mockResolvedValueOnce(null) // User by email
                    .mockResolvedValueOnce(mockOpportunity) // Opportunity
                    .mockResolvedValueOnce(null) // existingByCnic
                    .mockResolvedValueOnce(existingParticipation), // existingByTarget (email found!)
                create: jest.fn(),
                save: jest.fn().mockImplementation((entity, data) => ({ ...data })),
            };

            (mockParticipationRepository as any).manager = {
                transaction: jest.fn().mockImplementation((cb) => cb(mockManager)),
            };

            const result = await service.registerParticipant(studentId, dto);

            expect(result).toBeDefined();
            expect(mockManager.create).not.toHaveBeenCalled();
            expect(mockManager.save).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
                fullName: 'Fatima Updated'
            }));
        });
    });
});
