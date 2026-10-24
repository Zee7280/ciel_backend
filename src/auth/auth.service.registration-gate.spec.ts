import { ForbiddenException, NotFoundException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { SignupDto } from './dto/signup.dto';

type FakeUser = { id: string; email: string } & Record<string, unknown>;

function build(
  allowed: boolean,
  user: FakeUser | null = { id: 'u1', email: 'x@y.z' },
) {
  const usersService = {
    findOne: jest.fn().mockResolvedValue(user),
    findByEmail: jest.fn().mockResolvedValue(user),
    savePasswordResetToken: jest.fn(),
  };
  const mailService = {
    sendPasswordResetEmail: jest.fn<Promise<void>, [string, string]>(),
    buildPasswordResetLink: jest.fn(
      (t: string) => `https://app.test/reset-password?token=${t}`,
    ),
  };
  const settings = {
    isRegistrationAllowed: jest.fn().mockResolvedValue(allowed),
  };
  const svc = new AuthService(
    usersService as never,
    {} as never,
    {} as never,
    mailService as never,
    {} as never,
    {} as never,
    {} as never,
    {
      studentNeedsSubscriptionAtSignup: jest.fn().mockResolvedValue(false),
    } as never,
    settings as never,
    {} as never,
    {} as never,
    {} as never,
  );
  return { svc, usersService, mailService };
}

describe('AuthService registration gate', () => {
  it('blocks signup when registrations are closed', async () => {
    const { svc, usersService } = build(false);
    await expect(svc.signup({ email: 'a@b.c' } as SignupDto)).rejects.toThrow(
      ForbiddenException,
    );
    expect(usersService.findByEmail).not.toHaveBeenCalled();
  });
});

describe('AuthService.adminSendPasswordReset', () => {
  it('sends the reset email and returns success', async () => {
    const { svc, mailService, usersService } = build(true);
    await expect(svc.adminSendPasswordReset('u1')).resolves.toEqual({
      success: true,
    });
    expect(usersService.savePasswordResetToken).toHaveBeenCalled();
    expect(mailService.sendPasswordResetEmail).toHaveBeenCalledWith(
      'x@y.z',
      expect.stringContaining('reset-password?token='),
    );
  });
  it('404s for unknown user', async () => {
    const { svc } = build(true, null);
    await expect(svc.adminSendPasswordReset('nope')).rejects.toThrow(
      NotFoundException,
    );
  });
});

describe('AuthService — login does not leak account status before the password is proven', () => {
  const build2 = async (user: FakeUser | null) => {
    const hash = await bcrypt.hash('Right-pass-1', 4);
    const usersService = {
      findByEmail: jest
        .fn()
        .mockResolvedValue(user ? { ...user, password: hash } : null),
      formatUserResponse: jest.fn().mockResolvedValue({}),
    };
    const jwt = {
      sign: jest
        .fn<string, [object, { expiresIn: string }]>()
        .mockReturnValue('jwt'),
    };
    const svc = new AuthService(
      usersService as never,
      jwt as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { isRegistrationAllowed: jest.fn() } as never,
      {} as never,
      {} as never,
      {} as never,
    );
    return { svc, jwt };
  };

  it('a rejected organization cannot sign in — also while its membership fee is pending', async () => {
    for (const role of ['ngo', 'university', 'corporate']) {
      const { svc, jwt } = await build2({
        id: 'u1',
        email: 'org@x.pk',
        role,
        status: 'pending_membership_payment',
        organization: { id: 'o1', verificationStatus: 'REJECTED' },
      });
      await expect(
        svc.login({ email: 'org@x.pk', password: 'Right-pass-1' } as LoginDto),
      ).rejects.toThrow(/not approved/);
      expect(jwt.sign).not.toHaveBeenCalled();
    }
  });

  it('suspended / unverified accounts + WRONG password => generic "Invalid credentials"', async () => {
    for (const patch of [
      { status: 'suspended' },
      {
        role: 'ngo',
        status: 'active',
        organization: { verificationStatus: 'PENDING' },
      },
      {
        role: 'ngo',
        status: 'active',
        organization: { verificationStatus: 'REJECTED' },
      },
    ]) {
      const { svc } = await build2(
        Object.assign(
          { id: 'u', email: 'a@b.c', role: 'student', status: 'active' },
          patch,
        ),
      );
      await expect(
        svc.login({ email: 'a@b.c', password: 'wrong-pass' } as LoginDto),
      ).rejects.toThrow('Invalid credentials');
    }
  });

  it('the correct password still gets the specific status message', async () => {
    const { svc } = await build2({
      id: 'u',
      email: 'a@b.c',
      role: 'student',
      status: 'suspended',
    });
    await expect(
      svc.login({ email: 'a@b.c', password: 'Right-pass-1' } as LoginDto),
    ).rejects.toThrow('Account is not active');
  });

  it('unknown email is the same generic error', async () => {
    const { svc } = await build2(null);
    await expect(
      svc.login({ email: 'nobody@b.c', password: 'x' } as LoginDto),
    ).rejects.toThrow('Invalid credentials');
  });

  it('mobile tokens are capped at 7 days, web at 10 hours', async () => {
    const { svc, jwt } = await build2({
      id: 'u',
      email: 'a@b.c',
      role: 'faculty',
      status: 'active',
      tokenVersion: 0,
    });
    await svc.login({
      email: 'a@b.c',
      password: 'Right-pass-1',
      isMobile: true,
    } as LoginDto);
    expect(jwt.sign.mock.calls[0][1]).toEqual({ expiresIn: '7d' });
    await svc.login({ email: 'a@b.c', password: 'Right-pass-1' } as LoginDto);
    expect(jwt.sign.mock.calls[1][1]).toEqual({ expiresIn: '10h' });
  });
});

describe('AuthService.forgotPassword — no account-existence oracle', () => {
  it('returns the same success reply for an unknown email and a real one', async () => {
    const known = build(true, { id: 'u1', email: 'x@y.z' });
    const unknownUsers = {
      findByEmail: jest.fn().mockResolvedValue(null),
    };
    const unknownSvc = new AuthService(
      unknownUsers as never,
      {} as never,
      {} as never,
      { sendPasswordResetEmail: jest.fn() } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const a = await known.svc.forgotPassword('x@y.z');
    const b = await unknownSvc.forgotPassword('nobody@y.z');
    expect(a).toEqual(b);
    expect(a.success).toBe(true);
    expect(known.mailService.sendPasswordResetEmail).toHaveBeenCalledTimes(1);
  });

  it('stores only a hash of the reset token and mails the raw token link', async () => {
    const { svc, mailService } = build(true, {
      id: 'u1',
      email: 'x@y.z',
    });
    await svc.forgotPassword('x@y.z');
    const mailedLink = mailService.sendPasswordResetEmail.mock.calls[0][1];
    expect(mailedLink).toMatch(
      /^https:\/\/app\.test\/reset-password\?token=[a-f0-9]{64}$/,
    );
    expect(mailService.buildPasswordResetLink).toHaveBeenCalled();
  });
});

describe('AuthService — NGO grandfather backfill on boot', () => {
  const run = async (
    orgs: Array<{ id: string; verificationStatus: string; createdAt: Date }>,
  ) => {
    const byId = new Map(orgs.map((o) => [o.id, { ...o }]));
    const usersRepository = {
      find: jest
        .fn()
        .mockResolvedValue(
          orgs.map((o, i) => ({ id: `u${i}`, organization: o })),
        ),
    };
    const organizationsRepository = {
      findOne: jest.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve(byId.get(where.id) ?? null),
      ),
      save: jest.fn((org: { id: string }) => Promise.resolve(org)),
    };
    const svc = new AuthService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      usersRepository as never,
      organizationsRepository as never,
    );
    await svc.onApplicationBootstrap();
    return organizationsRepository.save.mock.calls.map(
      ([org]: [{ id: string }]) => org.id,
    );
  };

  it('approves pending orgs of active NGOs, but never an admin-rejected org', async () => {
    const approved = await run([
      {
        id: 'legacy',
        verificationStatus: 'PENDING',
        createdAt: new Date('2026-06-01T00:00:00Z'),
      },
      {
        id: 'new-signup',
        verificationStatus: 'PENDING',
        createdAt: new Date('2026-10-01T00:00:00Z'),
      },
      {
        id: 'rejected',
        verificationStatus: 'REJECTED',
        createdAt: new Date('2026-06-01T00:00:00Z'),
      },
    ]);
    expect(approved).toEqual(['legacy', 'new-signup']);
  });
});

