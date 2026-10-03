import { ExecutionContext, ServiceUnavailableException } from '@nestjs/common';
import * as jwt from 'jsonwebtoken';
import { MaintenanceGuard } from './maintenance.guard';

const SECRET = 'test-secret';

const ctx = (req: Record<string, unknown>) =>
  ({
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => req }),
  }) as unknown as ExecutionContext;

const makeGuard = (maintenance: boolean | Error) => {
  const settings = {
    isMaintenanceMode: jest.fn(async () => {
      if (maintenance instanceof Error) throw maintenance;
      return maintenance;
    }),
  };
  const config = { get: () => SECRET };
  return new MaintenanceGuard(settings as never, config as never);
};

const token = (role: string) => jwt.sign({ sub: 'u1', role }, SECRET);

describe('MaintenanceGuard', () => {
  it('lets everything through when maintenance is off', async () => {
    await expect(
      makeGuard(false).canActivate(ctx({ method: 'GET', originalUrl: '/api/v1/opportunities' })),
    ).resolves.toBe(true);
  });

  it('blocks anonymous and non-admin requests with 503 during maintenance', async () => {
    const guard = makeGuard(true);
    await expect(
      guard.canActivate(ctx({ method: 'GET', originalUrl: '/api/v1/opportunities', headers: {} })),
    ).rejects.toThrow(ServiceUnavailableException);
    await expect(
      guard.canActivate(
        ctx({
          method: 'GET',
          originalUrl: '/api/v1/opportunities',
          headers: { authorization: `Bearer ${token('student')}` },
        }),
      ),
    ).rejects.toThrow(ServiceUnavailableException);
  });

  it('treats a bad or expired token as non-admin', async () => {
    await expect(
      makeGuard(true).canActivate(
        ctx({
          method: 'GET',
          originalUrl: '/api/v1/admin/users',
          headers: { authorization: 'Bearer not.a.jwt' },
        }),
      ),
    ).rejects.toThrow(ServiceUnavailableException);
  });

  it('lets admins through', async () => {
    await expect(
      makeGuard(true).canActivate(
        ctx({
          method: 'GET',
          originalUrl: '/api/v1/admin/users?x=1',
          headers: { authorization: `Bearer ${token('admin')}` },
        }),
      ),
    ).resolves.toBe(true);
  });

  it('keeps login, password reset, public config and health reachable', async () => {
    const guard = makeGuard(true);
    for (const [method, url] of [
      ['POST', '/api/v1/auth/login'],
      ['POST', '/api/v1/auth/forgot-password'],
      ['POST', '/api/v1/auth/reset-password'],
      ['GET', '/api/v1/public/config'],
      ['GET', '/'],
      ['OPTIONS', '/api/v1/anything'],
    ]) {
      await expect(
        guard.canActivate(ctx({ method, originalUrl: url, headers: {} })),
      ).resolves.toBe(true);
    }
    await expect(
      guard.canActivate(ctx({ method: 'POST', originalUrl: '/api/v1/auth/signup', headers: {} })),
    ).rejects.toThrow(ServiceUnavailableException);
  });

  it('never crashes when the settings read fails', async () => {
    await expect(
      makeGuard(new Error('db down')).canActivate(
        ctx({ method: 'GET', originalUrl: '/api/v1/x', headers: {} }),
      ),
    ).resolves.toBe(true);
  });
});
