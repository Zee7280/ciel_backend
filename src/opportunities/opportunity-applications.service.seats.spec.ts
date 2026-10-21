import { BadRequestException } from '@nestjs/common';
import { OpportunityApplicationsService } from './opportunity-applications.service';
import { OpportunityApplication } from './entities/opportunity-application.entity';

type Row = Record<string, unknown>;

/**
 * In-memory stand-in for Postgres: `pg_advisory_xact_lock` is a real mutex held until the
 * transaction callback settles, and rows saved in one transaction are visible to the next.
 */
function fakeDb(occupiedParticipations: number) {
  const applications: Row[] = [];
  let lockTail: Promise<void> = Promise.resolve();
  const lockCalls: string[] = [];

  const repoFor = () => ({
    create: (r: Row) => ({ ...r }),
    save: async (r: Row) => {
      await new Promise((resolve) => setImmediate(resolve));
      const saved = { id: `app-${applications.length + 1}`, ...r };
      applications.push(saved);
      return saved;
    },
  });

  const transaction = async <T>(cb: (em: unknown) => Promise<T>) => {
    let release: () => void = () => undefined;
    const em = {
      query: async (sql: string, params: unknown[]) => {
        lockCalls.push(`${sql} ${String(params[0])}`);
        const prev = lockTail;
        lockTail = new Promise<void>((r) => (release = r));
        await prev;
      },
      count: () => Promise.resolve(occupiedParticipations),
      find: () =>
        Promise.resolve(
          applications.map((a) => ({
            applyPayload: a.applyPayload,
            studentUser: { email: `${String(a.studentUserId)}@uni.edu` },
          })),
        ),
      getRepository: (entity: unknown) => {
        expect(entity).toBe(OpportunityApplication);
        return repoFor();
      },
    };
    try {
      return await cb(em);
    } finally {
      release();
    }
  };

  const appRepo = { ...repoFor(), manager: { transaction } };
  const args: unknown[] = new Array<unknown>(11).fill({});
  args[0] = appRepo;
  const Ctor = OpportunityApplicationsService as unknown as new (
    ...a: unknown[]
  ) => OpportunityApplicationsService;
  return { service: new Ctor(...args), applications, lockCalls };
}

const params = (studentUserId: string, members: string[] = []) => ({
  studentUserId,
  opportunityId: 'opp-1',
  applyPayload: members.length
    ? {
        participation_type: 'team',
        team_members: members.map((email) => ({ email })),
      }
    : { participation_type: 'individual' },
});

describe('OpportunityApplicationsService.createApplication — atomic seats', () => {
  it('two simultaneous applies for the last seat: exactly one wins', async () => {
    const { service, applications, lockCalls } = fakeDb(9);
    const results = await Promise.allSettled([
      service.createApplication(params('s1'), { seats: 10, requested: 1 }),
      service.createApplication(params('s2'), { seats: 10, requested: 1 }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected');
    expect((rejected as PromiseRejectedResult).reason).toBeInstanceOf(
      BadRequestException,
    );
    expect(((rejected as PromiseRejectedResult).reason as Error).message).toBe(
      'All seats for this opportunity are taken.',
    );
    expect(applications).toHaveLength(1);
    expect(lockCalls).toEqual([
      'SELECT pg_advisory_xact_lock(hashtext($1)) opportunity_seats:opp-1',
      'SELECT pg_advisory_xact_lock(hashtext($1)) opportunity_seats:opp-1',
    ]);
  });

  it('counts a waiting team application against later applies', async () => {
    const { service, applications } = fakeDb(5);
    await service.createApplication(params('lead', ['a@x.edu', 'b@x.edu']), {
      seats: 10,
      requested: 3,
    });
    await expect(
      service.createApplication(params('s9', ['c@x.edu', 'd@x.edu']), {
        seats: 10,
        requested: 3,
      }),
    ).rejects.toThrow('Only 2 seats left, but this application needs 3.');
    expect(applications).toHaveLength(1);
  });

  it('skips the lock entirely for listings without a seat cap (and without a guard)', async () => {
    const { service, lockCalls, applications } = fakeDb(10_000);
    await service.createApplication(params('s1'), { seats: 0, requested: 1 });
    await service.createApplication(params('s2'));
    expect(lockCalls).toEqual([]);
    expect(applications).toHaveLength(2);
  });
});

describe('OpportunityApplicationsService.countSeatsInFlight — unchanged totals', () => {
  it('matches the admin queue team summary (lead + listed teammates, or 1)', async () => {
    const apps = [
      { applyPayload: {}, studentUser: { email: 'i@uni.edu' } },
      {
        applyPayload: {
          participation_type: 'team',
          team_members: [
            { email: 'a@uni.edu', name: 'A' },
            { email: 'a@uni.edu', name: 'dup' },
            { email: 'lead@uni.edu' },
          ],
        },
        studentUser: { email: 'lead@uni.edu' },
      },
      {
        applyPayload: { participation_type: 'team', team_members: [] },
        studentUser: { email: 'solo@uni.edu' },
      },
    ];
    const args: unknown[] = new Array<unknown>(11).fill({});
    args[0] = { find: jest.fn().mockResolvedValue(apps) };
    const service = new (OpportunityApplicationsService as unknown as new (
      ...a: unknown[]
    ) => OpportunityApplicationsService)(...args);
    const expected = apps.reduce((sum, app) => {
      const summary = service.adminBrowseApplicationTeamSummaryForQueue(
        app as unknown as OpportunityApplication,
      );
      return (
        sum +
        (summary && summary.team_member_count >= 1
          ? summary.team_member_count
          : 1)
      );
    }, 0);
    await expect(service.countSeatsInFlight('opp-1')).resolves.toBe(expected);
    expect(expected).toBe(1 + 2 + 1);
  });
});
