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

  const oppFindOne = jest.fn();

  beforeEach(async () => {
    jest.clearAllMocks();
    oppFindOne.mockResolvedValue({
      id: 'opp-1',
      title: 'Water Project',
      isStudentCreated: true,
    });
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
            findOne: oppFindOne,
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
    mockParticipationRepo.find.mockImplementation(
      (opts?: { where?: Record<string, unknown> }) => {
        const w = opts?.where ?? {};
        if (w.studentId === 'u1' && w.projectId === 'opp-1') {
          return Promise.resolve([
            {
              id: 'p1',
              studentId: 'u1',
              projectId: 'opp-1',
              participationMode: 'team',
              isTeamLead: false,
              teamId: 'TM-1',
              teamDisplayName: 'Water · Ali Team',
              attendanceApproverType: 'faculty',
              emailVerified: true,
            },
          ]);
        }
        return Promise.resolve([
          {
            id: 'lead-1',
            fullName: 'Ali Khan',
            isTeamLead: true,
            createdAt: new Date(),
          },
        ]);
      },
    );
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

    const guide = await service.getParticipationGuide('u1', 'opp-1');
    expect(guide.your_role).toBe('team_member');
    expect(guide.participation_phase).toBe('team_member_active');
    expect(guide.recommended_action).toBe('open_my_participation');
    expect(guide.can_apply).toBe(false);
  });

  it('getMyParticipation first claims an email-only seat for the signed-in account', async () => {
    const seat = {
      id: 'p1',
      studentId: 'u1',
      projectId: 'opp-1',
      participationMode: 'team',
      isTeamLead: false,
      teamId: 'TM-1',
      attendanceApproverType: 'faculty',
      emailVerified: true,
      status: 'approved',
    };
    mockParticipationRepo.findOne.mockResolvedValue(seat);
    mockParticipationRepo.find.mockResolvedValue([seat]);
    const update = {
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    const repo = mockParticipationRepo as typeof mockParticipationRepo & {
      createQueryBuilder?: jest.Mock;
    };
    repo.createQueryBuilder = jest.fn().mockReturnValue(update);
    try {
      await service.getMyParticipation('u1', 'opp-1');
    } catch {
      // Downstream guide / report-status details are covered elsewhere; the claim must have run.
    } finally {
      delete repo.createQueryBuilder;
    }
    expect(update.set).toHaveBeenCalledWith({ studentId: 'u1' });
    expect(update.where).toHaveBeenCalledWith('student_id IS NULL');
    expect(update.andWhere).toHaveBeenCalledWith(
      expect.stringContaining('LOWER(TRIM(COALESCE(email'),
      { emailNorm: 'a@test.com' },
    );
    expect(update.execute).toHaveBeenCalledTimes(1);
    // The claim runs before the seat lookup (which reads the roster via `find`).
    const firstSeatRead = Math.min(
      ...[
        ...mockParticipationRepo.find.mock.invocationCallOrder,
        ...mockParticipationRepo.findOne.mock.invocationCallOrder,
      ],
    );
    expect(update.execute.mock.invocationCallOrder[0]).toBeLessThan(
      firstSeatRead,
    );
  });

  it('allows apply when not enrolled', async () => {
    mockParticipationRepo.findOne.mockResolvedValue(null);
    mockParticipationRepo.find.mockResolvedValue([]);
    const guide = await service.getParticipationGuide('u1', 'opp-1');
    expect(guide.can_apply).toBe(true);
    expect(guide.messages.en).toContain('Do not apply');
  });

  it('never offers Apply on a private team, and points the creator to the report', async () => {
    mockParticipationRepo.findOne.mockResolvedValue(null);
    mockParticipationRepo.find.mockResolvedValue([]);
    oppFindOne.mockResolvedValue({
      id: 'opp-1',
      title: 'Water Project',
      isStudentCreated: true,
      creatorId: 'creator-1',
      team_mode: 'private_team',
    });

    const outsider = await service.getParticipationGuide('u1', 'opp-1');
    expect(outsider.can_apply).toBe(false);
    expect(outsider.can_apply_as_team_lead).toBe(false);
    expect(outsider.recommended_action).toBe('wait_for_lead');
    expect(outsider.messages.en).toMatch(/private team/i);

    const creator = await service.getParticipationGuide('creator-1', 'opp-1');
    expect(creator.can_apply).toBe(false);
    expect(creator.recommended_action).toBe('open_own_report');
    expect(creator.messages.en).toMatch(/add your members/);
    expect(mockApps.hasOpenPipelineApplication).not.toHaveBeenCalled();
  });
});
