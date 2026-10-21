import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import type { Repository } from 'typeorm';
import type { AiService } from '../ai/ai.service';
import type { MailService } from '../mail/mail.service';
import type { NotificationsService } from '../notifications/notifications.service';
import type { Organization } from '../organizations/entities/organization.entity';
import type { User } from '../users/entities/user.entity';
import type { CourseProjectEntry } from './entities/course-project-entry.entity';
import type { FypEntry } from './entities/fyp-entry.entity';
import type { PathGraderRun } from './entities/path-grader-run.entity';
import type { TeamMemberInvite } from './entities/team-member-invite.entity';
import type { VentureEntry } from './entities/venture-entry.entity';
import { PathsService } from './paths.service';

/** Builds the service from hand-rolled stand-ins — each test supplies only the members it exercises,
 * so every dependency is accepted as `unknown` and cast once, here, to its injected type. */
function createService(
  courseProjectRepo: unknown,
  fypRepo: unknown,
  ventureRepo: unknown,
  teamMemberInviteRepo: unknown,
  usersRepo: unknown,
  organizationsRepo: unknown,
  mailService: unknown,
  notificationsService: unknown,
  graderRunRepo: unknown,
  aiService: unknown,
): PathsService {
  return new PathsService(
    courseProjectRepo as Repository<CourseProjectEntry>,
    fypRepo as Repository<FypEntry>,
    ventureRepo as Repository<VentureEntry>,
    teamMemberInviteRepo as Repository<TeamMemberInvite>,
    usersRepo as Repository<User>,
    organizationsRepo as Repository<Organization>,
    mailService as MailService,
    notificationsService as NotificationsService,
    graderRunRepo as Repository<PathGraderRun>,
    aiService as AiService,
  );
}

/** Private members the tests reach into directly. */
type PathsServiceInternals = {
  syncTeamInvites: (
    kind: 'course_project' | 'fyp' | 'venture',
    entryId: string,
    invitedByUserId: string,
    inviterName: string,
    kindLabel: string,
    title: string,
    members: unknown[] | undefined | null,
  ) => Promise<void>;
  usersRepo: unknown;
};
const internals = (service: PathsService) =>
  service as unknown as PathsServiceInternals;

type MeritModelUser = Parameters<
  PathsService['notifyCourseProjectMeritRanks']
>[0];
type CourseworkMeritModel = Awaited<
  ReturnType<PathsService['getCourseProjectMeritModel']>
>;
type FypMeritModel = Awaited<ReturnType<PathsService['getFypMeritModel']>>;
type VentureMeritModel = Awaited<
  ReturnType<PathsService['getVentureMeritModel']>
>;
type UniversityVentures = Awaited<
  ReturnType<PathsService['listVenturesForUniversity']>
>;

/** `expect.objectContaining` is typed `any`; wrapping it keeps nested matchers out of `any`-land. */
const containing = (obj: Record<string, unknown>): unknown =>
  expect.objectContaining(obj);

/** Minimal chainable query-builder stand-in. */
type FakeQueryBuilder = {
  where: jest.Mock;
  andWhere: jest.Mock;
  orWhere: jest.Mock;
  orderBy: jest.Mock;
  getMany: jest.Mock;
  getOne: jest.Mock;
};

/** View of a persisted fixture row for assertions on its nested jsonb columns. */
type SavedRow = {
  status: string;
  facultyModeration: unknown;
  meritRibbon: unknown;
  reviewPipeline: { supervisorStatus: string };
  publishSettings: { acceptIntros: boolean };
  academicSetup: { supervisorEmail: string; supervisorName: string };
};

function matchesWhere(
  row: Record<string, unknown>,
  where: Record<string, unknown>,
) {
  return Object.entries(where).every(([k, v]) => row[k] === v);
}

function makeInviteRepo() {
  const rows: Array<Record<string, unknown>> = [];
  let nextId = 1;
  return {
    rows,
    create: jest.fn((data: Record<string, unknown>) => ({ ...data })),
    save: jest.fn((row: Record<string, unknown>) => {
      if (!row.id) {
        row.id = `invite-${nextId++}`;
        rows.push(row);
        return Promise.resolve(row);
      }
      const idx = rows.findIndex((r) => r.id === row.id);
      if (idx === -1) rows.push(row);
      else rows[idx] = row;
      return Promise.resolve(row);
    }),
    find: jest.fn((opts: { where?: Record<string, unknown> } = {}) =>
      Promise.resolve(rows.filter((r) => matchesWhere(r, opts.where ?? {}))),
    ),
    findOne: jest.fn((opts: { where?: Record<string, unknown> } = {}) =>
      Promise.resolve(
        rows.find((r) => matchesWhere(r, opts.where ?? {})) ?? null,
      ),
    ),
  };
}

describe('PathsService — team member invites', () => {
  const makeService = (
    overrides: { inviteRepo?: ReturnType<typeof makeInviteRepo> } = {},
  ) => {
    const inviteRepo = overrides.inviteRepo ?? makeInviteRepo();
    const mailService = {
      sendPathTeamInvite: jest.fn().mockResolvedValue(undefined),
    };
    const notificationsService = {
      createNotification: jest.fn().mockResolvedValue(undefined),
    };
    const courseProjectRepo = {
      findOne: jest.fn().mockResolvedValue({
        id: 'entry-1',
        projectTitle: 'My Report',
        course: null,
      }),
      save: jest.fn((row: Record<string, unknown>) => Promise.resolve(row)),
    };
    const fypRepo = { findOne: jest.fn().mockResolvedValue(null) };
    const ventureRepo = { findOne: jest.fn().mockResolvedValue(null) };
    const usersRepo = {
      findOne: jest.fn().mockResolvedValue({ name: 'Ada Lovelace' }),
    };
    const organizationsRepo = {};

    const service = createService(
      courseProjectRepo,
      fypRepo,
      ventureRepo,
      inviteRepo,
      usersRepo,
      organizationsRepo,
      mailService,
      notificationsService,
      {},
      {},
    );
    return {
      service,
      inviteRepo,
      mailService,
      courseProjectRepo,
      notificationsService,
    };
  };

  it('creates exactly one invite for a set of member emails, deduped case/whitespace-insensitively, and skips members with no email', async () => {
    const { service, inviteRepo, mailService } = makeService();

    await internals(service).syncTeamInvites(
      'course_project',
      'entry-1',
      'user-1',
      'Ada',
      'Course Project',
      'My Report',
      [
        { name: 'Bob', email: 'Bob@Test.com ' },
        { name: 'Bob duplicate', email: ' bob@test.com' },
        { name: 'No email yet' },
      ],
    );

    expect(inviteRepo.rows).toHaveLength(1);
    expect(inviteRepo.rows[0].email).toBe('bob@test.com');
    expect(inviteRepo.rows[0].status).toBe('pending');
    expect(inviteRepo.rows[0].invitedByUserId).toBe('user-1');
    expect(mailService.sendPathTeamInvite).toHaveBeenCalledTimes(1);
    expect(mailService.sendPathTeamInvite).toHaveBeenCalledWith(
      'bob@test.com',
      containing({
        inviterName: 'Ada',
        kindLabel: 'Course Project',
        title: 'My Report',
      }),
    );
  });

  it('auto-connects a registered student teammate so they can see the in-progress report without waiting on the email link', async () => {
    const usersRepo = {
      findOne: jest.fn().mockResolvedValue({ id: 'bob-1', role: 'student' }),
    };
    const { service, inviteRepo, mailService } = makeService();
    internals(service).usersRepo = usersRepo;

    await internals(service).syncTeamInvites(
      'course_project',
      'entry-1',
      'user-1',
      'Ada',
      'Course Project',
      'My Report',
      [{ name: 'Bob', email: 'bob@test.com' }],
    );

    expect(inviteRepo.rows).toHaveLength(1);
    expect(inviteRepo.rows[0].status).toBe('accepted');
    expect(inviteRepo.rows[0].acceptedByUserId).toBe('bob-1');
    expect(mailService.sendPathTeamInvite).toHaveBeenCalledTimes(1);
  });

  it('does not re-invite (or re-send mail for) an email already invited for the same entry', async () => {
    const { service, inviteRepo, mailService } = makeService();
    const args: [
      'course_project',
      string,
      string,
      string,
      string,
      string,
      unknown[],
    ] = [
      'course_project',
      'entry-1',
      'user-1',
      'Ada',
      'Course Project',
      'My Report',
      [{ name: 'Bob', email: 'bob@test.com' }],
    ];

    await internals(service).syncTeamInvites(...args);
    await internals(service).syncTeamInvites(...args);

    expect(inviteRepo.rows).toHaveLength(1);
    expect(mailService.sendPathTeamInvite).toHaveBeenCalledTimes(1);
  });

  it('invites separately-keyed entries independently, even with the same email', async () => {
    const { service, inviteRepo } = makeService();
    await internals(service).syncTeamInvites(
      'course_project',
      'entry-1',
      'user-1',
      'Ada',
      'Course Project',
      'Report A',
      [{ email: 'bob@test.com' }],
    );
    await internals(service).syncTeamInvites(
      'course_project',
      'entry-2',
      'user-1',
      'Ada',
      'Course Project',
      'Report B',
      [{ email: 'bob@test.com' }],
    );

    expect(inviteRepo.rows).toHaveLength(2);
    expect(new Set(inviteRepo.rows.map((r) => r.entryId))).toEqual(
      new Set(['entry-1', 'entry-2']),
    );
  });

  it("revokes a still-pending invite when the member's email is edited/removed on the next sync", async () => {
    const { service, inviteRepo, mailService } = makeService();

    await internals(service).syncTeamInvites(
      'course_project',
      'entry-1',
      'user-1',
      'Ada',
      'Course Project',
      'My Report',
      [{ name: 'Bob', email: 'bob@test.com' }],
    );
    expect(inviteRepo.rows).toHaveLength(1);
    const originalToken = inviteRepo.rows[0].token;

    // The student fixes a typo — bob@test.com becomes bob.k@test.com.
    await internals(service).syncTeamInvites(
      'course_project',
      'entry-1',
      'user-1',
      'Ada',
      'Course Project',
      'My Report',
      [{ name: 'Bob', email: 'bob.k@test.com' }],
    );

    expect(inviteRepo.rows).toHaveLength(2);
    const stale = inviteRepo.rows.find((r) => r.email === 'bob@test.com')!;
    const fresh = inviteRepo.rows.find((r) => r.email === 'bob.k@test.com')!;
    expect(stale.status).toBe('revoked');
    expect(stale.revokedAt).toBeInstanceOf(Date);
    expect(stale.token).toBe(originalToken);
    expect(fresh.status).toBe('pending');
    expect(fresh.token).not.toBe(originalToken);
    expect(mailService.sendPathTeamInvite).toHaveBeenCalledTimes(2);
  });

  it('does not revoke an already-accepted invite when the member is later removed from the list', async () => {
    const inviteRepo = makeInviteRepo();
    inviteRepo.rows.push({
      id: 'invite-1',
      kind: 'course_project',
      entryId: 'entry-1',
      email: 'bob@test.com',
      token: 'tok-1',
      status: 'accepted',
      invitedByUserId: 'user-1',
      expiresAt: new Date(Date.now() + 1000 * 60 * 60),
    });
    const { service } = makeService({ inviteRepo });

    // Bob is removed from the group entirely — no members left.
    await internals(service).syncTeamInvites(
      'course_project',
      'entry-1',
      'user-1',
      'Ada',
      'Course Project',
      'My Report',
      [],
    );

    expect(inviteRepo.rows).toHaveLength(1);
    expect(inviteRepo.rows[0].status).toBe('accepted');
  });

  it('issues a genuinely new invite (new token) when a revoked email is re-added', async () => {
    const inviteRepo = makeInviteRepo();
    inviteRepo.rows.push({
      id: 'invite-1',
      kind: 'course_project',
      entryId: 'entry-1',
      email: 'bob@test.com',
      token: 'tok-old',
      status: 'revoked',
      invitedByUserId: 'user-1',
      expiresAt: new Date(Date.now() + 1000 * 60 * 60),
      revokedAt: new Date(),
    });
    const { service, mailService } = makeService({ inviteRepo });

    await internals(service).syncTeamInvites(
      'course_project',
      'entry-1',
      'user-1',
      'Ada',
      'Course Project',
      'My Report',
      [{ name: 'Bob', email: 'bob@test.com' }],
    );

    expect(inviteRepo.rows).toHaveLength(2);
    const active = inviteRepo.rows.find((r) => r.status === 'pending')!;
    expect(active.token).not.toBe('tok-old');
    expect(mailService.sendPathTeamInvite).toHaveBeenCalledTimes(1);
  });

  it('acceptTeamInvite rejects when the signed-in email does not match the invite email', async () => {
    const inviteRepo = makeInviteRepo();
    inviteRepo.rows.push({
      id: 'invite-1',
      kind: 'course_project',
      entryId: 'entry-1',
      email: 'bob@test.com',
      token: 'tok-1',
      status: 'pending',
      invitedByUserId: 'user-1',
      expiresAt: new Date(Date.now() + 1000 * 60 * 60),
    });
    const { service } = makeService({ inviteRepo });

    await expect(
      service.acceptTeamInvite('tok-1', 'user-2', 'someone-else@test.com'),
    ).rejects.toThrow(ForbiddenException);
  });

  it('acceptTeamInvite rejects an expired pending invite', async () => {
    const inviteRepo = makeInviteRepo();
    inviteRepo.rows.push({
      id: 'invite-1',
      kind: 'course_project',
      entryId: 'entry-1',
      email: 'bob@test.com',
      token: 'tok-1',
      status: 'pending',
      invitedByUserId: 'user-1',
      expiresAt: new Date(Date.now() - 1000),
    });
    const { service } = makeService({ inviteRepo });

    await expect(
      service.acceptTeamInvite('tok-1', 'user-2', 'bob@test.com'),
    ).rejects.toThrow(BadRequestException);
  });

  it('acceptTeamInvite rejects a revoked invite even before it would otherwise expire', async () => {
    const inviteRepo = makeInviteRepo();
    inviteRepo.rows.push({
      id: 'invite-1',
      kind: 'course_project',
      entryId: 'entry-1',
      email: 'bob@test.com',
      token: 'tok-1',
      status: 'revoked',
      invitedByUserId: 'user-1',
      expiresAt: new Date(Date.now() + 1000 * 60 * 60),
      revokedAt: new Date(),
    });
    const { service } = makeService({ inviteRepo });

    await expect(
      service.acceptTeamInvite('tok-1', 'user-2', 'bob@test.com'),
    ).rejects.toThrow(BadRequestException);
    expect(inviteRepo.rows[0].status).toBe('revoked');
  });

  it('acceptTeamInvite throws NotFoundException for an unknown token', async () => {
    const { service } = makeService();
    await expect(
      service.acceptTeamInvite('nope', 'user-2', 'bob@test.com'),
    ).rejects.toThrow(NotFoundException);
  });

  it('acceptTeamInvite marks a valid invite accepted and records who/when', async () => {
    const inviteRepo = makeInviteRepo();
    inviteRepo.rows.push({
      id: 'invite-1',
      kind: 'course_project',
      entryId: 'entry-1',
      email: 'bob@test.com',
      token: 'tok-1',
      status: 'pending',
      invitedByUserId: 'user-1',
      expiresAt: new Date(Date.now() + 1000 * 60 * 60),
    });
    const { service } = makeService({ inviteRepo });

    const result = await service.acceptTeamInvite(
      'tok-1',
      'user-2',
      ' Bob@Test.com ',
    );

    expect(result).toEqual(
      containing({ kind: 'course_project', entryId: 'entry-1' }),
    );
    expect(inviteRepo.rows[0].status).toBe('accepted');
    expect(inviteRepo.rows[0].acceptedByUserId).toBe('user-2');
    expect(inviteRepo.rows[0].acceptedAt).toBeInstanceOf(Date);
  });

  it('resendTeamInvite rejects a requester who did not send the original invite', async () => {
    const inviteRepo = makeInviteRepo();
    inviteRepo.rows.push({
      id: 'invite-1',
      kind: 'course_project',
      entryId: 'entry-1',
      email: 'bob@test.com',
      token: 'tok-1',
      status: 'pending',
      invitedByUserId: 'user-1',
      expiresAt: new Date(Date.now() + 1000),
    });
    const { service } = makeService({ inviteRepo });

    await expect(
      service.resendTeamInvite(
        'some-other-user',
        'course_project',
        'entry-1',
        'bob@test.com',
      ),
    ).rejects.toThrow(ForbiddenException);
  });

  it('resendTeamInvite extends expiry and re-sends mail for the owner', async () => {
    const inviteRepo = makeInviteRepo();
    const originalExpiry = new Date(Date.now() + 1000);
    inviteRepo.rows.push({
      id: 'invite-1',
      kind: 'course_project',
      entryId: 'entry-1',
      email: 'bob@test.com',
      token: 'tok-1',
      status: 'pending',
      invitedByUserId: 'user-1',
      expiresAt: originalExpiry,
    });
    const { service, mailService } = makeService({ inviteRepo });

    const result = await service.resendTeamInvite(
      'user-1',
      'course_project',
      'entry-1',
      'bob@test.com',
    );

    expect(result).toEqual({ success: true });
    expect(mailService.sendPathTeamInvite).toHaveBeenCalledTimes(1);
    expect((inviteRepo.rows[0].expiresAt as Date).getTime()).toBeGreaterThan(
      originalExpiry.getTime(),
    );
  });

  it('resendTeamInvite is a no-op success once already accepted', async () => {
    const inviteRepo = makeInviteRepo();
    inviteRepo.rows.push({
      id: 'invite-1',
      kind: 'course_project',
      entryId: 'entry-1',
      email: 'bob@test.com',
      token: 'tok-1',
      status: 'accepted',
      invitedByUserId: 'user-1',
      expiresAt: new Date(Date.now() + 1000),
    });
    const { service, mailService } = makeService({ inviteRepo });

    const result = await service.resendTeamInvite(
      'user-1',
      'course_project',
      'entry-1',
      'bob@test.com',
    );

    expect(result).toEqual({ success: true, alreadyAccepted: true });
    expect(mailService.sendPathTeamInvite).not.toHaveBeenCalled();
  });

  it('resendTeamInvite refuses to resend a revoked invite', async () => {
    const inviteRepo = makeInviteRepo();
    inviteRepo.rows.push({
      id: 'invite-1',
      kind: 'course_project',
      entryId: 'entry-1',
      email: 'bob@test.com',
      token: 'tok-1',
      status: 'revoked',
      invitedByUserId: 'user-1',
      expiresAt: new Date(Date.now() + 1000),
      revokedAt: new Date(),
    });
    const { service, mailService } = makeService({ inviteRepo });

    await expect(
      service.resendTeamInvite(
        'user-1',
        'course_project',
        'entry-1',
        'bob@test.com',
      ),
    ).rejects.toThrow(BadRequestException);
    expect(mailService.sendPathTeamInvite).not.toHaveBeenCalled();
  });

  it('resendTeamInvite resends the active row when a revoked row exists for the same email', async () => {
    const inviteRepo = makeInviteRepo();
    inviteRepo.rows.push(
      {
        id: 'invite-old',
        kind: 'course_project',
        entryId: 'entry-1',
        email: 'bob@test.com',
        token: 'tok-old',
        status: 'revoked',
        invitedByUserId: 'user-1',
        expiresAt: new Date(Date.now() + 1000),
        revokedAt: new Date(),
      },
      {
        id: 'invite-new',
        kind: 'course_project',
        entryId: 'entry-1',
        email: 'bob@test.com',
        token: 'tok-new',
        status: 'pending',
        invitedByUserId: 'user-1',
        expiresAt: new Date(Date.now() + 1000),
      },
    );
    const { service, mailService } = makeService({ inviteRepo });

    const result = await service.resendTeamInvite(
      'user-1',
      'course_project',
      'entry-1',
      'bob@test.com',
    );

    expect(result).toEqual({ success: true });
    expect(mailService.sendPathTeamInvite).toHaveBeenCalledWith(
      'bob@test.com',
      containing({ token: 'tok-new' }),
    );
  });

  it('getTeamInvitePreview flags an expired pending invite but not an accepted one', async () => {
    const inviteRepo = makeInviteRepo();
    inviteRepo.rows.push({
      id: 'invite-1',
      kind: 'course_project',
      entryId: 'entry-1',
      email: 'bob@test.com',
      token: 'tok-1',
      status: 'pending',
      invitedByUserId: 'user-1',
      expiresAt: new Date(Date.now() - 1000),
    });
    const { service } = makeService({ inviteRepo });

    const preview = await service.getTeamInvitePreview('tok-1');
    expect(preview.expired).toBe(true);

    inviteRepo.rows[0].status = 'accepted';
    inviteRepo.rows[0].expiresAt = new Date(Date.now() - 1000);
    const preview2 = await service.getTeamInvitePreview('tok-1');
    expect(preview2.expired).toBe(false);
  });
});

