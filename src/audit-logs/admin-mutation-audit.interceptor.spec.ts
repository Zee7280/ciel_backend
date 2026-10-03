import { BadRequestException, ExecutionContext } from '@nestjs/common';
import { firstValueFrom, of, throwError } from 'rxjs';
import { AdminMutationAuditInterceptor } from './admin-mutation-audit.interceptor';

const ctx = () =>
  ({
    switchToHttp: () => ({
      getRequest: () => ({
        method: 'POST',
        baseUrl: '/api/v1/admin',
        route: { path: '/settings' },
        params: {},
        query: {},
        body: { key: 'site_name', value: 'X' },
        user: { id: 'a1', email: 'a@x.co', role: 'admin' },
        ip: '1.1.1.1',
      }),
      getResponse: () => ({ statusCode: 201 }),
    }),
  }) as unknown as ExecutionContext;

describe('AdminMutationAuditInterceptor', () => {
  it('logs successful mutations with outcome and a target label', async () => {
    const auditLogs = { recordMutation: jest.fn().mockResolvedValue(undefined) };
    const i = new AdminMutationAuditInterceptor(auditLogs as never);
    await firstValueFrom(i.intercept(ctx(), { handle: () => of(1) }));
    await new Promise((r) => setImmediate(r));
    const details = auditLogs.recordMutation.mock.calls[0][0].details;
    expect(details).toMatchObject({
      outcome: 'success',
      status_code: 201,
      target_label: 'site_name',
    });
  });

  it('also logs failed mutations with outcome=failure and the status code', async () => {
    const auditLogs = { recordMutation: jest.fn().mockResolvedValue(undefined) };
    const i = new AdminMutationAuditInterceptor(auditLogs as never);
    await expect(
      firstValueFrom(
        i.intercept(ctx(), {
          handle: () => throwError(() => new BadRequestException('bad')),
        }),
      ),
    ).rejects.toThrow('bad');
    await new Promise((r) => setImmediate(r));
    const details = auditLogs.recordMutation.mock.calls[0][0].details;
    expect(details).toMatchObject({ outcome: 'failure', status_code: 400 });
  });
});
