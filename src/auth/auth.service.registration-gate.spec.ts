import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { AuthService } from './auth.service';

function build(allowed: boolean, user: any = { id: 'u1', email: 'x@y.z' }) {
  const usersService = {
    findOne: jest.fn().mockResolvedValue(user),
    findByEmail: jest.fn().mockResolvedValue(user),
    savePasswordResetToken: jest.fn(),
  } as any;
  const mailService = { sendPasswordResetEmail: jest.fn() } as any;
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
