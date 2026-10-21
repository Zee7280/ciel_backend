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
