import { ImpactSummaryService } from './impact-summary.service';

/** Chainable query-builder stub: records SQL fragments and returns the canned row(s). */
function qb(result: { raw?: unknown; rows?: unknown[]; count?: number }) {
  const calls: string[] = [];
  const params: Record<string, unknown> = {};
  const chain: Record<string, unknown> = {};
  for (const m of ['innerJoin', 'where', 'andWhere', 'groupBy']) {
    chain[m] = (sql: string, p?: Record<string, unknown>) => {
      calls.push(sql);
      Object.assign(params, p ?? {});
      return chain;
    };
  }
  for (const m of ['select', 'addSelect']) {
    chain[m] = (sql: string) => {
      calls.push(sql);
      return chain;
    };
  }
  chain.setParameters = (p: Record<string, unknown>) => {
    Object.assign(params, p);
    return chain;
  };
  chain.getRawOne = () => Promise.resolve(result.raw);
  chain.getRawMany = () => Promise.resolve(result.rows ?? []);
  chain.getCount = () => Promise.resolve(result.count ?? 0);
  return { chain, calls, params };
}

function build(opts: {
  participations: Array<{ id: string; projectId: string; status: string }>;
  reports: Array<Record<string, unknown>>;
  hoursRow?: { verified: string | null; pending: string | null };
  loggedParticipantIds?: string[];
}) {
  const hours = qb({ raw: opts.hoursRow ?? { verified: '0', pending: '0' } });
  const logged = qb({
    rows: (opts.loggedParticipantIds ?? []).map((participantId) => ({
      participantId,
    })),
  });
  const unsent = qb({ count: 0 });
  const queue = [hours, logged, unsent];
  const attendanceLogRepo = {
    createQueryBuilder: jest.fn(() => queue.shift()!.chain),
  };
  const participationRepo = {
    count: jest.fn().mockResolvedValue(opts.participations.length),
    find: jest.fn().mockResolvedValue(opts.participations),
  };
  const service = new ImpactSummaryService(
    attendanceLogRepo as never,
    participationRepo as never,
    { find: jest.fn().mockResolvedValue([]) } as never,
    { find: jest.fn().mockResolvedValue([]) } as never,
    { findOne: jest.fn().mockResolvedValue(null) } as never,
    { findOne: jest.fn().mockResolvedValue(null) } as never,
    {
      getMergedReportsForParticipant: jest.fn().mockResolvedValue(opts.reports),
    } as never,
  );
  return { service, hours };
}

describe('ImpactSummaryService', () => {
  it('approved team report: teammate sees its hours verified and Community Service complete', async () => {
    const { service, hours } = build({
      participations: [
        { id: 'seat-inam', projectId: 'opp-1', status: 'approved' },
      ],
      reports: [
        {
          id: 'r1',
          opportunityId: 'opp-1',
          status: 'verified',
          admin_status: 'approved',
          faculty_status: 'approved',
        },
      ],
      hoursRow: { verified: '16', pending: '0' },
      loggedParticipantIds: ['seat-inam'],
    });
    const summary = await service.getSummary('inam');
    expect(summary.verifiedHours).toBe(16);
    expect(summary.pendingHours).toBe(0);
    expect(hours.params.approvedIds).toEqual(['opp-1']);
    expect(hours.calls.join(' ')).toContain(
      'log.projectId IN (:...approvedIds)',
    );
    expect(hours.calls.join(' ')).toContain("<> 'rejected'");
    expect(summary.pathsStatus.communityService).toEqual({
      state: 'complete',
      needsAction: false,
      progress: 100,
      detail: '1 approved report',
    });
  });

  it('no approved report: only faculty-verified sessions count; progress follows the stage', async () => {
    const { service, hours } = build({
      participations: [
        { id: 'a', projectId: 'opp-1', status: 'approved' },
        { id: 'b', projectId: 'opp-2', status: 'approved' },
      ],
      reports: [
        {
          id: 'r1',
          opportunityId: 'opp-1',
          status: 'submitted',
          admin_status: 'pending',
        },
      ],
      hoursRow: { verified: null, pending: '12' },
      loggedParticipantIds: ['b'],
    });
    const summary = await service.getSummary('s');
    expect(summary.verifiedHours).toBe(0);
    expect(summary.pendingHours).toBe(12);
    expect(hours.calls.join(' ')).not.toContain('approvedIds');
    // opp-1 report submitted (75), opp-2 hours logged (50) → 63.
    expect(summary.pathsStatus.communityService.progress).toBe(63);
    expect(summary.pathsStatus.communityService.state).toBe('active');
    expect(summary.pathsStatus.communityService.detail).toBe(
      '2 active engagements',
    );
  });

  it('no engagements: not started at 0', async () => {
    const { service } = build({ participations: [], reports: [] });
    const summary = await service.getSummary('new');
    expect(summary.pathsStatus.communityService.state).toBe('not_started');
    expect(summary.pathsStatus.communityService.progress).toBe(0);
  });

  it('a report lookup failure falls back to attendance-only figures', async () => {
    const { service } = build({ participations: [], reports: [] });
    (
      service as unknown as {
        studentReportsService: { getMergedReportsForParticipant: jest.Mock };
      }
    ).studentReportsService.getMergedReportsForParticipant.mockRejectedValue(
      new Error('db'),
    );
    await expect(service.getSummary('x')).resolves.toMatchObject({
      verifiedHours: 0,
    });
  });
});
