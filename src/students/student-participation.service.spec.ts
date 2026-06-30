import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { StudentParticipationService } from './student-participation.service';
import { Participation } from '../engagement/entities/participant.entity';
import { Opportunity } from '../opportunities/entities/opportunity.entity';
import { User } from '../users/entities/user.entity';
import { StudentReport } from '../reports/entities/student-report.entity';
import { AttendanceLog } from '../engagement/entities/attendance-log.entity';
import { OpportunityApplicationsService } from '../opportunities/opportunity-applications.service';

describe('StudentParticipationService', () => {
  let service: StudentParticipationService;

  const mockParticipationRepo = {
    findOne: jest.fn(),
    find: jest.fn(),
  };

  const mockApps = {
    hasOpenPipelineApplication: jest.fn().mockResolvedValue(false),
    collectClaimedEmailsOnOpenApplications: jest
      .fn()
      .mockResolvedValue(new Set()),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StudentParticipationService,
        {
          provide: getRepositoryToken(Participation),
          useValue: mockParticipationRepo,
        },
        {
          provide: getRepositoryToken(Opportunity),
          useValue: {
            findOne: jest.fn().mockResolvedValue({
              id: 'opp-1',
              title: 'Water Project',
              isStudentCreated: true,
            }),
          },
        },
        {
          provide: getRepositoryToken(User),
          useValue: {
            findOne: jest
              .fn()
              .mockResolvedValue({ id: 'u1', email: 'a@test.com' }),
          },
        },
        {
          provide: getRepositoryToken(StudentReport),
          useValue: { findOne: jest.fn() },
        },
        {
          provide: getRepositoryToken(AttendanceLog),
          useValue: { find: jest.fn().mockResolvedValue([]) },
        },
        { provide: OpportunityApplicationsService, useValue: mockApps },
      ],
    }).compile();
    service = module.get(StudentParticipationService);
  });

  it('guides team member to my participation', async () => {
    mockParticipationRepo.findOne.mockResolvedValue({
      id: 'p1',
      studentId: 'u1',
      projectId: 'opp-1',
      participationMode: 'team',
      isTeamLead: false,
      teamId: 'TM-1',
      teamDisplayName: 'Water · Ali Team',
      attendanceApproverType: 'faculty',
      emailVerified: true,
    });
    mockParticipationRepo.find.mockResolvedValue([
      {
        id: 'lead-1',
        fullName: 'Ali Khan',
        isTeamLead: true,
        createdAt: new Date(),
      },
    ]);

    const guide = await service.getParticipationGuide('u1', 'opp-1');
    expect(guide.your_role).toBe('team_member');
    expect(guide.participation_phase).toBe('team_member_active');
    expect(guide.recommended_action).toBe('open_my_participation');
    expect(guide.can_apply).toBe(false);
  });

  it('allows apply when not enrolled', async () => {
    mockParticipationRepo.findOne.mockResolvedValue(null);
    const guide = await service.getParticipationGuide('u1', 'opp-1');
    expect(guide.can_apply).toBe(true);
    expect(guide.messages.en).toContain('Do not apply');
  });
});
