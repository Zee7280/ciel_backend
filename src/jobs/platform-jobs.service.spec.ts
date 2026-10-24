import {
  inProcessCronEnabled,
  NIGHTLY_JOBS_AUDIT_ACTION,
  PlatformJobsService,
} from './platform-jobs.service';

describe('inProcessCronEnabled', () => {
  it('is off on Vercel and when explicitly disabled, on otherwise', () => {
    expect(inProcessCronEnabled({ VERCEL: '1' } as NodeJS.ProcessEnv)).toBe(
      false,
    );
    expect(
      inProcessCronEnabled({
        DISABLE_PLATFORM_CRON: 'true',
      } as NodeJS.ProcessEnv),
    ).toBe(false);
    expect(inProcessCronEnabled({} as NodeJS.ProcessEnv)).toBe(true);
  });
});

describe('PlatformJobsService.runNightlyJobsNow', () => {
  type ReconcileResult = {
    display_names_backfilled: number;
    duplicate_leads_normalized: number;
    scanned_teams: number;
  };

  function build(reconcile: () => Promise<ReconcileResult>) {
    const sla = {
      processPartnerAttendanceSla: jest
        .fn()
        .mockResolvedValue({ reminders_sent: 0, escalated: 0, scanned: 0 }),
    };
    const rec = { reconcileEnrollmentMetadata: jest.fn(reconcile) };
    const audit: { recordMutation: jest.Mock<Promise<void>, [unknown]> } = {
      recordMutation: jest.fn<Promise<void>, [unknown]>(() =>
        Promise.resolve(),
      ),
    };
    const service = new PlatformJobsService(
      sla as never,
      rec as never,
      audit as never,
    );
    return { service, audit };
  }

  it('runs both jobs and writes an audit row with the summary', async () => {
    const { service, audit } = build(() =>
      Promise.resolve({
        display_names_backfilled: 2,
        duplicate_leads_normalized: 0,
        scanned_teams: 5,
      }),
    );
    const out = await service.runNightlyJobsNow('vercel-cron');
    expect(out.success).toBe(true);
    expect(out.enrollment_reconcile?.scanned_teams).toBe(5);
    const call = audit.recordMutation.mock.calls[0][0] as {
      action: string;
      user: string;
      details: { success: boolean };
    };
    expect(call.action).toBe(NIGHTLY_JOBS_AUDIT_ACTION);
    expect(call.user).toBe('system:vercel-cron');
    expect(call.details.success).toBe(true);
  });

  it('reports a failure instead of throwing and still audits it', async () => {
    const { service, audit } = build(() =>
      Promise.reject(new Error('db down')),
    );
    const out = await service.runNightlyJobsNow('manual-secret');
    expect(out.success).toBe(false);
    expect(out.error).toBe('db down');
    const call = audit.recordMutation.mock.calls[0][0] as {
      details: { success: boolean; error: string | null };
    };
    expect(call.details.success).toBe(false);
    expect(call.details.error).toBe('db down');
  });
});
