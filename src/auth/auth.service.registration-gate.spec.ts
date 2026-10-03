import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { AuthService } from './auth.service';

function build(allowed: boolean, user: any = { id: 'u1', email: 'x@y.z' }) {
  const usersService = {
    findOne: jest.fn().mockResolvedValue(user),
    findByEmail: jest.fn().mockResolvedValue(user),
    savePasswordResetToken: jest.fn(),
  } as any;
  const mailService = {
    sendPasswordResetEmail: jest.fn(),
    buildPasswordResetLink: jest.fn((t: string) => `https://app.test/reset-password?token=${t}`),
  } as any;
  const settings = { isRegistrationAllowed: jest.fn().mockResolvedValue(allowed) } as any;
  const svc = new AuthService(
    usersService, {} as any, {} as any, mailService, {} as any, {} as any, {} as any, settings,
    {} as any, {} as any, {} as any,
  );
  return { svc, usersService, mailService };
}

describe('AuthService registration gate', () => {
  it('blocks signup when registrations are closed', async () => {
    const { svc, usersService } = build(false);
    await expect(svc.signup({ email: 'a@b.c' } as any)).rejects.toThrow(ForbiddenException);
    expect(usersService.findByEmail).not.toHaveBeenCalled();
  });
});

describe('AuthService.adminSendPasswordReset', () => {
  it('sends the reset email and returns success', async () => {
    const { svc, mailService, usersService } = build(true);
    await expect(svc.adminSendPasswordReset('u1')).resolves.toEqual({ success: true });
    expect(usersService.savePasswordResetToken).toHaveBeenCalled();
    expect(mailService.sendPasswordResetEmail).toHaveBeenCalledWith('x@y.z', expect.stringContaining('reset-password?token='));
  });
  it('404s for unknown user', async () => {
    const { svc } = build(true, null);
    await expect(svc.adminSendPasswordReset('nope')).rejects.toThrow(NotFoundException);
  });
});

describe('AuthService — login does not leak account status before the password is proven', () => {
  const bcrypt = require('bcrypt');
  const build2 = async (user: any) => {
    const hash = await bcrypt.hash('Right-pass-1', 4);
    const usersService = {
      findByEmail: jest.fn().mockResolvedValue(user ? { ...user, password: hash } : null),
      formatUserResponse: jest.fn().mockResolvedValue({}),
    } as any;
    const jwt = { sign: jest.fn().mockReturnValue('jwt') } as any;
    const svc = new AuthService(
      usersService, jwt, {} as any, {} as any, {} as any, {} as any, {} as any,
      { isRegistrationAllowed: jest.fn() } as any, {} as any, {} as any, {} as any,
    );
    return { svc, jwt };
  };

  it('suspended / unverified accounts + WRONG password => generic "Invalid credentials"', async () => {
    for (const patch of [
      { status: 'suspended' },
      { role: 'ngo', status: 'active', organization: { verificationStatus: 'PENDING' } },
      { role: 'ngo', status: 'active', organization: { verificationStatus: 'REJECTED' } },
    ]) {
      const { svc } = await build2({ id: 'u', email: 'a@b.c', role: 'student', status: 'active', ...patch });
      await expect(svc.login({ email: 'a@b.c', password: 'wrong-pass' } as any)).rejects.toThrow('Invalid credentials');
    }
  });

  it('the correct password still gets the specific status message', async () => {
    const { svc } = await build2({ id: 'u', email: 'a@b.c', role: 'student', status: 'suspended' });
    await expect(svc.login({ email: 'a@b.c', password: 'Right-pass-1' } as any)).rejects.toThrow('Account is not active');
  });

  it('unknown email is the same generic error', async () => {
    const { svc } = await build2(null);
    await expect(svc.login({ email: 'nobody@b.c', password: 'x' } as any)).rejects.toThrow('Invalid credentials');
  });

  it('mobile tokens are capped at 7 days, web at 10 hours', async () => {
    const { svc, jwt } = await build2({ id: 'u', email: 'a@b.c', role: 'faculty', status: 'active', tokenVersion: 0 });
    await svc.login({ email: 'a@b.c', password: 'Right-pass-1', isMobile: true } as any);
    expect(jwt.sign.mock.calls[0][1]).toEqual({ expiresIn: '7d' });
    await svc.login({ email: 'a@b.c', password: 'Right-pass-1' } as any);
    expect(jwt.sign.mock.calls[1][1]).toEqual({ expiresIn: '10h' });
  });
});

describe('AuthService.forgotPassword — no account-existence oracle', () => {
  it('returns the same success reply for an unknown email and a real one', async () => {
    const known = build(true, { id: 'u1', email: 'x@y.z' });
    const unknownUsers = { findByEmail: jest.fn().mockResolvedValue(null) } as any;
    const unknownSvc = new AuthService(
      unknownUsers, {} as any, {} as any, { sendPasswordResetEmail: jest.fn() } as any, {} as any, {} as any, {} as any,
      {} as any, {} as any, {} as any, {} as any,
    );
    const a = await known.svc.forgotPassword('x@y.z');
    const b = await unknownSvc.forgotPassword('nobody@y.z');
    expect(a).toEqual(b);
    expect(a.success).toBe(true);
    expect(known.mailService.sendPasswordResetEmail).toHaveBeenCalledTimes(1);
  });

  it('stores only a hash of the reset token and mails the raw token link', async () => {
    const { svc, usersService, mailService } = build(true, { id: 'u1', email: 'x@y.z' });
    await svc.forgotPassword('x@y.z');
    const mailedLink: string = mailService.sendPasswordResetEmail.mock.calls[0][1];
    expect(mailedLink).toMatch(/^https:\/\/app\.test\/reset-password\?token=[a-f0-9]{64}$/);
    expect(mailService.buildPasswordResetLink).toHaveBeenCalled();
  });
});
