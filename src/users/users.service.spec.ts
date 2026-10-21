import { BadRequestException, ConflictException } from '@nestjs/common';
import { Repository } from 'typeorm';
import {
  UsersService,
  escapeLikePattern,
  hashResetToken,
} from './users.service';
import { User } from './entities/user.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { OrganizationMembershipService } from '../organization-membership/organization-membership.service';
import { StudentSubscriptionService } from '../student-subscription/student-subscription.service';
import { encryptPasswordRecord } from './password-record.util';

type UserRow = Record<string, unknown>;

/** Mocked `Repository<User>` surface used by these tests; `_qb` exposes the query-builder mock. */
type RepoMock = {
  createQueryBuilder?: jest.Mock;
  create?: jest.Mock<UserRow, [UserRow]>;
  save?: jest.Mock<Promise<UserRow>, [UserRow]>;
  findOne?: jest.Mock;
  update?: jest.Mock<Promise<unknown>, [string, UserRow]>;
  increment?: jest.Mock;
  count?: jest.Mock;
  delete?: jest.Mock;
  _qb?: Record<string, jest.Mock>;
};

function build(repo: RepoMock) {
  return new UsersService(
    repo as unknown as Repository<User>,
    {} as NotificationsService,
    {} as OrganizationMembershipService,
    {
      getUiFlags: jest.fn().mockResolvedValue({}),
    } as unknown as StudentSubscriptionService,
  );
}
function repoMock(overrides: RepoMock = {}) {
  const qb = {
    leftJoinAndSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    getOne: jest.fn().mockResolvedValue(null),
  };
  return {
    createQueryBuilder: jest.fn().mockReturnValue(qb),
    create: jest.fn((x: UserRow) => x),
    save: jest.fn<Promise<UserRow>, [UserRow]>((x) =>
      Promise.resolve({ id: 'new', ...x }),
    ),
    findOne: jest.fn(),
    update: jest.fn(),
    increment: jest.fn(),
    count: jest.fn(),
    delete: jest.fn(),
    ...overrides,
    _qb: qb,
  };
}

describe('UsersService', () => {
  it('escapes ILIKE wildcards', () => {
    expect(escapeLikePattern('50%_a\\')).toBe('50\\%\\_a\\\\');
  });

  it('create lowercases email, hashes password and writes encrypted passwordRecord', async () => {
    const repo = repoMock();
    const saved = await build(repo).create({
      name: 'A',
      email: '  A@B.C ',
      password: 'password1',
      role: 'student',
    } as unknown as Parameters<UsersService['create']>[0]);
    expect(saved.email).toBe('a@b.c');
    expect(saved.password).not.toBe('password1');
    expect(typeof saved.passwordRecord).toBe('string');
    expect(saved.passwordRecord).toContain(':');
    expect(saved.passwordRecord).not.toBe('password1');
  });

  it('create returns 409 on duplicate email', async () => {
    const repo = repoMock();
    repo._qb.getOne.mockResolvedValue({ id: 'x' });
    await expect(
      build(repo).create({
        email: 'a@b.c',
        password: 'password1',
      } as unknown as Parameters<UsersService['create']>[0]),
    ).rejects.toThrow(ConflictException);
  });

  it('update bumps tokenVersion on role/status change only', async () => {
    const repo = repoMock();
    repo.findOne.mockResolvedValue({
      id: 'u',
      role: 'student',
      status: 'active',
    });
    const svc = build(repo);
    await svc.update('u', { status: 'active' });
    expect(repo.increment).not.toHaveBeenCalled();
    await svc.update('u', { status: 'suspended' });
    expect(repo.increment).toHaveBeenCalledWith({ id: 'u' }, 'tokenVersion', 1);
  });

  it('blocks self role/status change when actorId given', async () => {
    const repo = repoMock();
    repo.findOne.mockResolvedValue({
      id: 'u',
      role: 'admin',
      status: 'active',
    });
    await expect(
      build(repo).update('u', { role: 'student' }, 'u'),
    ).rejects.toThrow(BadRequestException);
  });

  it('remove blocks self, last admin, and maps FK errors to 409', async () => {
    const repo = repoMock();
    const svc = build(repo);
    await expect(svc.remove('u', 'u')).rejects.toThrow(BadRequestException);
    repo.findOne.mockResolvedValue({ id: 'a', role: 'admin' });
    repo.count.mockResolvedValue(1);
    await expect(svc.remove('a', 'other')).rejects.toThrow(ConflictException);
    repo.findOne.mockResolvedValue({ id: 's', role: 'student' });
    repo.delete.mockRejectedValue({ code: '23503' });
    await expect(svc.remove('s', 'other')).rejects.toThrow(ConflictException);
  });
});

