import { AdminOtpLookupService } from './admin-otp-lookup.service';
import { encryptPasswordRecord } from '../users/password-record.util';

const future = () => new Date(Date.now() + 4 * 60_000);

function signupQb(rows: unknown[]) {
  const calls: string[] = [];
  const chain: Record<string, unknown> = {};
  for (const m of ['where', 'andWhere', 'orderBy', 'take']) {
    chain[m] = (sql: unknown) => {
      calls.push(String(sql));
      return chain;
    };
  }
  chain.getMany = () => Promise.resolve(rows);
  return { chain, calls };
}

function build(opts: {
  signup?: unknown[];
  team?: unknown[];
  titles?: Array<{ id: string; title: string }>;
  registered?: string[];
}) {
  const qb = signupQb(opts.signup ?? []);
  const usersQb: Record<string, unknown> = {};
  for (const m of ['select', 'where']) usersQb[m] = () => usersQb;
  usersQb.getRawMany = () =>
    Promise.resolve((opts.registered ?? []).map((email) => ({ email })));
  const otpRepo = { find: jest.fn().mockResolvedValue(opts.team ?? []) };
  const service = new AdminOtpLookupService(
    { createQueryBuilder: jest.fn(() => qb.chain) } as never,
    otpRepo as never,
    { find: jest.fn().mockResolvedValue(opts.titles ?? []) } as never,
    { createQueryBuilder: jest.fn(() => usersQb) } as never,
  );
  return { service, qb, otpRepo };
}

describe('AdminOtpLookupService', () => {
  const projectId = '0b1c2d3e-4f50-4a6b-8c7d-8e9f00112233';

  it('returns signup and teammate codes per account email, newest first', async () => {
    const { service, qb } = build({
      signup: [
        {
          email: 'New@X.com',
          otp: null,
          otpRecord: encryptPasswordRecord('482913'),
          expiresAt: future(),
          verified: false,
          createdAt: new Date(),
        },
        // Created before the encrypted copy existed: only a hash, nothing to show.
        {
          email: 'old@x.com',
          otp: null,
          otpRecord: null,
          expiresAt: future(),
          verified: false,
          createdAt: new Date(),
        },
      ],
      team: [
        {
          email: 'new@x.com',
          otp: '771204',
          projectId,
          expiresAt: new Date(Date.now() + 9 * 60_000),
          verifiedAt: null,
        },
      ],
      titles: [{ id: projectId, title: 'BinIt Right' }],
    });
    const map = await service.activeOtpsByEmail(['new@x.com', 'old@x.com']);
    expect(qb.calls.join(' ')).toContain('o.expiresAt > :now');
    expect(map.get('old@x.com')).toBeUndefined();
    expect(map.get('new@x.com')).toEqual([
      expect.objectContaining({
        code: '771204',
        purpose: 'team_verification',
        projectTitle: 'BinIt Right',
        verified: false,
      }),
      expect.objectContaining({
        code: '482913',
        purpose: 'signup',
        projectId: null,
      }),
    ]);
  });

  it('lists live codes by search text and flags emails without an account', async () => {
    const { service, qb } = build({
      signup: [
        {
          email: 'pending@bnu.edu.pk',
          otp: null,
          otpRecord: encryptPasswordRecord('123456'),
          expiresAt: future(),
          verified: true,
          createdAt: new Date(),
        },
      ],
      team: [
        {
          email: 'other@gmail.com',
          otp: '999999',
          projectId: 'not-a-uuid',
          expiresAt: future(),
          verifiedAt: null,
        },
      ],
      registered: [],
    });
    const rows = await service.listActive('BNU');
    expect(qb.calls.join(' ')).toContain('LOWER(o.email) LIKE :like');
    expect(rows).toEqual([
      expect.objectContaining({
        email: 'pending@bnu.edu.pk',
        code: '123456',
        verified: true,
        hasAccount: false,
      }),
    ]);
  });

  it('a failing table yields an empty result instead of an error', async () => {
    const { service, otpRepo } = build({});
    otpRepo.find.mockRejectedValue(new Error('db down'));
    await expect(service.listActive()).resolves.toEqual([]);
    await expect(service.activeOtpsByEmail([])).resolves.toEqual(new Map());
  });
});
