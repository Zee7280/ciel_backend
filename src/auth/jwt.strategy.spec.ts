import { UnauthorizedException, Logger } from '@nestjs/common';
import { JwtStrategy, isSessionStatusAllowed } from './jwt.strategy';
import { resolveJwtSecret } from './jwt-secret.util';

function build(user: any) {
  const users = { findOne: jest.fn().mockResolvedValue(user) } as any;
  const config = { get: () => 'test-secret' } as any;
  return new JwtStrategy(config, users);
}

const base = { id: 'u1', role: 'student', status: 'active', tokenVersion: 0, name: 'N', organization: { id: 'o1', isBlocked: false } };

describe('JwtStrategy.validate', () => {
  it('accepts a normal active user and takes role from the DB', async () => {
    const res = await build(base).validate({ sub: 'u1', email: 'a@b.c', role: 'admin', tokenVersion: 0 });
    expect(res.role).toBe('student');
    expect(res.organizationId).toBe('o1');
  });
  it('rejects stale tokenVersion', async () => {
    await expect(build({ ...base, tokenVersion: 2 }).validate({ sub: 'u1', tokenVersion: 1 })).rejects.toThrow(UnauthorizedException);
  });
  it('rejects suspended users', async () => {
    await expect(build({ ...base, status: 'suspended' }).validate({ sub: 'u1' })).rejects.toThrow(UnauthorizedException);
  });
  it('rejects users of a blocked organization', async () => {
    await expect(build({ ...base, organization: { id: 'o1', isBlocked: true } }).validate({ sub: 'u1' })).rejects.toThrow(UnauthorizedException);
  });
  it('mirrors login statuses', () => {
    expect(isSessionStatusAllowed('pending_membership_payment', 'university')).toBe(true);
    expect(isSessionStatusAllowed('pending', 'investor')).toBe(true);
    expect(isSessionStatusAllowed('pending', 'student')).toBe(false);
    expect(isSessionStatusAllowed('rejected', 'student')).toBe(false);
  });
});

describe('resolveJwtSecret', () => {
  it('logs loudly in production when missing but still returns a value', () => {
    const logger = { error: jest.fn() } as unknown as Logger;
    expect(resolveJwtSecret(undefined, logger, 'production')).toBeTruthy();
    expect((logger as any).error).toHaveBeenCalled();
  });
  it('is silent when configured or in dev', () => {
    const logger = { error: jest.fn() } as unknown as Logger;
    expect(resolveJwtSecret('s', logger, 'production')).toBe('s');
    resolveJwtSecret(undefined, logger, 'development');
    expect((logger as any).error).not.toHaveBeenCalled();
  });
});