describe('AuthService — university / corporate account awaiting organization verification', () => {
  const build3 = async (verificationStatus: string, role = 'university') => {
    const hash = await bcrypt.hash('Right-pass-1', 4);
    const usersService = {
      findByEmail: jest.fn().mockResolvedValue({
        id: 'u1',
        email: 'uni@x.pk',
        role,
        status: 'pending_org_verification',
        tokenVersion: 0,
        password: hash,
        organization: { id: 'o1', verificationStatus },
      }),
      formatUserResponse: jest.fn().mockResolvedValue({}),
    };
    const jwt = { sign: jest.fn().mockReturnValue('jwt') };
    const usersRepository = { update: jest.fn().mockResolvedValue({}) };
    const svc = new AuthService(
      usersService as never,
      jwt as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      usersRepository as never,
      {} as never,
    );
    const login = () =>
      svc.login({ email: 'uni@x.pk', password: 'Right-pass-1' } as LoginDto);
    return { login, jwt, usersRepository };
  };

  it('stays locked out while the organization is pending, for university and corporate', async () => {
    for (const role of ['university', 'corporate']) {
      const { login, jwt, usersRepository } = await build3('PENDING', role);
      await expect(login()).rejects.toThrow(
        /pending CIEL PK admin verification/,
      );
      expect(jwt.sign).not.toHaveBeenCalled();
      expect(usersRepository.update).not.toHaveBeenCalled();
    }
  });

  it('a rejected organization gets the not-approved message', async () => {
    const { login, usersRepository } = await build3('REJECTED');
    await expect(login()).rejects.toThrow(/not approved/);
    expect(usersRepository.update).not.toHaveBeenCalled();
  });

  it('activates the account on the first login after the organization is approved', async () => {
    const { login, jwt, usersRepository } = await build3('APPROVED');
    await login();
    expect(usersRepository.update).toHaveBeenCalledWith(
      { id: 'u1', status: 'pending_org_verification' },
      { status: 'active' },
    );
    expect(jwt.sign).toHaveBeenCalled();
  });
});