describe('UsersService — password reset tokens are stored hashed', () => {
  it('savePasswordResetToken persists the SHA-256 hash, never the raw token', async () => {
    const update = jest.fn<Promise<unknown>, [string, UserRow]>();
    const repo: RepoMock = { update };
    await build(repo).savePasswordResetToken('u1', 'raw-token-abc', new Date());
    const patch = update.mock.calls[0][1];
    expect(patch.passwordResetToken).toBe(hashResetToken('raw-token-abc'));
    expect(patch.passwordResetToken).not.toContain('raw-token-abc');
    expect(patch.passwordResetToken).toMatch(/^[a-f0-9]{64}$/);
  });

  it('findByResetToken looks up by hash and refuses empty tokens (cannot match a null/empty column)', async () => {
    const findOne = jest.fn().mockResolvedValue({ id: 'u1' });
    const repo: RepoMock = { findOne };
    const svc = build(repo);
    await svc.findByResetToken('raw-token-abc');
    expect(findOne).toHaveBeenCalledWith({
      where: { passwordResetToken: hashResetToken('raw-token-abc') },
    });
    findOne.mockClear();
    expect(await svc.findByResetToken('')).toBeNull();
    expect(await svc.findByResetToken('   ')).toBeNull();
    expect(findOne).not.toHaveBeenCalled();
  });
});

describe('UsersService — admin list filters', () => {
  function listRepo(rows: UserRow[]) {
    const qb = {
      leftJoin: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      andWhere: jest.fn<unknown, [string, ...unknown[]]>().mockReturnThis(),
      getManyAndCount: jest.fn().mockResolvedValue([rows, rows.length]),
    };
    return {
      createQueryBuilder: jest.fn().mockReturnValue(qb),
      _qb: qb,
    };
  }

  it('filters by status and expands search across university fields', async () => {
    const repo = listRepo([
      {
        id: '1',
        name: 'A',
        email: 'a@b.c',
        role: 'student',
        status: 'active',
        university: 'BNU',
      },
    ]);
    await build(repo).findAllForAdmin({
      page: 1,
      limit: 10,
      status: 'active',
      search: 'BNU',
    });
    const sql = repo._qb.andWhere.mock.calls.map((c) => c[0]).join(' ');
    expect(sql).toContain('user.status = :status');
    expect(sql).toContain('user.university ILIKE :search');
  });

  it('returns stored_password only when revealPasswordRecords is on', async () => {
    const rows = [
      {
        id: '1',
        name: 'A',
        email: 'a@b.c',
        role: 'student',
        status: 'active',
        password: 'hash',
        passwordRecord: encryptPasswordRecord('secret1234'),
      },
    ];
    type AdminRow = { stored_password?: string; password?: string };
    const hidden = await build(listRepo(rows)).findAllForAdmin({
      page: 1,
      limit: 10,
    });
    expect((hidden.data[0] as AdminRow).stored_password).toBeUndefined();
    const shown = await build(listRepo(rows)).findAllForAdmin({
      page: 1,
      limit: 10,
      revealPasswordRecords: true,
    });
    expect((shown.data[0] as AdminRow).stored_password).toBe('secret1234');
    expect((shown.data[0] as AdminRow).password).toBeUndefined();
  });
});

describe('UsersService — student institution/programme set once', () => {
  type ProfileUser = {
    id: string;
    role: string;
    institution?: string | null;
    university?: string | null;
    department?: string | null;
    faculty_department?: string | null;
  };
  const setup = (user: ProfileUser) => {
    const repo = repoMock();
    repo.findOne.mockResolvedValue(user);
    repo.save.mockImplementation((x: UserRow) => Promise.resolve(x));
    const svc = build(repo);
    svc.formatUserResponse = jest.fn().mockResolvedValue({});
    return { repo, svc };
  };

  it('lets a student with no university/programme set them', async () => {
    const user: ProfileUser = {
      id: 's',
      role: 'student',
      institution: '',
      university: null,
      department: '',
    };
    const { svc } = setup(user);
    await svc.updateGenericProfile('s', {
      institution: 'BNU',
      university: 'BNU',
      department: 'BS CS',
    });
    expect([user.institution, user.university, user.department]).toEqual([
      'BNU',
      'BNU',
      'BS CS',
    ]);
  });

  it('ignores changes once a student already has them', async () => {
    const user: ProfileUser = {
      id: 's',
      role: 'student',
      institution: 'BNU',
      university: 'BNU',
      department: 'BS CS',
      faculty_department: 'BS CS',
    };
    const { svc } = setup(user);
    await svc.updateGenericProfile('s', {
      institution: 'LUMS',
      university: 'LUMS',
      department: 'BBA',
      faculty_department: 'BBA',
    });
    expect([
      user.institution,
      user.university,
      user.department,
      user.faculty_department,
    ]).toEqual(['BNU', 'BNU', 'BS CS', 'BS CS']);
  });

  it('still lets an admin change them', async () => {
    const user: ProfileUser = {
      id: 's',
      role: 'student',
      institution: 'BNU',
      department: 'BS CS',
    };
    const { svc } = setup(user);
    await svc.updateGenericProfile(
      's',
      { institution: 'LUMS', department: 'BBA' },
      { isAdminCaller: true },
    );
    expect([user.institution, user.department]).toEqual(['LUMS', 'BBA']);
  });
});