describe('PathsService — coursework merit notify', () => {
  const makeNotifyService = () => {
    const notificationsService = {
      createNotification: jest.fn().mockResolvedValue(undefined),
    };
    const courseProjectRepo = {
      findOne: jest.fn(),
      save: jest.fn((row: Record<string, unknown>) => Promise.resolve(row)),
    };
    const usersRepo = {
      findOne: jest.fn().mockResolvedValue({ email: 'student@test.com' }),
    };
    const mailService = {
      sendPathTeamInvite: jest.fn(),
      sendCourseworkRankNotification: jest.fn().mockResolvedValue(undefined),
    };
    const graderRunRepo = makeGraderRunRepo();
    const service = createService(
      courseProjectRepo,
      {},
      {},
      makeInviteRepo(),
      usersRepo,
      {},
      mailService,
      notificationsService,
      graderRunRepo,
      {},
    );
    return {
      service,
      notificationsService,
      courseProjectRepo,
      usersRepo,
      mailService,
      graderRunRepo,
    };
  };

  it('pins the UI rank on the card and notifies the owner; ignores ids outside the caller pool', async () => {
    const { service, notificationsService, courseProjectRepo } =
      makeNotifyService();
    jest.spyOn(service, 'getCourseProjectMeritModel').mockResolvedValue({
      scope: { label: 'Faculty supervision' },
      entries: [{ id: 'entry-1', rank: 9 }],
    } as unknown as CourseworkMeritModel);
    courseProjectRepo.findOne.mockResolvedValue({
      id: 'entry-1',
      userId: 'student-1',
      projectTitle: 'Solar audit',
      facultyApprovalStatus: 'approved',
      studentInfo: { studentName: 'Ali Khan' },
    });

    const result = await service.notifyCourseProjectMeritRanks(
      { role: 'faculty', email: 'teacher@test.com' },
      {
        picks: [
          { entryId: 'entry-1', rank: 1, of: 8, total: 91 },
          { entryId: 'other-cohort', rank: 2, of: 8, total: 80 },
        ],
        scopeLabel: 'Your cohort',
      },
    );

    expect(result.notified).toBe(1);
    expect(courseProjectRepo.save).toHaveBeenCalledWith(
      containing({
        meritRibbon: containing({
          faculty: containing({
            rank: 1,
            of: 8,
            scope: 'Your cohort',
            total: 91,
          }),
        }),
      }),
    );
    expect(notificationsService.createNotification).toHaveBeenCalledTimes(1);
    expect(notificationsService.createNotification).toHaveBeenCalledWith(
      'student-1',
      containing({ title: 'Your coursework ranked #1' }),
    );
  });

  it('does not spam a second notification when the same ribbon is already pinned', async () => {
    const { service, notificationsService, courseProjectRepo } =
      makeNotifyService();
    jest.spyOn(service, 'getCourseProjectMeritModel').mockResolvedValue({
      scope: { label: 'Your cohort' },
      entries: [{ id: 'entry-1', rank: 1 }],
    } as unknown as CourseworkMeritModel);
    courseProjectRepo.findOne.mockResolvedValue({
      id: 'entry-1',
      userId: 'student-1',
      projectTitle: 'Solar audit',
      facultyApprovalStatus: 'approved',
      studentInfo: { studentName: 'Ali Khan' },
      meritRibbon: {
        faculty: {
          rank: 1,
          of: 8,
          scope: 'Your cohort',
          total: 91,
          at: '2026-01-01',
        },
      },
    });

    const result = await service.notifyCourseProjectMeritRanks(
      { role: 'faculty', email: 'teacher@test.com' },
      {
        picks: [{ entryId: 'entry-1', rank: 1, of: 8, total: 91 }],
        scopeLabel: 'Your cohort',
      },
    );

    expect(result.notified).toBe(1);
    expect(notificationsService.createNotification).not.toHaveBeenCalled();
  });

  it('computes a badge tier, captures previousRank, and emails the student on a genuine pin', async () => {
    const { service, courseProjectRepo, mailService } = makeNotifyService();
    jest.spyOn(service, 'getCourseProjectMeritModel').mockResolvedValue({
      scope: { label: 'Your cohort' },
      entries: [{ id: 'entry-1', rank: 1 }],
    } as unknown as CourseworkMeritModel);
    courseProjectRepo.findOne.mockResolvedValue({
      id: 'entry-1',
      userId: 'student-1',
      projectTitle: 'Solar audit',
      facultyApprovalStatus: 'approved',
      studentInfo: { studentName: 'Ali Khan' },
      meritRibbon: {
        faculty: {
          rank: 3,
          of: 8,
          scope: 'Your cohort',
          total: 70,
          at: '2026-01-01',
        },
      },
    });

    const result = await service.notifyCourseProjectMeritRanks(
      { role: 'faculty', email: 'teacher@test.com' },
      {
        picks: [{ entryId: 'entry-1', rank: 1, of: 8, total: 91 }],
        scopeLabel: 'Your cohort',
      },
    );

    expect(result.notified).toBe(1);
    expect(courseProjectRepo.save).toHaveBeenCalledWith(
      containing({
        meritRibbon: containing({
          faculty: containing({
            rank: 1,
            of: 8,
            badgeLevel: 'Silver',
            previousRank: 3,
          }),
        }),
      }),
    );
    expect(mailService.sendCourseworkRankNotification).toHaveBeenCalledWith(
      'student@test.com',
      'Ali',
      'Solar audit',
      1,
      8,
      'Your cohort',
      'Silver',
      3,
    );
  });

  it('does not email the student when the ribbon is unchanged (already-dedup)', async () => {
    const { service, mailService, courseProjectRepo } = makeNotifyService();
    jest.spyOn(service, 'getCourseProjectMeritModel').mockResolvedValue({
      scope: { label: 'Your cohort' },
      entries: [{ id: 'entry-1', rank: 1 }],
    } as unknown as CourseworkMeritModel);
    courseProjectRepo.findOne.mockResolvedValue({
      id: 'entry-1',
      userId: 'student-1',
      projectTitle: 'Solar audit',
      facultyApprovalStatus: 'approved',
      studentInfo: { studentName: 'Ali Khan' },
      meritRibbon: {
        faculty: {
          rank: 1,
          of: 8,
          scope: 'Your cohort',
          total: 91,
          at: '2026-01-01',
        },
      },
    });

    await service.notifyCourseProjectMeritRanks(
      { role: 'faculty', email: 'teacher@test.com' },
      {
        picks: [{ entryId: 'entry-1', rank: 1, of: 8, total: 91 }],
        scopeLabel: 'Your cohort',
      },
    );

    expect(mailService.sendCourseworkRankNotification).not.toHaveBeenCalled();
  });
});

