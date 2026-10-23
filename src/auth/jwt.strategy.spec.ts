import { UnauthorizedException, Logger } from '@nestjs/common';
import { JwtStrategy, isSessionStatusAllowed } from './jwt.strategy';
import { resolveJwtSecret } from './jwt-secret.util';

type FakeUser = {
  id: string;
  role: string;
  status: string;
  tokenVersion: number;
  name: string;
  organization: { id: string; isBlocked: boolean; verificationStatus?: string };
};

function build(user: FakeUser) {
  const users = { findOne: jest.fn().mockResolvedValue(user) };
  const config = { get: () => 'test-secret' };
  return new JwtStrategy(config as never, users as never);
}

const base: FakeUser = {
  id: 'u1',
  role: 'student',
  status: 'active',
  tokenVersion: 0,
  name: 'N',
  organization: { id: 'o1', isBlocked: false },
};

describe('JwtStrategy.validate', () => {
  it('accepts a normal active user and takes role from the DB', async () => {
    const res = await build(base).validate({
      sub: 'u1',
      email: 'a@b.c',
      role: 'admin',
      tokenVersion: 0,
    });
    expect(res.role).toBe('student');
    expect(res.organizationId).toBe('o1');
  });
  it('rejects stale tokenVersion', async () => {
    await expect(
      build({ ...base, tokenVersion: 2 }).validate({
        sub: 'u1',
        tokenVersion: 1,
      }),
    ).rejects.toThrow(UnauthorizedException);
  });
  it('rejects suspended users', async () => {
    await expect(
      build({ ...base, status: 'suspended' }).validate({ sub: 'u1' }),
    ).rejects.toThrow(UnauthorizedException);
  });
  it('rejects users of a blocked organization', async () => {
    await expect(
      build({ ...base, organization: { id: 'o1', isBlocked: true } }).validate({
        sub: 'u1',
      }),
    ).rejects.toThrow(UnauthorizedException);
  });
  it('rejects organization accounts whose organization was rejected — but not pending ones or students', async () => {
    const rejectedOrg = {
      id: 'o1',
      isBlocked: false,
      verificationStatus: 'REJECTED',
    };
    for (const role of [
      'university',
      'ngo',
      'corporate',
      'organization_admin',
    ]) {
      await expect(
        build({ ...base, role, organization: rejectedOrg }).validate({
          sub: 'u1',
        }),
      ).rejects.toThrow(UnauthorizedException);
    }
    await expect(
      build({
        ...base,
        role: 'university',
        organization: { ...rejectedOrg, verificationStatus: 'PENDING' },
      }).validate({ sub: 'u1' }),
    ).resolves.toMatchObject({ role: 'university' });
    await expect(
      build({ ...base, role: 'faculty', organization: rejectedOrg }).validate({
        sub: 'u1',
      }),
    ).resolves.toMatchObject({ role: 'faculty' });
  });
  it('mirrors login statuses', () => {
    expect(
      isSessionStatusAllowed('pending_membership_payment', 'university'),
    ).toBe(true);
    expect(isSessionStatusAllowed('pending', 'investor')).toBe(true);
    expect(isSessionStatusAllowed('pending', 'student')).toBe(false);
    expect(isSessionStatusAllowed('rejected', 'student')).toBe(false);
  });
});

describe('resolveJwtSecret', () => {
  const logger = () => ({ error: jest.fn() });
  const asLogger = (l: ReturnType<typeof logger>) => l as unknown as Logger;
  const STRONG = 'a-strong-production-secret-1234567890';

  it('refuses to start in production without a strong secret', () => {
    for (const bad of [undefined, '', '   ', 'secretKey', 'short']) {
      expect(() =>
        resolveJwtSecret(bad, asLogger(logger()), 'production', false),
      ).toThrow(/JWT_SECRET/);
    }
  });
  it('accepts a strong secret in production, silently', () => {
    const l = logger();
    expect(resolveJwtSecret(STRONG, asLogger(l), 'production', false)).toBe(
      STRONG,
    );
    expect(l.error).not.toHaveBeenCalled();
  });
  it('the explicit emergency flag downgrades the refusal to a loud error log', () => {
    const l = logger();
    expect(
      resolveJwtSecret(undefined, asLogger(l), 'production', true),
    ).toBeTruthy();
    expect(l.error).toHaveBeenCalled();
  });
  it('development / test keep the convenient fallback and stay quiet', () => {
    const l = logger();
    expect(resolveJwtSecret(undefined, asLogger(l), 'development', false)).toBe(
      'secretKey',
    );
    expect(resolveJwtSecret('s', asLogger(l), 'test', false)).toBe('s');
    expect(l.error).not.toHaveBeenCalled();
  });
});
