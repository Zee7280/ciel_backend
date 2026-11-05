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

describe('PlatformJobsService nightly record-id backfill', () => {
  const sla = {
    processPartnerAttendanceSla: jest
      .fn()
      .mockResolvedValue({ reminders_sent: 0, escalated: 0, scanned: 0 }),
  };
  const rec = {
    reconcileEnrollmentMetadata: jest.fn().mockResolvedValue({
      display_names_backfilled: 0,
      duplicate_leads_normalized: 0,
      scanned_teams: 0,
    }),
  };

  it('stamps a bounded batch and reports what is left', async () => {
    const backfill = jest.fn().mockResolvedValue({
      idsIssued: 500,
      remaining: 1200,
      unmatched: [{ kind: 'fyp', university: 'Mystery', records: 3 }],
    });
    const service = new PlatformJobsService(
      sla as never,
      rec as never,
      undefined,
      {
        backfill,
      } as never,
    );
    const out = await service.runNightlyJobsNow('vercel-cron');
    expect(backfill).toHaveBeenCalledWith(false, 500);
    expect(out.record_ids).toEqual({
      issued: 500,
      remaining: 1200,
      unmatched: 3,
    });
    expect(out.success).toBe(true);
  });

  it('a backfill failure is reported but does not fail the nightly jobs', async () => {
    const service = new PlatformJobsService(
      sla as never,
      rec as never,
      undefined,
      {
        backfill: jest.fn().mockRejectedValue(new Error('db busy')),
      } as never,
    );
    const out = await service.runNightlyJobsNow('vercel-cron');
    expect(out.success).toBe(true);
    expect(out.record_ids).toBeNull();
    expect(out.record_ids_error).toBe('db busy');
  });

  it('still runs the other jobs when the earlier ones fail, and skips cleanly without the module', async () => {
    const service = new PlatformJobsService(
      {
        processPartnerAttendanceSla: jest
          .fn()
          .mockRejectedValue(new Error('boom')),
      } as never,
      rec as never,
    );
    const out = await service.runNightlyJobsNow('manual-secret');
    expect(out.success).toBe(false);
    expect(out.record_ids).toBeNull();
    expect(out.record_ids_error).toBeNull();
  });
});
