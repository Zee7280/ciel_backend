import { Test, TestingModule } from '@nestjs/testing';
import { EngagementService } from './engagement.service';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Participant } from './entities/participant.entity';
import { AttendanceLog } from './entities/attendance-log.entity';
import { Opportunity } from '../opportunities/entities/opportunity.entity';
import { ConfigService } from '@nestjs/config';

describe('EngagementService', () => {
    let service: EngagementService;

    const mockParticipantRepository = {
        findOne: jest.fn(),
        find: jest.fn(),
        create: jest.fn(),
        save: jest.fn(),
    };

    const mockAttendanceLogRepository = {
        create: jest.fn(),
        save: jest.fn(),
    };

    const mockOpportunityRepository = {
        findOne: jest.fn(),
    };

    const mockConfigService = {
        get: jest.fn().mockReturnValue('test-secret-key-32-chars-long-!!!'),
    };

    beforeEach(async () => {
        const module: TestingModule = await Test.createTestingModule({
            providers: [
                EngagementService,
                {
                    provide: getRepositoryToken(Participant),
                    useValue: mockParticipantRepository,
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
                    provide: ConfigService,
                    useValue: mockConfigService,
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

            mockParticipantRepository.findOne.mockResolvedValue({
                id: 'participant-id',
                attendanceLogs: mockLogs,
            });

            const metrics = await service.getEngagementMetrics('participant-id');

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
                mockLogs.push({ dateOfEngagement: date1.toISOString().split('T')[0], sessionHours: 1.25, evidenceUploaded: true });
                mockLogs.push({ dateOfEngagement: date2.toISOString().split('T')[0], sessionHours: 1.25, evidenceUploaded: true });
            }

            mockParticipantRepository.findOne.mockResolvedValue({
                id: 'participant-id',
                attendanceLogs: mockLogs,
            });

            const metrics = await service.getEngagementMetrics('participant-id');
            expect(metrics.eis).toBe(100);
        });
    });

    describe('addAttendanceLog', () => {
        it('should create and save an attendance log', async () => {
            const mockParticipant = {
                id: 'p1',
                userId: 'u1',
                projectId: 'proj1',
            };
            const dto = {
                dateOfEngagement: '2023-10-01',
                startTime: '09:00',
                endTime: '12:00',
                description: 'Valid description with fewer than 40 words.',
                organizationName: 'Org',
                activityType: 'Activity',
            } as any;

            mockParticipantRepository.findOne.mockResolvedValue(mockParticipant);
            mockAttendanceLogRepository.create.mockReturnValue({ ...dto, participantId: 'p1', projectId: 'proj1', sessionHours: 3 });
            mockAttendanceLogRepository.save.mockResolvedValue({ id: 'log1', ...dto });

            const result = await service.addAttendanceLog('u1', 'p1', dto);

            expect(result).toBeDefined();
            expect(mockAttendanceLogRepository.create).toHaveBeenCalledWith(expect.objectContaining({
                participantId: 'p1',
                projectId: 'proj1',
                sessionHours: 3,
            }));
            expect(mockAttendanceLogRepository.save).toHaveBeenCalled();
        });

        it('should throw error if session exceeds 12 hours', async () => {
            const mockParticipant = { id: 'p1', userId: 'u1' };
            const dto = {
                dateOfEngagement: '2023-10-01',
                startTime: '08:00',
                endTime: '21:00',
                description: 'Desc',
            } as any;

            mockParticipantRepository.findOne.mockResolvedValue(mockParticipant);

            await expect(service.addAttendanceLog('u1', 'p1', dto)).rejects.toThrow('Daily attendance cannot exceed 12 hours');
        });
    });
});