describe('PathsService — coursework faculty review', () => {
  const makeReviewService = () => {
    const notificationsService = {
      createNotification: jest.fn().mockResolvedValue(undefined),
    };
    const entry: Record<string, unknown> = {
      id: 'entry-1',
      userId: 'student-1',
      status: 'submitted',
      projectTitle: 'Solar audit',
      facultyApprovalStatus: 'pending',
      studentInfo: {
        studentName: 'Ali Khan',
        teacherEmail: 'teacher@test.com',
      },
      meritRibbon: { rank: 1, of: 8, scope: 'x', at: '2026-01-01' },
    };
    const courseProjectRepo = {
      findOne: jest.fn().mockResolvedValue(entry),
      save: jest.fn((row: Record<string, unknown>) => Promise.resolve(row)),
    };
    const usersRepo = {
      findOne: jest.fn().mockResolvedValue({ email: 'student@test.com' }),
    };
    const mailService = {
      sendCourseworkApproved: jest.fn().mockResolvedValue(undefined),
      sendCourseworkRevisionRequested: jest.fn().mockResolvedValue(undefined),
      sendCourseworkRejected: jest.fn().mockResolvedValue(undefined),
    };
    const service = createService(
      courseProjectRepo,
      {},
      {},
      makeInviteRepo(),
      usersRepo,
      {},
      mailService,
      notificationsService,
      {},
      {},
    );
    return { service, notificationsService, courseProjectRepo, mailService };
  };

  it('approve sets facultyApprovalStatus=approved and emails the student', async () => {
    const { service, courseProjectRepo, mailService } = makeReviewService();
    const saved = await service.facultyReviewCourseProject(
      'teacher@test.com',
      'entry-1',
      'approve',
    );
    expect(saved.facultyApprovalStatus).toBe('approved');
    expect(courseProjectRepo.save).toHaveBeenCalled();
    expect(mailService.sendCourseworkApproved).toHaveBeenCalledWith(
      'student@test.com',
      'Ali',
      'Solar audit',
    );
  });

  it('revision sets facultyApprovalStatus=revision_requested, clears the ribbon, and emails the student', async () => {
    const { service, mailService } = makeReviewService();
    const saved = await service.facultyReviewCourseProject(
      'teacher@test.com',
      'entry-1',
      'revision',
      'Add more evidence',
    );
    expect(saved.facultyApprovalStatus).toBe('revision_requested');
    expect(saved.meritRibbon).toBeNull();
    expect(mailService.sendCourseworkRevisionRequested).toHaveBeenCalledWith(
      'student@test.com',
      'Ali',
      'Solar audit',
      'Add more evidence',
    );
  });

  it('reject sets facultyApprovalStatus=rejected and emails the student', async () => {
    const { service, mailService } = makeReviewService();
    const saved = await service.facultyReviewCourseProject(
      'teacher@test.com',
      'entry-1',
      'reject',
      'Not enough SDG linkage',
    );
    expect(saved.facultyApprovalStatus).toBe('rejected');
    expect(mailService.sendCourseworkRejected).toHaveBeenCalledWith(
      'student@test.com',
      'Ali',
      'Solar audit',
      'Not enough SDG linkage',
    );
  });

  it('approve persists the faculty moderation overrides so they survive a reload', async () => {
    const { service, courseProjectRepo } = makeReviewService();
    const moderation = {
      levels: { evidence: 4, originality: 3 },
      notes: { originality: 'Lowered — largely templated' },
      facultyScore: 78,
      band: 'Merit',
      lockHash: 'abc123',
    };
    const saved = await service.facultyReviewCourseProject(
      'teacher@test.com',
      'entry-1',
      'approve',
      undefined,
      moderation,
    );
    expect(saved.facultyModeration).toEqual(containing(moderation));
    expect(saved.facultyModeration!.at).toEqual(expect.any(String));
    expect(courseProjectRepo.save).toHaveBeenCalledWith(
      containing({
        facultyModeration: containing({ facultyScore: 78 }),
      }),
    );
  });

  it('revision/reject clear any previously stored faculty moderation, same as the ribbon', async () => {
    const { service } = makeReviewService();
    const saved = await service.facultyReviewCourseProject(
      'teacher@test.com',
      'entry-1',
      'reject',
      'Not enough SDG linkage',
    );
    expect(saved.facultyModeration).toBeNull();
  });

  it('rejects with no reason are refused — a student is entitled to know why', async () => {
    const { service, courseProjectRepo } = makeReviewService();
    await expect(
      service.facultyReviewCourseProject(
        'teacher@test.com',
        'entry-1',
        'reject',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.facultyReviewCourseProject(
        'teacher@test.com',
        'entry-1',
        'reject',
        '   ',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(courseProjectRepo.save).not.toHaveBeenCalled();
  });

  it('revision requests with no reason are refused', async () => {
    const { service } = makeReviewService();
    await expect(
      service.facultyReviewCourseProject(
        'teacher@test.com',
        'entry-1',
        'revision',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('PathsService — coursework AI score is never returned to a student', () => {
  function makeQb(result: Record<string, unknown>[]) {
    const qb: FakeQueryBuilder = {
      where: jest.fn(() => qb),
      andWhere: jest.fn(() => qb),
      orWhere: jest.fn(() => qb),
      orderBy: jest.fn(() => qb),
      getMany: jest.fn(() => Promise.resolve(result)),
      getOne: jest.fn(() => Promise.resolve(result[0] ?? null)),
    };
    return qb;
  }

  const makeStudentReadService = (entry: Record<string, unknown>) => {
    const courseProjectRepo = {
      createQueryBuilder: jest.fn(() => makeQb([entry])),
      find: jest.fn().mockResolvedValue([entry]),
    };
    const service = createService(
      courseProjectRepo,
      {},
      {},
      makeInviteRepo(),
      { findOne: jest.fn() },
      {},
      {},
      { createNotification: jest.fn() },
      {},
      {},
    );
    jest
      .spyOn(service as any, 'courseProjectAnnotate')
      .mockImplementation((entries: unknown) => Promise.resolve(entries));
    return { service, courseProjectRepo };
  };

  const approvedEntry = {
    id: 'entry-1',
    userId: 'student-1',
    status: 'submitted',
    facultyApprovalStatus: 'approved',
    studentInfo: { universityName: 'CIEL University' },
    meritRibbon: null,
  };

  it('listCourseProjects strips the numeric total, keeping only rank/of/scope/badge', async () => {
    const { service } = makeStudentReadService({ ...approvedEntry });
    const [result] = await service.listCourseProjects(
      'student-1',
      'student@test.com',
    );
    expect(result.meritRibbon).toBeTruthy();
    expect(result.meritRibbon!.cielpk!.total).toBeUndefined();
    expect(result.meritRibbon!.cielpk!.rank).toBe(1);
    expect(result.meritRibbon!.university!.rank).toBe(1);
    expect(result.meritRibbon!.faculty!.rank).toBe(1);
  });

  it('getCourseProjectByIdForUser strips the numeric total for the owning student', async () => {
    const { service } = makeStudentReadService({ ...approvedEntry });
    const result = await service.getCourseProjectByIdForUser(
      'student-1',
      'student@test.com',
      'entry-1',
    );
    expect(result.meritRibbon).toBeTruthy();
    expect(result.meritRibbon!.cielpk!.total).toBeUndefined();
  });

  it('never returns the faculty moderation breakdown to the owning student', async () => {
    const withModeration = {
      ...approvedEntry,
      facultyModeration: {
        levels: { evidence: 4 },
        facultyScore: 78,
        at: '2026-01-01',
      },
    };
    const { service } = makeStudentReadService(withModeration);
    const [listed] = await service.listCourseProjects(
      'student-1',
      'student@test.com',
    );
    expect(listed.facultyModeration).toBeNull();

    const { service: service2 } = makeStudentReadService({ ...withModeration });
    const byId = await service2.getCourseProjectByIdForUser(
      'student-1',
      'student@test.com',
      'entry-1',
    );
    expect(byId.facultyModeration).toBeNull();
  });

  it('resubmitting an approved entry clears the stale faculty moderation, not just the ribbon', async () => {
    const rows: Record<string, unknown>[] = [
      {
        id: 'entry-1',
        userId: 'student-1',
        status: 'submitted',
        facultyApprovalStatus: 'approved',
        facultyModeration: {
          levels: { evidence: 4 },
          facultyScore: 78,
          at: '2026-01-01',
        },
        meritRibbon: { rank: 1, of: 10, scope: 'university', total: 91 },
        studentInfo: {
          studentName: 'Ali Khan',
          universityName: 'Test University',
          teacherEmail: 'teacher@test.com',
        },
        assignmentInfo: { format: 'Report' },
        aimsInfo: { aimStatement: 'Audit rooftop solar viability.' },
        processInfo: { activities: ['Site survey'] },
        resultsInfo: { resultsSummary: 'Rooftop can host 5kW.' },
        sdgMapping: { notApplicable: true },
        reflectionInfo: {
          lessonLearned: 'Data collection takes longer than planned.',
        },
      },
    ];
    const manager = {
      getRepository: () => ({
        findOne: jest.fn(() => Promise.resolve(rows[0] ?? null)),
        save: jest.fn((row: Record<string, unknown>) => {
          rows[0] = row;
          return Promise.resolve(row);
        }),
      }),
    };
    const service = createService(
      {
        manager: {
          transaction: jest.fn((fn: (m: unknown) => unknown) =>
            Promise.resolve(fn(manager)),
          ),
        },
      },
      {},
      {},
      makeInviteRepo(),
      { findOne: jest.fn() },
      {},
      {
        sendCourseworkSubmittedForReview: jest.fn(),
        sendCourseworkSubmissionConfirmation: jest.fn(),
        sendCourseworkResubmittedForReview: jest.fn(),
      },
      { createNotification: jest.fn() },
      {},
      {},
    );
    jest
      .spyOn(service as any, 'syncCourseProjectInvites')
      .mockResolvedValue(undefined);
    jest
      .spyOn(service as any, 'courseProjectAnnotate')
      .mockImplementation((entries: unknown) => Promise.resolve(entries));

    // The student edits any field on their already-approved report — this alone must
    // invalidate the stale approval, including the faculty's own scoring breakdown, not
    // just the coarse rank/of ribbon.
    const saved = await service.updateCourseProjectByIdForUser(
      'student-1',
      'entry-1',
      { addedNote: 'tweak' },
    );

    expect((rows[0] as SavedRow).facultyModeration).toBeNull();
    expect(saved.facultyApprovalStatus).toBe('pending');
    expect(saved.facultyModeration).toBeNull();
  });

  it('the live PATCH endpoint never returns the faculty moderation breakdown, even mid-edit', async () => {
    const rows: Record<string, unknown>[] = [
      {
        id: 'entry-1',
        userId: 'student-1',
        status: 'draft',
        facultyApprovalStatus: 'pending',
        facultyModeration: {
          levels: { evidence: 4 },
          facultyScore: 78,
          at: '2026-01-01',
        },
        meritRibbon: {
          university: { rank: 2, of: 10, scope: 'university', total: 60 },
        },
        studentInfo: {},
      },
    ];
    const manager = {
      getRepository: () => ({
        findOne: jest.fn(() => Promise.resolve(rows[0] ?? null)),
        save: jest.fn((row: Record<string, unknown>) => {
          rows[0] = row;
          return Promise.resolve(row);
        }),
      }),
    };
    const service = createService(
      {
        manager: {
          transaction: jest.fn((fn: (m: unknown) => unknown) =>
            Promise.resolve(fn(manager)),
          ),
        },
      },
      {},
      {},
      makeInviteRepo(),
      { findOne: jest.fn() },
      {},
      {
        sendCourseworkSubmittedForReview: jest.fn(),
        sendCourseworkSubmissionConfirmation: jest.fn(),
      },
      { createNotification: jest.fn() },
      {},
      {},
    );
    jest
      .spyOn(service as any, 'syncCourseProjectInvites')
      .mockResolvedValue(undefined);
    jest
      .spyOn(service as any, 'courseProjectAnnotate')
      .mockImplementation((entries: unknown) => Promise.resolve(entries));

    // facultyModeration wasn't reset here (entry never reached 'submitted'/'approved' this
    // save) — the response must still never carry it, mirroring listCourseProjects/getById.
    const saved = await service.updateCourseProjectByIdForUser(
      'student-1',
      'entry-1',
      { addedNote: 'draft edit' },
    );

    expect(saved.facultyModeration).toBeNull();
    expect(saved.meritRibbon!.university!.rank).toBe(2);
    expect(saved.meritRibbon!.university!.total).toBeUndefined();
  });

  it('refuses to redirect an already-submitted entry to a different teacherEmail', async () => {
    const rows: Record<string, unknown>[] = [
      {
        id: 'entry-1',
        userId: 'student-1',
        status: 'submitted',
        facultyApprovalStatus: 'pending',
        studentInfo: { teacherEmail: 'teacherA@test.com', studentName: 'Ali' },
      },
    ];
    const manager = {
      getRepository: () => ({
        findOne: jest.fn(() => Promise.resolve(rows[0] ?? null)),
        save: jest.fn((row: Record<string, unknown>) => {
          rows[0] = row;
          return Promise.resolve(row);
        }),
      }),
    };
    const service = createService(
      {
        manager: {
          transaction: jest.fn((fn: (m: unknown) => unknown) =>
            Promise.resolve(fn(manager)),
          ),
        },
      },
      {},
      {},
      makeInviteRepo(),
      { findOne: jest.fn() },
      {},
      {
        sendCourseworkSubmittedForReview: jest.fn(),
        sendCourseworkSubmissionConfirmation: jest.fn(),
      },
      { createNotification: jest.fn() },
      {},
      {},
    );
    jest
      .spyOn(service as any, 'syncCourseProjectInvites')
      .mockResolvedValue(undefined);
    jest
      .spyOn(service as any, 'courseProjectAnnotate')
      .mockImplementation((entries: unknown) => Promise.resolve(entries));

    // A raw API call attempting to hijack review to a different faculty account.
    const saved = await service.updateCourseProjectByIdForUser(
      'student-1',
      'entry-1',
      {
        studentInfo: { teacherEmail: 'teacherB@test.com', studentName: 'Ali' },
      },
    );

    expect(saved.studentInfo!.teacherEmail).toBe('teacherA@test.com');
  });

  it('still allows changing teacherEmail while the entry is still a draft', async () => {
    const rows: Record<string, unknown>[] = [
      {
        id: 'entry-1',
        userId: 'student-1',
        status: 'draft',
        studentInfo: { teacherEmail: 'teacherA@test.com' },
      },
    ];
    const manager = {
      getRepository: () => ({
        findOne: jest.fn(() => Promise.resolve(rows[0] ?? null)),
        save: jest.fn((row: Record<string, unknown>) => {
          rows[0] = row;
          return Promise.resolve(row);
        }),
      }),
    };
    const service = createService(
      {
        manager: {
          transaction: jest.fn((fn: (m: unknown) => unknown) =>
            Promise.resolve(fn(manager)),
          ),
        },
      },
      {},
      {},
      makeInviteRepo(),
      { findOne: jest.fn() },
      {},
      {
        sendCourseworkSubmittedForReview: jest.fn(),
        sendCourseworkSubmissionConfirmation: jest.fn(),
      },
      { createNotification: jest.fn() },
      {},
      {},
    );
    jest
      .spyOn(service as any, 'syncCourseProjectInvites')
      .mockResolvedValue(undefined);
    jest
      .spyOn(service as any, 'courseProjectAnnotate')
      .mockImplementation((entries: unknown) => Promise.resolve(entries));

    const saved = await service.updateCourseProjectByIdForUser(
      'student-1',
      'entry-1',
      {
        studentInfo: { teacherEmail: 'teacherB@test.com' },
      },
    );

    expect(saved.studentInfo!.teacherEmail).toBe('teacherB@test.com');
  });
});

describe('PathsService — coursework submit/resubmit emails', () => {
  const makeSubmitService = (initialEntry: Record<string, unknown> | null) => {
    const notificationsService = {
      createNotification: jest.fn().mockResolvedValue(undefined),
    };
    const rows: Record<string, unknown>[] = initialEntry
      ? [{ ...initialEntry }]
      : [];
    const manager = {
      getRepository: () => ({
        findOne: jest.fn(() => Promise.resolve(rows[0] ?? null)),
        create: jest.fn((data: Record<string, unknown>) => ({
          status: 'draft',
          ...data,
        })),
        save: jest.fn((row: Record<string, unknown>) => {
          rows[0] = row;
          return Promise.resolve(row);
        }),
      }),
    };
    const courseProjectRepo = {
      manager: {
        transaction: jest.fn((fn: (m: unknown) => unknown) =>
          Promise.resolve(fn(manager)),
        ),
      },
    };
    const usersRepo = {
      findOne: jest.fn().mockResolvedValue({ email: 'student@test.com' }),
    };
    const mailService = {
      sendCourseworkSubmittedForReview: jest.fn().mockResolvedValue(undefined),
      sendCourseworkSubmissionConfirmation: jest
        .fn()
        .mockResolvedValue(undefined),
      sendCourseworkResubmittedForReview: jest
        .fn()
        .mockResolvedValue(undefined),
    };
    const service = createService(
      courseProjectRepo,
      {},
      {},
      makeInviteRepo(),
      usersRepo,
      {},
      mailService,
      notificationsService,
      {},
      {},
    );
    jest
      .spyOn(service as any, 'syncCourseProjectInvites')
      .mockResolvedValue(undefined);
    jest
      .spyOn(service as any, 'courseProjectAnnotate')
      .mockImplementation((entries: unknown) => Promise.resolve(entries));
    return { service, mailService };
  };

  it('first submission emails faculty and the student exactly once', async () => {
    const { service, mailService } = makeSubmitService({
      id: 'entry-1',
      userId: 'student-1',
      status: 'draft',
      projectTitle: 'Solar audit',
      facultyApprovalStatus: 'pending',
      studentInfo: {
        studentName: 'Ali Khan',
        universityName: 'Test University',
        teacherEmail: 'teacher@test.com',
      },
      assignmentInfo: { format: 'Report' },
      aimsInfo: { aimStatement: 'Audit rooftop solar viability.' },
      processInfo: { activities: ['Site survey'] },
      resultsInfo: { resultsSummary: 'Rooftop can host 5kW.' },
      sdgMapping: { notApplicable: true },
      reflectionInfo: {
        lessonLearned: 'Data collection takes longer than planned.',
      },
    });
    await service.updateCourseProjectByIdForUser('student-1', 'entry-1', {
      status: 'submitted',
    });
    expect(mailService.sendCourseworkSubmittedForReview).toHaveBeenCalledTimes(
      1,
    );
    expect(
      mailService.sendCourseworkSubmissionConfirmation,
    ).toHaveBeenCalledTimes(1);
    expect(
      mailService.sendCourseworkResubmittedForReview,
    ).not.toHaveBeenCalled();
  });

  it('a patch to a rejected, already-submitted entry emails faculty once (resubmission), not again on the next patch', async () => {
    const { service, mailService } = makeSubmitService({
      id: 'entry-1',
      userId: 'student-1',
      status: 'submitted',
      projectTitle: 'Solar audit',
      facultyApprovalStatus: 'rejected',
      facultyApprovalNote: 'fix this',
      studentInfo: {
        studentName: 'Ali Khan',
        universityName: 'Test University',
        teacherEmail: 'teacher@test.com',
      },
      assignmentInfo: { format: 'Report' },
      aimsInfo: { aimStatement: 'Audit rooftop solar viability.' },
      processInfo: { activities: ['Site survey'] },
      resultsInfo: { resultsSummary: 'Rooftop can host 5kW.' },
      sdgMapping: { notApplicable: true },
      reflectionInfo: {
        lessonLearned: 'Data collection takes longer than planned.',
      },
    });
    await service.updateCourseProjectByIdForUser('student-1', 'entry-1', {
      addedNote: 'fixed',
    });
    expect(
      mailService.sendCourseworkResubmittedForReview,
    ).toHaveBeenCalledTimes(1);

    await service.updateCourseProjectByIdForUser('student-1', 'entry-1', {
      addedNote: 'fixed again',
    });
    expect(
      mailService.sendCourseworkResubmittedForReview,
    ).toHaveBeenCalledTimes(1);
  });
});

describe('PathsService — coursework team-member edit', () => {
  const makeTeamEditService = () => {
    const inviteRepo = makeInviteRepo();
    inviteRepo.rows.push({
      kind: 'course_project',
      entryId: 'entry-1',
      email: 'bob@test.com',
      status: 'accepted',
    });
    const rows: Record<string, unknown>[] = [
      {
        id: 'entry-1',
        userId: 'owner-1',
        status: 'draft',
        studentInfo: { groupMembers: [{ name: 'Bob', email: 'bob@test.com' }] },
      },
    ];
    const manager = {
      getRepository: () => ({
        findOne: jest.fn(() => Promise.resolve(rows[0] ?? null)),
        save: jest.fn((row: Record<string, unknown>) => {
          rows[0] = row;
          return Promise.resolve(row);
        }),
      }),
    };
    const service = createService(
      {
        manager: {
          transaction: jest.fn((fn: (m: unknown) => unknown) =>
            Promise.resolve(fn(manager)),
          ),
        },
      },
      {},
      {},
      inviteRepo,
      { findOne: jest.fn() },
      {},
      {
        sendCourseworkSubmittedForReview: jest.fn(),
        sendCourseworkSubmissionConfirmation: jest.fn(),
        sendCourseworkResubmittedForReview: jest.fn(),
      },
      { createNotification: jest.fn() },
      {},
      {},
    );
    jest
      .spyOn(service as any, 'syncCourseProjectInvites')
      .mockResolvedValue(undefined);
    jest
      .spyOn(service as any, 'courseProjectAnnotate')
      .mockImplementation((entries: unknown) => Promise.resolve(entries));
    return { service };
  };

  it('lets an accepted teammate patch the same draft', async () => {
    const { service } = makeTeamEditService();
    const saved = await service.updateCourseProjectByIdForUser(
      'bob-1',
      'entry-1',
      { addedNote: 'from teammate' },
      'bob@test.com',
    );
    expect(saved.addedNote).toBe('from teammate');
    expect(saved.isOwner).toBe(false);
  });

  it('rejects a stranger who is not on the team', async () => {
    const { service } = makeTeamEditService();
    await expect(
      service.updateCourseProjectByIdForUser(
        'eve-1',
        'entry-1',
        { addedNote: 'nope' },
        'eve@test.com',
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('PathsService — FYP multi-record (list / create / id-scoped)', () => {
  const makeFypMultiRecordService = () => {
    const inviteRepo = makeInviteRepo();
    inviteRepo.rows.push({
      kind: 'fyp',
      entryId: 'fyp-1',
      email: 'bob@test.com',
      status: 'accepted',
    });
    const rows: Record<string, unknown>[] = [
      {
        id: 'fyp-1',
        userId: 'owner-1',
        status: 'draft',
        projectInfo: { teamMembers: [{ name: 'Bob', email: 'bob@test.com' }] },
      },
      {
        id: 'fyp-2',
        userId: 'owner-1',
        status: 'draft',
        projectInfo: {},
      },
    ];
    const fypRepo = {
      create: jest.fn((data: Record<string, unknown>) => ({ ...data })),
      findOne: jest.fn((opts: { where?: Record<string, unknown> } = {}) =>
        Promise.resolve(
          rows.find((r) => matchesWhere(r, opts.where ?? {})) ?? null,
        ),
      ),
      save: jest.fn((row: Record<string, unknown>) => {
        if (!row.id) {
          row.id = `fyp-${rows.length + 1}`;
          rows.push(row);
          return Promise.resolve(row);
        }
        const idx = rows.findIndex((r) => r.id === row.id);
        if (idx === -1) rows.push(row);
        else rows[idx] = row;
        return Promise.resolve(row);
      }),
      delete: jest.fn((where: { id: string; userId: string }) => {
        const idx = rows.findIndex(
          (r) => r.id === where.id && r.userId === where.userId,
        );
        if (idx !== -1) rows.splice(idx, 1);
        return Promise.resolve();
      }),
      manager: {
        transaction: jest.fn((fn: (m: unknown) => unknown) =>
          Promise.resolve(
            fn({
              getRepository: () => ({
                findOne: jest.fn(
                  (opts: { where?: Record<string, unknown> } = {}) =>
                    Promise.resolve(
                      rows.find((r) => matchesWhere(r, opts.where ?? {})) ??
                        null,
                    ),
                ),
                save: jest.fn((row: Record<string, unknown>) => {
                  const idx = rows.findIndex((r) => r.id === row.id);
                  if (idx === -1) rows.push(row);
                  else rows[idx] = row;
                  return Promise.resolve(row);
                }),
              }),
            }),
          ),
        ),
      },
      createQueryBuilder: () => {
        const state: { userId?: string; id?: string } = {};
        const qb: FakeQueryBuilder = {
          where: jest.fn((_cond: string, params?: Record<string, unknown>) => {
            if (params && 'userId' in params)
              state.userId = params.userId as string;
            if (params && 'id' in params) state.id = params.id as string;
            return qb;
          }),
          andWhere: jest.fn((builder: unknown) => {
            type BracketArg = {
              where: (c: string, p?: Record<string, unknown>) => void;
              orWhere: () => void;
            };
            if (typeof builder === 'function') {
              const b: BracketArg = {
                where: (_c, p) => {
                  if (p && 'userId' in p) state.userId = p.userId as string;
                },
                orWhere: () => {},
              };
              (builder as (arg: BracketArg) => void)(b);
            }
            return qb;
          }),
          orWhere: jest.fn(() => qb),
          orderBy: jest.fn(() => qb),
          getMany: jest.fn(() =>
            Promise.resolve(
              rows.filter((r) =>
                state.userId ? r.userId === state.userId : true,
              ),
            ),
          ),
          getOne: jest.fn(() =>
            Promise.resolve(
              rows.find(
                (r) =>
                  r.id === state.id &&
                  (state.userId ? r.userId === state.userId : true),
              ) ?? null,
            ),
          ),
        };
        return qb;
      },
    };
    const service = createService(
      {},
      fypRepo,
      {},
      inviteRepo,
      { findOne: jest.fn() },
      {},
      {},
      { createNotification: jest.fn() },
      {},
      {},
    );
    jest.spyOn(service as any, 'syncFypInvites').mockResolvedValue(undefined);
    jest
      .spyOn(service as any, 'fypAnnotate')
      .mockImplementation((entries: unknown) => Promise.resolve(entries));
    return { service, rows, fypRepo };
  };

  it('createFyp always makes a new row, never reusing an existing one', async () => {
    const { service, rows } = makeFypMultiRecordService();
    const before = rows.length;
    const created = await service.createFyp('owner-1');
    expect(rows.length).toBe(before + 1);
    expect(created.isOwner).toBe(true);
  });

  it('createFyp returns the existing row when the unique error is nested on driverError', async () => {
    const { service, rows, fypRepo } = makeFypMultiRecordService();
    const before = rows.length;
    fypRepo.save.mockRejectedValueOnce({
      driverError: { code: '23505' },
      message: 'duplicate key value violates unique constraint',
    });
    const opened = await service.createFyp('owner-1');
    expect(rows.length).toBe(before);
    expect(opened.id).toBe('fyp-1');
  });

  it('listFyps returns every entry the user owns', async () => {
    const { service } = makeFypMultiRecordService();
    const list = await service.listFyps('owner-1', 'owner@test.com');
    expect(list.map((e) => e.id).sort()).toEqual(['fyp-1', 'fyp-2']);
    expect(list.every((e) => e.isOwner)).toBe(true);
  });

  it('lets an accepted teammate patch the shared draft by id', async () => {
    const { service } = makeFypMultiRecordService();
    const saved = await service.updateFypByIdForUser(
      'bob-1',
      'fyp-1',
      { addedNote: 'from teammate' },
      'bob@test.com',
    );
    expect(saved.addedNote).toBe('from teammate');
    expect(saved.isOwner).toBe(false);
  });

  it('rejects a stranger who is not on the FYP team', async () => {
    const { service } = makeFypMultiRecordService();
    await expect(
      service.updateFypByIdForUser(
        'eve-1',
        'fyp-1',
        { addedNote: 'nope' },
        'eve@test.com',
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("deleteFypByIdForUser removes only the owner's own draft", async () => {
    const { service, rows } = makeFypMultiRecordService();
    await service.deleteFypByIdForUser('owner-1', 'fyp-2');
    expect(rows.find((r) => r.id === 'fyp-2')).toBeUndefined();
  });

  it('deleteFypByIdForUser refuses to delete a submitted record', async () => {
    const { service, rows } = makeFypMultiRecordService();
    rows.find((r) => r.id === 'fyp-2')!.status = 'submitted';
    await expect(
      service.deleteFypByIdForUser('owner-1', 'fyp-2'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

function makeGraderRunRepo() {
  const rows: Array<Record<string, unknown>> = [];
  const findOne = jest.fn((opts: { where?: Record<string, unknown> } = {}) =>
    Promise.resolve(
      rows.find((r) => matchesWhere(r, opts.where ?? {})) ?? null,
    ),
  );
  const create = jest.fn((data: Record<string, unknown>) => ({ ...data }));
  const save = jest.fn((row: Record<string, unknown>) => {
    const idx = rows.findIndex(
      (r) =>
        r.scope === row.scope &&
        r.scopeKey === row.scopeKey &&
        r.academicYear === row.academicYear,
    );
    if (idx === -1) rows.push(row);
    else rows[idx] = row;
    return Promise.resolve(row);
  });
  return {
    rows,
    findOne,
    create,
    save,
    manager: {
      transaction: jest.fn((fn: (m: unknown) => unknown) =>
        Promise.resolve(
          fn({ getRepository: () => ({ findOne, create, save }) }),
        ),
      ),
    },
  };
}

describe('PathsService — coursework grader run limit', () => {
  const makeGraderService = (graderRunRepo = makeGraderRunRepo()) => {
    const notificationsService = {
      createNotification: jest.fn().mockResolvedValue(undefined),
    };
    const courseProjectRepo = {
      findOne: jest.fn().mockResolvedValue({
        id: 'entry-1',
        userId: 'student-1',
        projectTitle: 'Solar audit',
        facultyApprovalStatus: 'approved',
        studentInfo: { studentName: 'Ali Khan' },
      }),
      save: jest.fn((row: Record<string, unknown>) => Promise.resolve(row)),
    };
    const usersRepo = {
      findOne: jest.fn().mockResolvedValue({ email: 'student@test.com' }),
    };
    const mailService = {
      sendCourseworkRankNotification: jest.fn().mockResolvedValue(undefined),
    };
    const service = createService(
      courseProjectRepo,
      {},
      {},
      makeInviteRepo(),
      usersRepo,
      {},
      mailService,
      notificationsService,
      graderRunRepo,
      {},
    );
    jest.spyOn(service, 'getCourseProjectMeritModel').mockResolvedValue({
      scope: { label: 'Your cohort' },
      entries: [{ id: 'entry-1', rank: 1 }],
    } as unknown as CourseworkMeritModel);
    return { service, graderRunRepo };
  };

  const notifyOnce = (service: PathsService, user: Record<string, unknown>) =>
    service.notifyCourseProjectMeritRanks(user as MeritModelUser, {
      picks: [{ entryId: 'entry-1', rank: 1, of: 5, total: 90 }],
    });

  it('allows exactly 3 runs per academic year for a faculty scope, then blocks the 4th', async () => {
    const { service } = makeGraderService();
    const user = { role: 'faculty', email: 'teacher@test.com' };

    const r1 = await notifyOnce(service, user);
    expect(r1.graderRuns).toEqual({
      unlimited: false,
      used: 1,
      limit: 3,
    });
    const r2 = await notifyOnce(service, user);
    expect(r2.graderRuns.used).toBe(2);
    const r3 = await notifyOnce(service, user);
    expect(r3.graderRuns.used).toBe(3);

    await expect(notifyOnce(service, user)).rejects.toMatchObject({
      response: containing({
        code: 'GRADER_RUNS_EXHAUSTED',
        used: 3,
        limit: 3,
      }),
    });
  });

  it('scopes the cap independently per faculty email', async () => {
    const graderRunRepo = makeGraderRunRepo();
    const { service } = makeGraderService(graderRunRepo);
    await notifyOnce(service, { role: 'faculty', email: 'teacher-a@test.com' });
    await notifyOnce(service, { role: 'faculty', email: 'teacher-a@test.com' });
    await notifyOnce(service, { role: 'faculty', email: 'teacher-a@test.com' });
    // teacher-a is now exhausted, but teacher-b has an independent counter.
    await expect(
      notifyOnce(service, { role: 'faculty', email: 'teacher-a@test.com' }),
    ).rejects.toBeDefined();
    const rB = await notifyOnce(service, {
      role: 'faculty',
      email: 'teacher-b@test.com',
    });
    expect(rB.graderRuns).toEqual({
      unlimited: false,
      used: 1,
      limit: 3,
    });
  });

  it('scopes the cap independently per university organizationId', async () => {
    const { service } = makeGraderService();
    const rUni = await notifyOnce(service, {
      role: 'university',
      organizationId: 'org-1',
    });
    expect(rUni.graderRuns).toEqual({
      unlimited: false,
      used: 1,
      limit: 3,
    });
  });

  it('never blocks SUPER_ADMIN (unlimited runs)', async () => {
    const { service } = makeGraderService();
    const admin = { role: 'admin', email: 'admin@ciel.pk' };
    for (let i = 0; i < 5; i++) {
      const r = await notifyOnce(service, admin);
      expect(r.graderRuns).toEqual({
        unlimited: true,
        used: 0,
        limit: 0,
      });
    }
  });
});

describe('PathsService — public coursework verification', () => {
  const makeVerifyService = (entry: Record<string, unknown> | null) => {
    const courseProjectRepo = { findOne: jest.fn().mockResolvedValue(entry) };
    const service = createService(
      courseProjectRepo,
      {},
      {},
      makeInviteRepo(),
      {},
      {},
      {},
      {},
      {},
      {},
    );
    return { service, courseProjectRepo };
  };

  it('returns a PII-minimal verified payload for an approved entry', async () => {
    const { service } = makeVerifyService({
      id: 'entry-1',
      projectTitle: 'Solar audit',
      facultyApprovalStatus: 'approved',
      facultyApprovalAt: new Date('2026-01-01'),
      verificationPublicSlug: 'abc-123',
      meritRibbon: {
        faculty: {
          rank: 2,
          of: 8,
          scope: 'Faculty supervision',
          badgeLevel: 'Silver',
        },
        cielpk: { rank: 1, of: 8, scope: 'Your cohort', badgeLevel: 'Gold' },
      },
    });
    const result = await service.getPublicCourseworkVerification('abc-123');
    expect(result).toMatchObject({
      success: true,
      verified: true,
      project_title: 'Solar audit',
      badge_level: 'Gold',
      rank: 1,
      of: 8,
    });
    expect(result).not.toHaveProperty('student_name');
    expect(result).not.toHaveProperty('studentInfo');
  });

  it('falls back to the faculty badge when no university/cielpk ribbon is published yet', async () => {
    const { service } = makeVerifyService({
      id: 'entry-1',
      projectTitle: 'Solar audit',
      facultyApprovalStatus: 'approved',
      facultyApprovalAt: new Date('2026-01-01'),
      verificationPublicSlug: 'abc-123',
      meritRibbon: {
        faculty: {
          rank: 2,
          of: 8,
          scope: 'Faculty supervision',
          badgeLevel: 'Silver',
        },
      },
    });
    const result = await service.getPublicCourseworkVerification('abc-123');
    expect(result).toMatchObject({
      badge_level: 'Silver',
      rank: 2,
      of: 8,
      scope: 'Faculty supervision',
    });
  });

  it('returns verified:false with only a status for a pending entry', async () => {
    const { service } = makeVerifyService({
      id: 'entry-1',
      projectTitle: 'Solar audit',
      facultyApprovalStatus: 'pending',
      verificationPublicSlug: 'abc-123',
    });
    const result = await service.getPublicCourseworkVerification('abc-123');
    expect(result).toEqual({
      success: true,
      verified: false,
      status: 'pending',
    });
  });

  it('throws NotFoundException for an unknown key', async () => {
    const { service } = makeVerifyService(null);
    await expect(
      service.getPublicCourseworkVerification('nope'),
    ).rejects.toThrow(NotFoundException);
  });
});

describe('PathsService — FYP resubmission after rejection', () => {
  it('resets supervisorApprovalStatus to pending on the next edit, keeping the note but clearing the timestamp', async () => {
    const rows: Record<string, unknown>[] = [
      {
        id: 'fyp-1',
        userId: 'student-1',
        status: 'submitted',
        supervisorApprovalStatus: 'rejected',
        supervisorApprovalNote: 'needs more literature review',
        supervisorApprovalAt: new Date('2026-01-01'),
      },
    ];
    const manager = {
      getRepository: () => ({
        findOne: jest.fn(() => Promise.resolve(rows[0] ?? null)),
        create: jest.fn((data: Record<string, unknown>) => ({ ...data })),
        save: jest.fn((row: Record<string, unknown>) => {
          rows[0] = row;
          return Promise.resolve(row);
        }),
      }),
    };
    const fypRepo = {
      manager: {
        transaction: jest.fn((fn: (m: unknown) => unknown) =>
          Promise.resolve(fn(manager)),
        ),
      },
    };
    const service = createService(
      {},
      fypRepo,
      {},
      makeInviteRepo(),
      {},
      {},
      {},
      { createNotification: jest.fn() },
      {},
      {},
    );
    jest.spyOn(service as any, 'syncFypInvites').mockResolvedValue(undefined);
    jest
      .spyOn(service as any, 'fypAnnotate')
      .mockImplementation((entries: unknown) => Promise.resolve(entries));

    const saved = await service.upsertFyp('student-1', {
      addedNote: 'fixed',
    });

    expect(saved.supervisorApprovalStatus).toBe('pending');
    expect(saved.supervisorApprovalAt).toBeNull();
    expect(saved.supervisorApprovalNote).toBe('needs more literature review');
  });

  it('also resets a revision_requested entry to pending on the next edit', async () => {
    const rows: Record<string, unknown>[] = [
      {
        id: 'fyp-2',
        userId: 'student-1',
        status: 'submitted',
        supervisorApprovalStatus: 'revision_requested',
        supervisorApprovalNote: 'tighten the methodology section',
        supervisorApprovalAt: new Date('2026-01-01'),
        meritRibbon: { rank: 2, of: 5, scope: 'x', at: '2026-01-01' },
      },
    ];
    const manager = {
      getRepository: () => ({
        findOne: jest.fn(() => Promise.resolve(rows[0] ?? null)),
        create: jest.fn((data: Record<string, unknown>) => ({ ...data })),
        save: jest.fn((row: Record<string, unknown>) => {
          rows[0] = row;
          return Promise.resolve(row);
        }),
      }),
    };
    const fypRepo = {
      manager: {
        transaction: jest.fn((fn: (m: unknown) => unknown) =>
          Promise.resolve(fn(manager)),
        ),
      },
    };
    const service = createService(
      {},
      fypRepo,
      {},
      makeInviteRepo(),
      {},
      {},
      {},
      { createNotification: jest.fn() },
      {},
      {},
    );
    jest.spyOn(service as any, 'syncFypInvites').mockResolvedValue(undefined);
    jest
      .spyOn(service as any, 'fypAnnotate')
      .mockImplementation((entries: unknown) => Promise.resolve(entries));

    const saved = await service.upsertFyp('student-1', {
      addedNote: 'fixed',
    });

    expect(saved.supervisorApprovalStatus).toBe('pending');
    expect(saved.supervisorApprovalAt).toBeNull();
    expect(saved.meritRibbon).toBeNull();
    expect(saved.supervisorApprovalNote).toBe(
      'tighten the methodology section',
    );
  });

  it('refuses to redirect an already-submitted entry to a different supervisorEmail', async () => {
    const rows: Record<string, unknown>[] = [
      {
        id: 'fyp-3',
        userId: 'student-1',
        status: 'submitted',
        projectInfo: { supervisorEmail: 'supA@test.com', title: 'Solar audit' },
      },
    ];
    const manager = {
      getRepository: () => ({
        findOne: jest.fn(() => Promise.resolve(rows[0] ?? null)),
        create: jest.fn((data: Record<string, unknown>) => ({ ...data })),
        save: jest.fn((row: Record<string, unknown>) => {
          rows[0] = row;
          return Promise.resolve(row);
        }),
      }),
    };
    const fypRepo = {
      manager: {
        transaction: jest.fn((fn: (m: unknown) => unknown) =>
          Promise.resolve(fn(manager)),
        ),
      },
    };
    const service = createService(
      {},
      fypRepo,
      {},
      makeInviteRepo(),
      {},
      {},
      {},
      { createNotification: jest.fn() },
      {},
      {},
    );
    jest.spyOn(service as any, 'syncFypInvites').mockResolvedValue(undefined);
    jest
      .spyOn(service as any, 'fypAnnotate')
      .mockImplementation((entries: unknown) => Promise.resolve(entries));

    // A raw API call attempting to hijack review to a different supervisor account.
    const saved = await service.upsertFyp('student-1', {
      projectInfo: { supervisorEmail: 'supB@test.com', title: 'Solar audit' },
    });

    expect(saved.projectInfo!.supervisorEmail).toBe('supA@test.com');
  });

  it('clears the stale aiAnalysis/aiAnalysisLock when a revision_requested entry is edited again', async () => {
    const rows: Record<string, unknown>[] = [
      {
        id: 'fyp-4',
        userId: 'student-1',
        status: 'submitted',
        supervisorApprovalStatus: 'revision_requested',
        projectInfo: { supervisorEmail: 'supA@test.com', title: 'Solar audit' },
        aiAnalysis: { dimensions: [], final: 42 },
        aiAnalysisLock: null,
      },
    ];
    const manager = {
      getRepository: () => ({
        findOne: jest.fn(() => Promise.resolve(rows[0] ?? null)),
        create: jest.fn((data: Record<string, unknown>) => ({ ...data })),
        save: jest.fn((row: Record<string, unknown>) => {
          rows[0] = row;
          return Promise.resolve(row);
        }),
      }),
    };
    const fypRepo = {
      manager: {
        transaction: jest.fn((fn: (m: unknown) => unknown) =>
          Promise.resolve(fn(manager)),
        ),
      },
    };
    const service = createService(
      {},
      fypRepo,
      {},
      makeInviteRepo(),
      {},
      {},
      {},
      { createNotification: jest.fn() },
      {},
      {},
    );
    jest.spyOn(service as any, 'syncFypInvites').mockResolvedValue(undefined);
    jest
      .spyOn(service as any, 'fypAnnotate')
      .mockImplementation((entries: unknown) => Promise.resolve(entries));

    const saved = await service.upsertFyp('student-1', {
      addedNote: 'fixed the methodology',
    });

    expect(saved.aiAnalysis).toBeNull();
    expect(saved.aiAnalysisLock).toBeNull();
  });
});

describe('PathsService — FYP submit readiness gate', () => {
  const makeDraftFypService = () => {
    const rows: Record<string, unknown>[] = [
      { id: 'fyp-draft-1', userId: 'student-1', status: 'draft' },
    ];
    const manager = {
      getRepository: () => ({
        findOne: jest.fn(() => Promise.resolve(rows[0] ?? null)),
        create: jest.fn((data: Record<string, unknown>) => ({ ...data })),
        save: jest.fn((row: Record<string, unknown>) => {
          rows[0] = row;
          return Promise.resolve(row);
        }),
      }),
    };
    const fypRepo = {
      manager: {
        transaction: jest.fn((fn: (m: unknown) => unknown) =>
          Promise.resolve(fn(manager)),
        ),
      },
    };
    const service = createService(
      {},
      fypRepo,
      {},
      makeInviteRepo(),
      {},
      {},
      {},
      { createNotification: jest.fn() },
      {},
      {},
    );
    jest.spyOn(service as any, 'syncFypInvites').mockResolvedValue(undefined);
    jest
      .spyOn(service as any, 'fypAnnotate')
      .mockImplementation((entries: unknown) => Promise.resolve(entries));
    return { service };
  };

  it('refuses to submit a draft with no supervisorEmail, so the record can never be orphaned', async () => {
    const { service } = makeDraftFypService();
    await expect(
      service.upsertFyp('student-1', {
        projectTitle: 'Solar audit',
        status: 'submitted',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses to submit a draft with no project title', async () => {
    const { service } = makeDraftFypService();
    await expect(
      service.upsertFyp('student-1', {
        projectInfo: { supervisorEmail: 'sup@test.com' },
        status: 'submitted',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('allows submitting once title and supervisorEmail are both present', async () => {
    const { service } = makeDraftFypService();
    const saved = await service.upsertFyp('student-1', {
      projectTitle: 'Solar audit',
      projectInfo: { supervisorEmail: 'sup@test.com' },
      status: 'submitted',
    });
    expect(saved.status).toBe('submitted');
  });

  it('does not gate a plain draft autosave that never sets status: submitted', async () => {
    const { service } = makeDraftFypService();
    const saved = await service.upsertFyp('student-1', {
      addedNote: 'still working on it',
    });
    expect(saved.addedNote).toBe('still working on it');
  });
});

describe('PathsService — FYP supervisor review', () => {
  const makeReviewService = () => {
    const notificationsService = {
      createNotification: jest.fn().mockResolvedValue(undefined),
    };
    const entry: Record<string, unknown> = {
      id: 'fyp-1',
      userId: 'student-1',
      status: 'submitted',
      projectTitle: 'Circular Economy Study',
      supervisorApprovalStatus: 'pending',
      projectInfo: {
        studentName: 'Ali Khan',
        supervisorEmail: 'supervisor@test.com',
      },
      meritRibbon: { rank: 1, of: 8, scope: 'x', at: '2026-01-01' },
    };
    const qb = {
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    const fypRepo = {
      findOne: jest.fn().mockResolvedValue(entry),
      save: jest.fn((row: Record<string, unknown>) => Promise.resolve(row)),
      createQueryBuilder: jest.fn(() => qb),
    };
    const usersRepo = {
      findOne: jest.fn().mockResolvedValue({ name: 'Ali Khan' }),
    };
    const service = createService(
      {},
      fypRepo,
      {},
      makeInviteRepo(),
      usersRepo,
      {},
      {},
      notificationsService,
      {},
      {},
    );
    return { service, notificationsService, fypRepo };
  };

  it('approve sets supervisorApprovalStatus=approved and notifies the student', async () => {
    const { service, notificationsService } = makeReviewService();
    const saved = await service.supervisorReviewFyp(
      'supervisor@test.com',
      'fyp-1',
      'approve',
    );
    expect(saved.supervisorApprovalStatus).toBe('approved');
    expect(notificationsService.createNotification).toHaveBeenCalledWith(
      'student-1',
      containing({ title: 'Your FYP was approved' }),
    );
  });

  it('revision sets supervisorApprovalStatus=revision_requested, clears the ribbon, and notifies the student', async () => {
    const { service, notificationsService } = makeReviewService();
    const saved = await service.supervisorReviewFyp(
      'supervisor@test.com',
      'fyp-1',
      'revision',
      'Add more evidence',
    );
    expect(saved.supervisorApprovalStatus).toBe('revision_requested');
    expect(saved.meritRibbon).toBeNull();
    expect(notificationsService.createNotification).toHaveBeenCalledWith(
      'student-1',
      containing({ title: 'Revision requested on your FYP' }),
    );
  });

  it('reject sets supervisorApprovalStatus=rejected and notifies the student', async () => {
    const { service, notificationsService } = makeReviewService();
    const saved = await service.supervisorReviewFyp(
      'supervisor@test.com',
      'fyp-1',
      'reject',
      'Not enough rigor',
    );
    expect(saved.supervisorApprovalStatus).toBe('rejected');
    expect(notificationsService.createNotification).toHaveBeenCalledWith(
      'student-1',
      containing({ title: 'Your FYP was rejected' }),
    );
  });

  it('refuses the decision when a concurrent approveFypAiAnalysis wins the lock first (0 rows affected)', async () => {
    const { service, fypRepo } = makeReviewService();
    fypRepo.createQueryBuilder().execute.mockResolvedValueOnce({
      affected: 0,
    });
    await expect(
      service.supervisorReviewFyp('supervisor@test.com', 'fyp-1', 'reject'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('PathsService — FYP teammate share + faculty in-progress', () => {
  const lead = {
    id: 'fyp-lead',
    userId: 'lead-1',
    status: 'draft',
    stepCompleted: 2,
    projectTitle: 'Shared thesis',
    projectInfo: { title: 'Shared thesis', supervisorEmail: 'sup@test.com' },
    deliverables: [
      {
        version: 1,
        label: 'draft.pdf',
        fileUrl: 'https://x/d.pdf',
        uploadedAt: '2026-01-01',
      },
    ],
  };
  const placeholderOwn = {
    id: 'fyp-shadow',
    userId: 'teammate-1',
    status: 'draft',
    stepCompleted: 0,
    projectTitle: null,
    projectInfo: {},
    deliverables: [],
  };

  function makeQb(shared: Record<string, unknown> | null) {
    const qb: Pick<FakeQueryBuilder, 'where' | 'orderBy' | 'getOne'> = {
      where: jest.fn(() => qb),
      orderBy: jest.fn(() => qb),
      getOne: jest.fn(() => Promise.resolve(shared)),
    };
    return qb;
  }

  const makeShareService = (opts: {
    own?: Record<string, unknown> | null;
    shared?: Record<string, unknown> | null;
    drafts?: Record<string, unknown>[];
  }) => {
    const fypRepo = {
      findOne: jest.fn(() => Promise.resolve(opts.own ?? null)),
      find: jest.fn(() => Promise.resolve(opts.drafts ?? [])),
      createQueryBuilder: jest.fn(() => makeQb(opts.shared ?? null)),
      manager: {
        transaction: jest.fn((fn: (m: unknown) => unknown) =>
          Promise.resolve(
            fn({
              getRepository: () => ({
                findOne: jest.fn(() => Promise.resolve(opts.own ?? null)),
                create: jest.fn((data: Record<string, unknown>) => ({
                  ...data,
                  id: 'new-fyp',
                })),
                save: jest.fn((row: Record<string, unknown>) =>
                  Promise.resolve(row),
                ),
              }),
            }),
          ),
        ),
      },
    };
    const usersRepo = {
      find: jest.fn(() =>
        Promise.resolve([
          { id: 'lead-1', name: 'Lead', email: 'lead@test.com' },
        ]),
      ),
      findOne: jest.fn(),
    };
    const service = createService(
      {},
      fypRepo,
      {},
      makeInviteRepo(),
      usersRepo,
      {},
      {},
      { createNotification: jest.fn() },
      {},
      {},
    );
    jest
      .spyOn(service as any, 'fypAnnotate')
      .mockImplementation((entries: unknown) => Promise.resolve(entries));
    jest.spyOn(service as any, 'syncFypInvites').mockResolvedValue(undefined);
    return { service, fypRepo };
  };

  it('getFyp returns the lead draft (isOwner:false) when the teammate has no row of their own', async () => {
    const { service } = makeShareService({ own: null, shared: lead });
    const result = await service.getFyp('teammate-1', 'teammate@test.com');
    expect(result).toEqual(containing({ id: 'fyp-lead', isOwner: false }));
  });

  it('getFyp prefers the shared lead record over an empty placeholder row of the teammate', async () => {
    const { service } = makeShareService({ own: placeholderOwn, shared: lead });
    const result = await service.getFyp('teammate-1', 'teammate@test.com');
    expect(result).toEqual(containing({ id: 'fyp-lead', isOwner: false }));
  });

  it("getFyp keeps a real own draft even if the student is also named on someone else's FYP", async () => {
    const ownReal = {
      ...placeholderOwn,
      projectTitle: 'My own thesis',
      stepCompleted: 1,
    };
    const { service } = makeShareService({ own: ownReal, shared: lead });
    const result = await service.getFyp('teammate-1', 'teammate@test.com');
    expect(result).toEqual(containing({ id: 'fyp-shadow', isOwner: true }));
  });

  it('upsertFyp refuses to create a shadow row for an accepted co-author', async () => {
    const { service, fypRepo } = makeShareService({ own: null, shared: lead });
    await expect(
      service.upsertFyp(
        'teammate-1',
        { addedNote: 'nope' },
        'teammate@test.com',
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(fypRepo.manager.transaction).not.toHaveBeenCalled();
  });

  it('upsertFyp still lets the lead (or a student with no shared FYP) save without an email argument', async () => {
    const { service } = makeShareService({
      own: { ...lead, userId: 'student-1' },
      shared: null,
    });
    const saved = await service.upsertFyp('student-1', {
      addedNote: 'ok',
    });
    expect(saved.addedNote).toBe('ok');
    expect(saved.isOwner).toBe(true);
  });

  it('listInProgressFypForTeacher returns only draft records naming that supervisor', async () => {
    const { service } = makeShareService({
      drafts: [
        lead,
        {
          ...lead,
          id: 'other',
          projectInfo: { supervisorEmail: 'someone@else.com' },
        },
      ],
    });
    const result = await service.listInProgressFypForTeacher('SUP@test.com');
    expect(result).toHaveLength(1);
    expect((result[0] as { id: string }).id).toBe('fyp-lead');
  });
});

describe('PathsService — FYP merit notify', () => {
  const makeNotifyService = () => {
    const notificationsService = {
      createNotification: jest.fn().mockResolvedValue(undefined),
    };
    const fypRepo = {
      findOne: jest.fn(),
      save: jest.fn((row: Record<string, unknown>) => Promise.resolve(row)),
    };
    const usersRepo = {
      findOne: jest.fn().mockResolvedValue({ email: 'student@test.com' }),
    };
    const graderRunRepo = makeGraderRunRepo();
    const service = createService(
      {},
      fypRepo,
      {},
      makeInviteRepo(),
      usersRepo,
      {},
      {},
      notificationsService,
      graderRunRepo,
      {},
    );
    return { service, notificationsService, fypRepo, graderRunRepo };
  };

  it('pins the UI rank on the FYP card and notifies the owner', async () => {
    const { service, notificationsService, fypRepo } = makeNotifyService();
    jest.spyOn(service, 'getFypMeritModel').mockResolvedValue({
      scope: { label: 'Faculty supervision' },
      entries: [{ id: 'fyp-1', rank: 1 }],
    } as unknown as FypMeritModel);
    fypRepo.findOne.mockResolvedValue({
      id: 'fyp-1',
      userId: 'student-1',
      projectTitle: 'Circular Economy Study',
      supervisorApprovalStatus: 'approved',
      projectInfo: { studentName: 'Ali Khan' },
    });

    const result = await service.notifyFypMeritRanks(
      { role: 'faculty', email: 'teacher@test.com' },
      {
        picks: [{ entryId: 'fyp-1', rank: 1, of: 5, total: 91 }],
        scopeLabel: 'Your cohort',
      },
    );

    expect(result.notified).toBe(1);
    expect(fypRepo.save).toHaveBeenCalledWith(
      containing({
        meritRibbon: containing({
          rank: 1,
          of: 5,
          scope: 'Your cohort',
          badgeLevel: 'Silver',
        }),
      }),
    );
    expect(notificationsService.createNotification).toHaveBeenCalledWith(
      'student-1',
      containing({ title: 'Your FYP ranked #1' }),
    );
  });

  it('does not spam a second notification when the same ribbon is already pinned', async () => {
    const { service, notificationsService, fypRepo } = makeNotifyService();
    jest.spyOn(service, 'getFypMeritModel').mockResolvedValue({
      scope: { label: 'Your cohort' },
      entries: [{ id: 'fyp-1', rank: 1 }],
    } as unknown as FypMeritModel);
    fypRepo.findOne.mockResolvedValue({
      id: 'fyp-1',
      userId: 'student-1',
      projectTitle: 'Circular Economy Study',
      supervisorApprovalStatus: 'approved',
      meritRibbon: {
        rank: 1,
        of: 5,
        scope: 'Your cohort',
        total: 91,
        at: '2026-01-01',
      },
    });

    const result = await service.notifyFypMeritRanks(
      { role: 'faculty', email: 'teacher@test.com' },
      {
        picks: [{ entryId: 'fyp-1', rank: 1, of: 5, total: 91 }],
        scopeLabel: 'Your cohort',
      },
    );

    expect(result.notified).toBe(1);
    expect(notificationsService.createNotification).not.toHaveBeenCalled();
  });
});

describe('PathsService — venture supervisor review', () => {
  const makeReviewService = () => {
    const notificationsService = {
      createNotification: jest.fn().mockResolvedValue(undefined),
    };
    const entry: Record<string, unknown> = {
      id: 'venture-1',
      userId: 'student-1',
      status: 'submitted',
      ventureName: 'EcoPack Pakistan',
      academicSetup: { supervisorEmail: 'supervisor@test.com' },
      reviewPipeline: { supervisorStatus: 'pending' },
      meritRibbon: { rank: 1, of: 8, scope: 'x', at: '2026-01-01' },
    };
    const ventureRepo = {
      findOne: jest.fn().mockResolvedValue(entry),
      save: jest.fn((row: Record<string, unknown>) => Promise.resolve(row)),
    };
    const usersRepo = {
      findOne: jest
        .fn()
        .mockImplementation(({ where }: { where: Record<string, unknown> }) =>
          Promise.resolve(
            where.email
              ? { name: 'Dr. Supervisor', email: 'supervisor@test.com' }
              : { name: 'Ali Khan' },
          ),
        ),
    };
    const service = createService(
      {},
      {},
      ventureRepo,
      makeInviteRepo(),
      usersRepo,
      {},
      {},
      notificationsService,
      {},
      {},
    );
    jest
      .spyOn(service as any, 'ventureAnnotate')
      .mockImplementation((entries: unknown) => Promise.resolve(entries));
    jest
      .spyOn(service as any, 'attachStudents')
      .mockImplementation((entries: unknown) => Promise.resolve(entries));
    jest
      .spyOn(service as any, 'withCompleteness')
      .mockImplementation((entry: unknown) => entry);
    return { service, notificationsService, ventureRepo };
  };

  it('approve sets reviewPipeline.supervisorStatus=approved and notifies the student', async () => {
    const { service, notificationsService } = makeReviewService();
    const saved = await service.supervisorReviewVenture(
      'supervisor@test.com',
      'venture-1',
      'approve',
    );
    expect(saved.reviewPipeline!.supervisorStatus).toBe('approved');
    expect(notificationsService.createNotification).toHaveBeenCalledWith(
      'student-1',
      containing({ title: 'Your venture was approved' }),
    );
  });

  it('revision keeps the existing revisions_requested meaning, clears the ribbon, and notifies the student', async () => {
    const { service, notificationsService } = makeReviewService();
    const saved = await service.supervisorReviewVenture(
      'supervisor@test.com',
      'venture-1',
      'revision',
      'Add traction evidence',
    );
    expect(saved.reviewPipeline!.supervisorStatus).toBe('revisions_requested');
    expect(saved.meritRibbon).toBeNull();
    expect(notificationsService.createNotification).toHaveBeenCalledWith(
      'student-1',
      containing({ title: 'Revision requested on your venture' }),
    );
  });

  it('reject sets a genuinely new terminal rejected state and notifies the student', async () => {
    const { service, notificationsService } = makeReviewService();
    const saved = await service.supervisorReviewVenture(
      'supervisor@test.com',
      'venture-1',
      'reject',
      'Not viable yet',
    );
    expect(saved.reviewPipeline!.supervisorStatus).toBe('rejected');
    expect(notificationsService.createNotification).toHaveBeenCalledWith(
      'student-1',
      containing({ title: 'Your venture was rejected' }),
    );
  });
});

describe('PathsService — venture faculty in-progress + self-certify', () => {
  it('listInProgressVenturesForTeacher returns only draft records naming that supervisor', async () => {
    const drafts = [
      {
        id: 'v-1',
        status: 'draft',
        academicSetup: { supervisorEmail: 'sup@test.com' },
        ventureName: 'Mine',
      },
      {
        id: 'v-2',
        status: 'draft',
        academicSetup: { supervisorEmail: 'other@test.com' },
        ventureName: 'Other',
      },
    ];
    const ventureRepo = {
      find: jest.fn().mockResolvedValue(drafts),
    };
    const usersRepo = {
      findOne: jest
        .fn()
        .mockResolvedValue({ name: 'Dr. Supervisor', email: 'sup@test.com' }),
    };
    const service = createService(
      {},
      {},
      ventureRepo,
      makeInviteRepo(),
      usersRepo,
      {},
      {},
      { createNotification: jest.fn() },
      {},
      {},
    );
    jest
      .spyOn(service as any, 'ventureAnnotate')
      .mockImplementation((entries: unknown) => Promise.resolve(entries));
    jest
      .spyOn(service as any, 'attachStudents')
      .mockImplementation((entries: unknown) => Promise.resolve(entries));
    jest
      .spyOn(service as any, 'withCompleteness')
      .mockImplementation((entry: unknown) => entry);
    const result =
      await service.listInProgressVenturesForTeacher('SUP@test.com');
    expect(result.map((e) => e.id)).toEqual(['v-1']);
  });

  it('selfCertifyOwnVenture submits and approves the owner record', async () => {
    const entry: Record<string, unknown> = {
      id: 'v-own',
      userId: 'faculty-1',
      status: 'draft',
      reviewPipeline: { supervisorStatus: 'not_started' },
    };
    const ventureRepo = {
      findOne: jest.fn().mockResolvedValue(entry),
      save: jest.fn((row: Record<string, unknown>) => Promise.resolve(row)),
    };
    const service = createService(
      {},
      {},
      ventureRepo,
      makeInviteRepo(),
      {},
      {},
      {},
      { createNotification: jest.fn() },
      {},
      {},
    );
    jest
      .spyOn(service as any, 'ventureAnnotate')
      .mockImplementation((entries: unknown) => Promise.resolve(entries));
    jest
      .spyOn(service as any, 'withCompleteness')
      .mockImplementation((entry: unknown) => entry);
    const saved = await service.selfCertifyOwnVenture('faculty-1');
    expect(saved!.status).toBe('submitted');
    expect(saved!.reviewPipeline!.supervisorStatus).toBe('approved');
  });
});

describe('PathsService — university + CIEL venture network', () => {
  it('listVenturesForUniversity returns empty when the org is missing', async () => {
    const organizationsRepo = { findOne: jest.fn().mockResolvedValue(null) };
    const service = createService(
      {},
      {},
      {},
      makeInviteRepo(),
      {},
      organizationsRepo,
      {},
      { createNotification: jest.fn() },
      {},
      {},
    );
    await expect(
      service.listVenturesForUniversity('org-missing'),
    ).resolves.toEqual([]);
    await expect(service.listVenturesForUniversity('')).resolves.toEqual([]);
  });

  it('listVenturesForUniversity scopes by organizationId or academicSetup.university', async () => {
    const qb = {
      leftJoin: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      getMany: jest
        .fn()
        .mockResolvedValue([{ id: 'v-1', status: 'submitted' }]),
    };
    const ventureRepo = { createQueryBuilder: jest.fn().mockReturnValue(qb) };
    const organizationsRepo = {
      findOne: jest.fn().mockResolvedValue({
        id: 'org-1',
        name: 'Beaconhouse National University',
      }),
    };
    const service = createService(
      {},
      {},
      ventureRepo,
      makeInviteRepo(),
      {},
      organizationsRepo,
      {},
      { createNotification: jest.fn() },
      {},
      {},
    );
    jest
      .spyOn(service as any, 'ventureAnnotate')
      .mockImplementation((entries: unknown) => Promise.resolve(entries));
    jest
      .spyOn(service as any, 'attachStudents')
      .mockImplementation((entries: unknown) => Promise.resolve(entries));
    jest
      .spyOn(service as any, 'withCompleteness')
      .mockImplementation((entry: unknown) => entry);
    const result = await service.listVenturesForUniversity(
      'org-1',
      'submitted',
    );
    expect(ventureRepo.createQueryBuilder).toHaveBeenCalledWith('e');
    expect(qb.where).toHaveBeenCalledWith('e.status = :status', {
      status: 'submitted',
    });
    expect(result.map((e) => e.id)).toEqual(['v-1']);
  });

  it('getVentureMeritModel uses the university org pool for university callers', async () => {
    const organizationsRepo = {
      findOne: jest.fn().mockResolvedValue({ id: 'org-1', name: 'BNU' }),
    };
    const service = createService(
      {},
      {},
      {},
      makeInviteRepo(),
      {},
      organizationsRepo,
      {},
      { createNotification: jest.fn() },
      { findOne: jest.fn().mockResolvedValue(null) },
      {},
    );
    const listSpy = jest
      .spyOn(service, 'listVenturesForUniversity')
      .mockResolvedValue([
        {
          id: 'v-ok',
          status: 'submitted',
          reviewPipeline: { supervisorStatus: 'approved' },
          student: { name: 'Fatima' },
        },
      ] as unknown as UniversityVentures);
    const result = await service.getVentureMeritModel({
      role: 'university',
      email: 'oric@bnu.edu',
      organizationId: 'org-1',
    });
    expect(listSpy).toHaveBeenCalledWith('org-1');
    expect(result.scope.label).toBe('BNU');
    expect(result.count).toBe(1);
  });

  it('setVentureSpotlight only flips publishSettings.featured', async () => {
    const entry: Record<string, unknown> = {
      id: 'v-1',
      userId: 'student-1',
      publishSettings: { audience: 'investors', acceptIntros: true },
    };
    const ventureRepo = {
      findOne: jest.fn().mockResolvedValue(entry),
      save: jest.fn((row: Record<string, unknown>) => Promise.resolve(row)),
    };
    const service = createService(
      {},
      {},
      ventureRepo,
      makeInviteRepo(),
      {},
      {},
      {},
      { createNotification: jest.fn() },
      {},
      {},
    );
    jest
      .spyOn(service as any, 'ventureAnnotate')
      .mockImplementation((entries: unknown) => Promise.resolve(entries));
    jest
      .spyOn(service as any, 'attachStudents')
      .mockImplementation((entries: unknown) => Promise.resolve(entries));
    const saved = await service.setVentureSpotlight('v-1', true);
    expect(saved.publishSettings!.featured).toBe(true);
    expect(saved.publishSettings!.audience).toBe('investors');
  });
});

describe('PathsService — venture merit notify', () => {
  const makeNotifyService = () => {
    const notificationsService = {
      createNotification: jest.fn().mockResolvedValue(undefined),
    };
    const ventureRepo = {
      findOne: jest.fn(),
      save: jest.fn((row: Record<string, unknown>) => Promise.resolve(row)),
    };
    const usersRepo = {
      findOne: jest.fn().mockResolvedValue({ name: 'Ali Khan' }),
    };
    const graderRunRepo = makeGraderRunRepo();
    const service = createService(
      {},
      {},
      ventureRepo,
      makeInviteRepo(),
      usersRepo,
      {},
      {},
      notificationsService,
      graderRunRepo,
      {},
    );
    return { service, notificationsService, ventureRepo, graderRunRepo };
  };

  it('pins the UI rank on the venture card and notifies the owner', async () => {
    const { service, notificationsService, ventureRepo } = makeNotifyService();
    jest.spyOn(service, 'getVentureMeritModel').mockResolvedValue({
      scope: { label: 'Faculty supervision' },
      entries: [{ id: 'venture-1', rank: 1 }],
    } as unknown as VentureMeritModel);
    ventureRepo.findOne.mockResolvedValue({
      id: 'venture-1',
      userId: 'student-1',
      ventureName: 'EcoPack Pakistan',
      reviewPipeline: { supervisorStatus: 'approved' },
    });

    const result = await service.notifyVentureMeritRanks(
      { role: 'faculty', email: 'teacher@test.com' },
      {
        picks: [{ entryId: 'venture-1', rank: 1, of: 5, total: 91 }],
        scopeLabel: 'Your cohort',
      },
    );

    expect(result.notified).toBe(1);
    expect(ventureRepo.save).toHaveBeenCalledWith(
      containing({
        meritRibbon: containing({
          rank: 1,
          of: 5,
          scope: 'Your cohort',
          badgeLevel: 'Silver',
        }),
      }),
    );
    expect(notificationsService.createNotification).toHaveBeenCalledWith(
      'student-1',
      containing({ title: 'Your venture ranked #1' }),
    );
  });

  it('does not rank an entry whose supervisor status is not approved', async () => {
    const { service, notificationsService, ventureRepo } = makeNotifyService();
    jest.spyOn(service, 'getVentureMeritModel').mockResolvedValue({
      scope: { label: 'Faculty supervision' },
      entries: [{ id: 'venture-1', rank: 1 }],
    } as unknown as VentureMeritModel);
    ventureRepo.findOne.mockResolvedValue({
      id: 'venture-1',
      userId: 'student-1',
      ventureName: 'EcoPack Pakistan',
      reviewPipeline: { supervisorStatus: 'revisions_requested' },
    });

    const result = await service.notifyVentureMeritRanks(
      { role: 'faculty', email: 'teacher@test.com' },
      {
        picks: [{ entryId: 'venture-1', rank: 1, of: 5, total: 91 }],
        scopeLabel: 'Your cohort',
      },
    );

    expect(result.notified).toBe(0);
    expect(notificationsService.createNotification).not.toHaveBeenCalled();
  });
});

describe('PathsService — grader run limit is independent per path', () => {
  it("exhausting coursework runs for a faculty email does not block that same email's FYP runs", async () => {
    const graderRunRepo = makeGraderRunRepo();
    const notificationsService = {
      createNotification: jest.fn().mockResolvedValue(undefined),
    };
    const courseProjectRepo = {
      findOne: jest.fn().mockResolvedValue({
        id: 'entry-1',
        userId: 'student-1',
        projectTitle: 'x',
        facultyApprovalStatus: 'approved',
      }),
      save: jest.fn((row: Record<string, unknown>) => Promise.resolve(row)),
    };
    const fypRepo = {
      findOne: jest.fn().mockResolvedValue({
        id: 'fyp-1',
        userId: 'student-1',
        projectTitle: 'x',
        supervisorApprovalStatus: 'approved',
      }),
      save: jest.fn((row: Record<string, unknown>) => Promise.resolve(row)),
    };
    const usersRepo = {
      findOne: jest
        .fn()
        .mockResolvedValue({ email: 'student@test.com', name: 'Student' }),
    };
    const mailService = {
      sendCourseworkRankNotification: jest.fn().mockResolvedValue(undefined),
    };
    const service = createService(
      courseProjectRepo,
      fypRepo,
      {},
      makeInviteRepo(),
      usersRepo,
      {},
      mailService,
      notificationsService,
      graderRunRepo,
      {},
    );
    const user = { role: 'faculty', email: 'teacher@test.com' };
    jest.spyOn(service, 'getCourseProjectMeritModel').mockResolvedValue({
      scope: { label: 'x' },
      entries: [{ id: 'entry-1', rank: 1 }],
    } as unknown as CourseworkMeritModel);
    jest.spyOn(service, 'getFypMeritModel').mockResolvedValue({
      scope: { label: 'x' },
      entries: [{ id: 'fyp-1', rank: 1 }],
    } as unknown as FypMeritModel);

    const coursePick = {
      picks: [{ entryId: 'entry-1', rank: 1, of: 5, total: 90 }],
    };
    await service.notifyCourseProjectMeritRanks(
      user as MeritModelUser,
      coursePick,
    );
    await service.notifyCourseProjectMeritRanks(
      user as MeritModelUser,
      coursePick,
    );
    await service.notifyCourseProjectMeritRanks(
      user as MeritModelUser,
      coursePick,
    );
    await expect(
      service.notifyCourseProjectMeritRanks(user as MeritModelUser, coursePick),
    ).rejects.toBeDefined();

    const fypResult = await service.notifyFypMeritRanks(
      user as MeritModelUser,
      { picks: [{ entryId: 'fyp-1', rank: 1, of: 5, total: 90 }] },
    );
    expect(fypResult.graderRuns).toEqual({
      unlimited: false,
      used: 1,
      limit: 3,
    });
  });
});

describe('PathsService — venture reviewPipeline forgery guard', () => {
  const makeUpsertVentureService = (
    initialEntry: Record<string, unknown> | null,
  ) => {
    const rows: Record<string, unknown>[] = initialEntry ? [initialEntry] : [];
    const manager = {
      getRepository: () => ({
        findOne: jest.fn(() => Promise.resolve(rows[0] ?? null)),
        create: jest.fn((data: Record<string, unknown>) => ({ ...data })),
        save: jest.fn((row: Record<string, unknown>) => {
          rows[0] = row;
          return Promise.resolve(row);
        }),
      }),
    };
    const service = createService(
      {},
      {},
      {
        manager: {
          transaction: jest.fn((fn: (m: unknown) => unknown) =>
            Promise.resolve(fn(manager)),
          ),
        },
      },
      makeInviteRepo(),
      {},
      {},
      {},
      { createNotification: jest.fn() },
      {},
      {},
    );
    jest
      .spyOn(service as any, 'syncVentureInvites')
      .mockResolvedValue(undefined);
    jest
      .spyOn(service as any, 'ventureAnnotate')
      .mockImplementation((entries: unknown) => Promise.resolve(entries));
    jest
      .spyOn(service as any, 'withCompleteness')
      .mockImplementation((entry: unknown) => entry);
    return { service, rows };
  };

  it('never persists a client-forged terminal supervisorStatus, even while the venture stays a draft', async () => {
    const { service, rows } = makeUpsertVentureService({
      id: 'v-1',
      userId: 'student-1',
      status: 'draft',
      reviewPipeline: { supervisorStatus: 'not_started' },
    });

    await service.upsertVenture('student-1', {
      status: 'draft',
      reviewPipeline: { supervisorStatus: 'approved' },
    });

    expect((rows[0] as SavedRow).reviewPipeline.supervisorStatus).toBe(
      'not_started',
    );
  });

  it('still lets the student legitimately move reviewPipeline back to pending on submit', async () => {
    const { service, rows } = makeUpsertVentureService({
      id: 'v-1',
      userId: 'student-1',
      status: 'draft',
      reviewPipeline: { supervisorStatus: 'not_started' },
    });

    await service.upsertVenture('student-1', {
      status: 'submitted',
      reviewPipeline: { supervisorStatus: 'pending' },
    });

    expect((rows[0] as SavedRow).reviewPipeline.supervisorStatus).toBe(
      'pending',
    );
    expect((rows[0] as SavedRow).status).toBe('submitted');
  });

  it('still resets a genuinely-approved venture back to pending on resubmit-after-edit', async () => {
    const { service, rows } = makeUpsertVentureService({
      id: 'v-1',
      userId: 'student-1',
      status: 'submitted',
      reviewPipeline: { supervisorStatus: 'approved' },
      meritRibbon: { rank: 1, of: 5 },
    });

    await service.upsertVenture('student-1', { ventureName: 'Renamed' });

    expect((rows[0] as SavedRow).reviewPipeline.supervisorStatus).toBe(
      'pending',
    );
    expect((rows[0] as SavedRow).meritRibbon).toBeNull();
  });

  it('does not un-approve a venture when the student only toggles investor-track consent', async () => {
    const { service, rows } = makeUpsertVentureService({
      id: 'v-1',
      userId: 'student-1',
      status: 'submitted',
      reviewPipeline: { supervisorStatus: 'approved' },
      meritRibbon: { rank: 1, of: 5 },
      publishSettings: { audience: 'investors', acceptIntros: true },
    });

    await service.upsertVenture('student-1', {
      publishSettings: { audience: 'university', acceptIntros: false },
    });

    expect((rows[0] as SavedRow).reviewPipeline.supervisorStatus).toBe(
      'approved',
    );
    expect((rows[0] as SavedRow).meritRibbon).toEqual({ rank: 1, of: 5 });
    expect((rows[0] as SavedRow).publishSettings.acceptIntros).toBe(false);
  });

  it('refuses to redirect an already-submitted venture to a different supervisorEmail', async () => {
    const { service, rows } = makeUpsertVentureService({
      id: 'v-1',
      userId: 'student-1',
      status: 'submitted',
      academicSetup: {
        supervisorEmail: 'supA@test.com',
        supervisorName: 'Dr A',
      },
    });

    // A raw API call attempting to hijack review to a different supervisor account.
    await service.upsertVenture('student-1', {
      academicSetup: {
        supervisorEmail: 'supB@test.com',
        supervisorName: 'Dr B',
      },
    });

    expect((rows[0] as SavedRow).academicSetup.supervisorEmail).toBe(
      'supA@test.com',
    );
    expect((rows[0] as SavedRow).academicSetup.supervisorName).toBe('Dr A');
  });
});

describe('PathsService — listVenturesForAdmin excludes drafts from decision-status queries', () => {
  const makeAdminListService = (
    qbOverrides: Partial<Record<string, unknown>> = {},
  ) => {
    const qb = {
      orderBy: jest.fn().mockReturnThis(),
      andWhere: jest.fn<unknown, unknown[]>().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([]),
      ...qbOverrides,
    };
    const ventureRepo = { createQueryBuilder: jest.fn().mockReturnValue(qb) };
    const service = createService(
      {},
      {},
      ventureRepo,
      makeInviteRepo(),
      {},
      {},
      {},
      { createNotification: jest.fn() },
      {},
      {},
    );
    jest
      .spyOn(service as any, 'ventureAnnotate')
      .mockImplementation((entries: unknown) => Promise.resolve(entries));
    jest
      .spyOn(service as any, 'attachStudents')
      .mockImplementation((entries: unknown) => Promise.resolve(entries));
    return { service, qb };
  };

  it('requires status=submitted alongside an approved/rejected/revisions_requested filter', async () => {
    const { service, qb } = makeAdminListService();
    await service.listVenturesForAdmin(undefined, 'approved');
    const andWhereCalls: unknown[][] = qb.andWhere.mock.calls;
    const statusFilterCalls = andWhereCalls.filter((call) =>
      String(call[0]).includes('e.status'),
    );
    expect(statusFilterCalls).toHaveLength(1);
    expect(statusFilterCalls[0][0]).toContain("'submitted'");
  });

  it('does not add the submitted-only filter for not_started (still-draft rows are the point)', async () => {
    const { service, qb } = makeAdminListService();
    await service.listVenturesForAdmin(undefined, 'not_started');
    const andWhereCalls: unknown[][] = qb.andWhere.mock.calls;
    const statusFilterCalls = andWhereCalls.filter((call) =>
      String(call[0]).includes('e.status'),
    );
    expect(statusFilterCalls).toHaveLength(0);
  });
});

describe('PathsService.remindCourseProjectFaculty — student nudges the reviewing faculty', () => {
  const build = (
    entryOverrides: Record<string, unknown> = {},
    mailOk = true,
  ) => {
    const entry: Record<string, unknown> = {
      id: 'entry-1',
      userId: 'stu-1',
      status: 'submitted',
      facultyApprovalStatus: 'pending',
      facultyReminderSentAt: null,
      projectTitle: 'Network Audit',
      course: 'Computer Networking',
      updatedAt: new Date(Date.now() - 3 * 86_400_000),
      studentInfo: {
        studentName: 'Zubair Ali',
        teacherName: 'Dr Khan',
        teacherEmail: 'khan@uni.edu.pk',
      },
      ...entryOverrides,
    };
    const courseProjectRepo = {
      findOne: jest.fn().mockResolvedValue(entry),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      save: jest.fn((row: Record<string, unknown>) => Promise.resolve(row)),
    };
    const mailService = {
      sendCourseworkReviewReminder: jest.fn().mockResolvedValue(mailOk),
    };
    const service = createService(
      courseProjectRepo,
      { findOne: jest.fn().mockResolvedValue(null) },
      { findOne: jest.fn().mockResolvedValue(null) },
      { findOne: jest.fn().mockResolvedValue(null) },
      { findOne: jest.fn().mockResolvedValue(null) },
      {},
      mailService,
      { createNotification: jest.fn() },
      {},
      {},
    );
    return { service, entry, courseProjectRepo, mailService };
  };

  it('emails the instructor from CIEL PK, stamps the send time, and reports the recipient', async () => {
    const { service, courseProjectRepo, mailService } = build();
    const res = await service.remindCourseProjectFaculty('stu-1', 'entry-1');
    expect(res.sent).toBe(true);
    expect(res.to).toBe('khan@uni.edu.pk');
    expect(mailService.sendCourseworkReviewReminder).toHaveBeenCalledWith(
      'khan@uni.edu.pk',
      'Zubair Ali',
      'Network Audit',
      'Dr Khan',
      expect.any(Date),
    );
    expect(courseProjectRepo.update).toHaveBeenCalledWith(
      { id: 'entry-1' },
      { facultyReminderSentAt: expect.any(Date) as unknown },
    );
  });

  it('refuses a second reminder inside 24 hours and says when the next one is allowed', async () => {
    const { service, mailService } = build({
      facultyReminderSentAt: new Date(Date.now() - 2 * 3_600_000),
    });
    await expect(
      service.remindCourseProjectFaculty('stu-1', 'entry-1'),
    ).rejects.toThrow(/last 24 hours/);
    expect(mailService.sendCourseworkReviewReminder).not.toHaveBeenCalled();
  });

  it('allows a reminder again once 24 hours have passed', async () => {
    const { service, mailService } = build({
      facultyReminderSentAt: new Date(Date.now() - 25 * 3_600_000),
    });
    await expect(
      service.remindCourseProjectFaculty('stu-1', 'entry-1'),
    ).resolves.toMatchObject({ sent: true });
    expect(mailService.sendCourseworkReviewReminder).toHaveBeenCalledTimes(1);
  });

  it('refuses when the record is a draft, already approved, or already answered', async () => {
    await expect(
      build({ status: 'draft' }).service.remindCourseProjectFaculty(
        'stu-1',
        'entry-1',
      ),
    ).rejects.toThrow(/Submit the record/);
    await expect(
      build({
        facultyApprovalStatus: 'approved',
      }).service.remindCourseProjectFaculty('stu-1', 'entry-1'),
    ).rejects.toThrow(/already been approved/);
    await expect(
      build({
        facultyApprovalStatus: 'revision_requested',
      }).service.remindCourseProjectFaculty('stu-1', 'entry-1'),
    ).rejects.toThrow(/already responded/);
  });

  it('refuses without an instructor email, and a stranger gets 404', async () => {
    await expect(
      build({
        studentInfo: { studentName: 'Z' },
      }).service.remindCourseProjectFaculty('stu-1', 'entry-1'),
    ).rejects.toThrow(/No instructor email/);
    await expect(
      build().service.remindCourseProjectFaculty('someone-else', 'entry-1'),
    ).rejects.toThrow(/not found/);
  });

  it('surfaces a delivery failure instead of pretending it was sent, and does not stamp the time', async () => {
    const { service, courseProjectRepo } = build({}, false);
    await expect(
      service.remindCourseProjectFaculty('stu-1', 'entry-1'),
    ).rejects.toThrow(/could not deliver/);
    expect(courseProjectRepo.update).not.toHaveBeenCalled();
  });
});
