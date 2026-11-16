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
  let mailService: {
    sendTeamMemberAddedToProject: jest.Mock;
    sendTeamRosterChanged: jest.Mock;
  };
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
    count: jest.fn().mockResolvedValue(1),
    manager: {
      transaction: jest.fn(
        async (
          cb: (em: {
            getRepository: (e: unknown) => unknown;
          }) => Promise<unknown>,
        ) => {
          const participationRepo = {
            findOne: jest.fn().mockResolvedValue({ ...leadRow }),
            save: jest.fn((row: Record<string, unknown>) =>
              Promise.resolve(row),
            ),
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
          return await cb({
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
      sendTeamRosterChanged: jest.fn().mockResolvedValue(undefined),
    };
    notificationsService = {
      createNotification: jest.fn().mockResolvedValue(undefined),
    };
    mockParticipationRepo.findOne.mockResolvedValue({
      ...leadRow,
      student: { name: 'Ali Hassan' },
    });
    mockParticipationRepo.find.mockImplementation(
      (opts: { where?: { id?: unknown } }) => {
        if (opts?.where && (opts.where as { id?: unknown }).id) {
          return Promise.resolve([{ ...memberRow }]);
        }
        return Promise.resolve([{ ...leadRow }, { ...memberRow }]);
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

  describe('guards', () => {
    it('a plain member of another team cannot form / take over a team', async () => {
      mockParticipationRepo.findOne.mockResolvedValue({
        ...leadRow,
        teamId: 'TM-OTHER',
        isTeamLead: false,
        participationMode: 'team',
        student: { name: 'Member' },
      });
      await expect(
        service.formTeamFromLead('student-lead', 'proj-1', ['mem-1']),
      ).rejects.toThrow(/Only the team lead/);
    });

    it("cannot poach a student who is in another team, or another team's lead", async () => {
      for (const taken of [
        { ...memberRow, teamId: 'TM-OTHER' },
        { ...memberRow, isTeamLead: true, teamId: 'TM-OTHER' },
        { ...memberRow, isTeamLead: true, teamId: null },
      ]) {
        mockParticipationRepo.find.mockImplementation(
          (opts: { where?: { id?: unknown } }) =>
            Promise.resolve(
              opts?.where && (opts.where as { id?: unknown }).id
                ? [taken]
                : [{ ...leadRow }, taken],
            ),
        );
        await expect(
          service.formTeamFromLead('student-lead', 'proj-1', ['mem-1']),
        ).rejects.toThrow(/already belong to another team/);
      }
    });

    it('can still add a free student and an existing member of the SAME team', async () => {
      mockParticipationRepo.findOne.mockResolvedValue({
        ...leadRow,
        teamId: 'TM-MINE',
        isTeamLead: true,
        participationMode: 'team',
        student: { name: 'Lead' },
      });
      mockParticipationRepo.find.mockImplementation(
        (opts: { where?: { id?: unknown } }) =>
          Promise.resolve(
            opts?.where && (opts.where as { id?: unknown }).id
              ? [{ ...memberRow, teamId: 'TM-MINE' }]
              : [{ ...leadRow }],
          ),
      );
      await expect(
        service.formTeamFromLead('student-lead', 'proj-1', ['mem-1']),
      ).resolves.toMatchObject({ formed: true });
      expect(mailService.sendTeamMemberAddedToProject).not.toHaveBeenCalled();
    });

    it('emails a member only the first time they join the team', async () => {
      mockParticipationRepo.findOne.mockResolvedValue({
        ...leadRow,
        teamId: 'TM-MINE',
        isTeamLead: true,
        participationMode: 'team',
        student: { name: 'Lead' },
      });
      mockParticipationRepo.find.mockImplementation(
        (opts: { where?: { id?: unknown } }) =>
          Promise.resolve(
            opts?.where && (opts.where as { id?: unknown }).id
              ? [{ ...memberRow, teamId: null }]
              : [{ ...leadRow }],
          ),
      );
      await service.formTeamFromLead('student-lead', 'proj-1', ['mem-1']);
      expect(mailService.sendTeamMemberAddedToProject).toHaveBeenCalledTimes(1);
    });

    it('respects the opportunity seat count and the platform maximum of 20', async () => {
      mockOpportunityRepo.findOne.mockResolvedValueOnce({
        id: 'proj-1',
        title: 'T',
        timeline: { volunteers_required: 2 },
      });
      const many = Array.from({ length: 3 }, (_, i) => ({
        ...memberRow,
        id: `m${i}`,
      }));
      mockParticipationRepo.find.mockImplementation(
        (opts: { where?: { id?: unknown } }) =>
          Promise.resolve(
            opts?.where && (opts.where as { id?: unknown }).id
              ? many
              : [{ ...leadRow }],
          ),
      );
      await expect(
        service.formTeamFromLead('student-lead', 'proj-1', ['m0', 'm1', 'm2']),
      ).rejects.toThrow(/seat/);

      mockOpportunityRepo.findOne.mockResolvedValueOnce({
        id: 'proj-1',
        title: 'T',
      });
      const twenty = Array.from({ length: 20 }, (_, i) => ({
        ...memberRow,
        id: `m${i}`,
      }));
      mockParticipationRepo.find.mockImplementation(
        (opts: { where?: { id?: unknown } }) =>
          Promise.resolve(
            opts?.where && (opts.where as { id?: unknown }).id
              ? twenty
              : [{ ...leadRow }],
          ),
      );
      await expect(
        service.formTeamFromLead(
          'student-lead',
          'proj-1',
          twenty.map((m) => m.id),
        ),
      ).rejects.toThrow(/at most 20/);
    });
  });

  describe('one-time roster notices', () => {
    const existingMember = {
      id: 'old-1',
      studentId: 'student-old',
      projectId: 'proj-1',
      participationMode: 'team',
      isTeamLead: false,
      teamId: 'TM-MINE',
      status: 'approved',
      email: 'old@test.edu',
      student: { name: 'Omar Old', email: 'old@test.edu' },
    };

    it('tells everyone already on the team who joined; the newcomer only gets the "added" mail', async () => {
      mockParticipationRepo.findOne.mockResolvedValue({
        ...leadRow,
        teamId: 'TM-MINE',
        isTeamLead: true,
        participationMode: 'team',
        email: 'lead@test.edu',
        student: { name: 'Ali Hassan', email: 'lead@test.edu' },
      });
      mockParticipationRepo.find.mockImplementation(
        (opts: { where?: { id?: unknown; teamId?: unknown } }) => {
          if (opts?.where && (opts.where as { id?: unknown }).id) {
            return Promise.resolve([{ ...memberRow, teamId: null }]);
          }
          return Promise.resolve([
            {
              ...leadRow,
              teamId: 'TM-MINE',
              isTeamLead: true,
              email: 'lead@test.edu',
              student: { name: 'Ali Hassan', email: 'lead@test.edu' },
            },
            { ...existingMember },
            { ...memberRow, teamId: 'TM-MINE' },
          ]);
        },
      );

      await service.formTeamFromLead('student-lead', 'proj-1', ['mem-1']);

      const rosterTo = mailService.sendTeamRosterChanged.mock.calls.map(
        (c: [{ to: string; added: string[] }]) => c[0].to,
      );
      expect(rosterTo.sort()).toEqual(['lead@test.edu', 'old@test.edu']);
      expect(mailService.sendTeamRosterChanged).toHaveBeenCalledWith(
        expect.objectContaining({ added: ['Sara Khan'], removed: [] }),
      );
      expect(rosterTo).not.toContain('member@test.edu');
      expect(mailService.sendTeamMemberAddedToProject).toHaveBeenCalledTimes(1);
      expect(notificationsService.createNotification).toHaveBeenCalledWith(
        'student-old',
        expect.objectContaining({ title: 'Your project team changed' }),
      );
    });

    it('a lead removing a member: the rest of the team hears it, the person gets their own notice', async () => {
      mockParticipationRepo.find.mockResolvedValue([
        {
          ...leadRow,
          teamId: 'TM-MINE',
          email: 'lead@test.edu',
          student: { name: 'Ali', email: 'lead@test.edu' },
        },
        { ...existingMember },
      ]);
      const out = await service.notifyTeamRosterChange({
        projectId: 'proj-1',
        teamId: 'TM-MINE',
        leadName: 'Ali Hassan',
        added: [],
        removed: [
          {
            name: 'Sara Khan',
            email: 'member@test.edu',
            studentId: 'student-mem',
          },
        ],
      });
      expect(out.notified).toBe(3);
      expect(mailService.sendTeamRosterChanged).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'old@test.edu',
          removed: ['Sara Khan'],
          added: [],
        }),
      );
      expect(mailService.sendTeamRosterChanged).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'member@test.edu',
          youWereRemoved: true,
        }),
      );
      expect(notificationsService.createNotification).toHaveBeenCalledWith(
        'student-mem',
        expect.objectContaining({
          title: 'You were removed from a project team',
        }),
      );
    });

    it('a member leaving by themselves gets no "removed" mail; nothing goes out without a change', async () => {
      mockParticipationRepo.find.mockResolvedValue([{ ...existingMember }]);
      await service.notifyTeamRosterChange({
        projectId: 'proj-1',
        teamId: 'TM-MINE',
        leadName: 'Sara Khan',
        added: [],
        removed: [
          {
            name: 'Sara Khan',
            email: 'member@test.edu',
            studentId: 'student-mem',
            self: true,
          },
        ],
      });
      const to = mailService.sendTeamRosterChanged.mock.calls.map(
        (c: [{ to: string }]) => c[0].to,
      );
      expect(to).toEqual(['old@test.edu']);
      mailService.sendTeamRosterChanged.mockClear();
      const none = await service.notifyTeamRosterChange({
        projectId: 'proj-1',
        teamId: 'TM-MINE',
        leadName: 'x',
        added: [],
        removed: [],
      });
      expect(none.notified).toBe(0);
      expect(mailService.sendTeamRosterChanged).not.toHaveBeenCalled();
    });
  });
});
