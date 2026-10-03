import { BadRequestException, ConflictException } from '@nestjs/common';
import { UsersService, escapeLikePattern, hashResetToken } from './users.service';

function build(repo: any) {
  return new UsersService(repo, {} as any, {} as any);
}
function repoMock(overrides: any = {}) {
  const qb = { leftJoinAndSelect: jest.fn().mockReturnThis(), where: jest.fn().mockReturnThis(), getOne: jest.fn().mockResolvedValue(null) };
  return {
    createQueryBuilder: jest.fn().mockReturnValue(qb),
    create: jest.fn((x) => x),
    save: jest.fn(async (x) => ({ id: 'new', ...x })),
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

  it('create lowercases email, hashes password and never writes passwordRecord', async () => {
    const repo = repoMock();
    const saved = await build(repo).create({ name: 'A', email: '  A@B.C ', password: 'password1', role: 'student' } as any);
    expect(saved.email).toBe('a@b.c');
    expect(saved.password).not.toBe('password1');
    expect((saved as any).passwordRecord).toBeUndefined();
  });

  it('create returns 409 on duplicate email', async () => {
    const repo = repoMock();
    repo._qb.getOne.mockResolvedValue({ id: 'x' });
    await expect(build(repo).create({ email: 'a@b.c', password: 'password1' } as any)).rejects.toThrow(ConflictException);
  });

  it('update bumps tokenVersion on role/status change only', async () => {
    const repo = repoMock();
    repo.findOne.mockResolvedValue({ id: 'u', role: 'student', status: 'active' });
    const svc = build(repo);
    await svc.update('u', { status: 'active' });
    expect(repo.increment).not.toHaveBeenCalled();
    await svc.update('u', { status: 'suspended' });
    expect(repo.increment).toHaveBeenCalledWith({ id: 'u' }, 'tokenVersion', 1);
  });

  it('blocks self role/status change when actorId given', async () => {
    const repo = repoMock();
    repo.findOne.mockResolvedValue({ id: 'u', role: 'admin', status: 'active' });
    await expect(build(repo).update('u', { role: 'student' }, 'u')).rejects.toThrow(BadRequestException);
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
    const repo: any = { update: jest.fn() };
    await build(repo).savePasswordResetToken('u1', 'raw-token-abc', new Date());
    const patch = repo.update.mock.calls[0][1];
    expect(patch.passwordResetToken).toBe(hashResetToken('raw-token-abc'));
    expect(patch.passwordResetToken).not.toContain('raw-token-abc');
    expect(patch.passwordResetToken).toMatch(/^[a-f0-9]{64}$/);
  });

  it('findByResetToken looks up by hash and refuses empty tokens (cannot match a null/empty column)', async () => {
    const repo: any = { findOne: jest.fn().mockResolvedValue({ id: 'u1' }) };
    const svc = build(repo);
    await svc.findByResetToken('raw-token-abc');
    expect(repo.findOne).toHaveBeenCalledWith({ where: { passwordResetToken: hashResetToken('raw-token-abc') } });
    repo.findOne.mockClear();
    expect(await svc.findByResetToken('')).toBeNull();
    expect(await svc.findByResetToken('   ')).toBeNull();
    expect(repo.findOne).not.toHaveBeenCalled();
  });
});
