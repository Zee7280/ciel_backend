import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { TeamFormationService } from './team-formation.service';
import { Participation } from './entities/participant.entity';
import { Opportunity } from '../opportunities/entities/opportunity.entity';
import { StudentReport } from '../reports/entities/student-report.entity';
import { MailService } from '../mail/mail.service';
import { NotificationsService } from '../notifications/notifications.service';

describe('TeamFormationService', () => {
  let service: TeamFormationService;
  let mailService: { sendTeamMemberAddedToProject: jest.Mock };
  let notificationsService: { createNotification: jest.Mock };

  const leadRow = {
    id: 'lead-1',
    studentId: 'student-lead',
    projectId: 'proj-1',
    participationMode: 'individual',
    isTeamLead: false,
    teamId: null,
    applicationId: 'app-1',
    attendanceApproverType: 'faculty',
    primaryFacultyEmail: 'faculty@test.edu',
    secondaryFacultyEmail: null,
    fullName: 'Ali Hassan',
    formationSource: null,
    teamDisplayName: null,
    status: 'approved',
  };

  const memberRow = {
    id: 'mem-1',
    studentId: 'student-mem',
    projectId: 'proj-1',
    participationMode: 'team',
    isTeamLead: false,
    teamId: null,
    status: 'approved',
    email: 'member@test.edu',
    student: { name: 'Sara Khan', email: 'member@test.edu' },
  };

  const mockParticipationRepo = {
    findOne: jest.fn(),
    find: jest.fn(),
    manager: {
      transaction: jest.fn(
        async (
          cb: (em: { getRepository: (e: unknown) => unknown }) => unknown,
        ) => {
          const participationRepo = {
            findOne: jest.fn().mockResolvedValue({ ...leadRow }),
            save: jest.fn(async (row: Record<string, unknown>) => row),
            createQueryBuilder: jest.fn(() => ({
              where: jest.fn().mockReturnThis(),
              andWhere: jest.fn().mockReturnThis(),
              getMany: jest.fn().mockResolvedValue([]),
            })),
          };
          const reportRepo = {
            createQueryBuilder: jest.fn(() => ({
              where: jest.fn().mockReturnThis(),
              andWhere: jest.fn().mockReturnThis(),
              getMany: jest.fn().mockResolvedValue([]),
            })),
            remove: jest.fn(),
          };
          return cb({
            getRepository: (entity: unknown) =>
              entity === StudentReport ? reportRepo : participationRepo,
          });
        },
      ),
    },
  };

  const mockOpportunityRepo = {
    findOne: jest
      .fn()
      .mockResolvedValue({ id: 'proj-1', title: 'Clean Water' }),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    mailService = {
      sendTeamMemberAddedToProject: jest.fn().mockResolvedValue(undefined),
    };
    notificationsService = {
      createNotification: jest.fn().mockResolvedValue(undefined),
    };
    mockParticipationRepo.findOne.mockResolvedValue({
      ...leadRow,
      student: { name: 'Ali Hassan' },
    });
    mockParticipationRepo.find.mockImplementation(
      async (opts: { where?: { id?: unknown } }) => {
        if (opts?.where && (opts.where as { id?: unknown }).id) {
          return [{ ...memberRow }];
        }
        return [{ ...leadRow }, { ...memberRow }];
      },
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TeamFormationService,
        {
          provide: getRepositoryToken(Participation),
          useValue: mockParticipationRepo,
        },
        {
          provide: getRepositoryToken(Opportunity),
          useValue: mockOpportunityRepo,
        },
        { provide: getRepositoryToken(StudentReport), useValue: {} },
        { provide: MailService, useValue: mailService },
        { provide: NotificationsService, useValue: notificationsService },
      ],
    }).compile();

    service = module.get(TeamFormationService);
  });

  it('forms team from individual lead with verified member', async () => {
    const result = await service.formTeamFromLead('student-lead', 'proj-1', [
      'mem-1',
    ]);
    expect(result.formed).toBe(true);
    expect(result.team_id).toMatch(/^TM-/);
    expect(result.team_display_name).toContain('Clean Water');
    expect(mailService.sendTeamMemberAddedToProject).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'member@test.edu',
        projectId: 'proj-1',
      }),
    );
    expect(notificationsService.createNotification).toHaveBeenCalledWith(
      'student-mem',
      expect.objectContaining({ type: 'team' }),
    );
  });

  it('returns formed false when no members on individual lead', async () => {
    const result = await service.formTeamFromLead('student-lead', 'proj-1', []);
    expect(result.formed).toBe(false);
  });
});
