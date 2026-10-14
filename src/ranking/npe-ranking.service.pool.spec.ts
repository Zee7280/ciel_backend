import { HttpException } from '@nestjs/common';
import { NpeRankingService, NPE_ANALYZE_BUDGET_MS, describeAiFailure } from './npe-ranking.service';

function build(over: { reports?: any; evaluations?: any; cards?: any[] } = {}) {
  const communityAward = {
    listForAdmin: jest.fn().mockResolvedValue(over.cards ?? []),
    listForUniversity: jest.fn().mockResolvedValue(over.cards ?? []),
  };
  const svc = new NpeRankingService(
    over.reports ?? ({} as any),
    { findOne: jest.fn().mockResolvedValue(null) } as any,
    over.evaluations ?? ({} as any),
    {} as any,
    communityAward as any,
    {} as any,
  ) as any;
  return svc;
}

describe('NPE ranking pool', () => {
  it('only offers reports whose CII is locked', async () => {
    const rows = [
      { id: 'locked', ciiV45Lock: { locked: true } },
      { id: 'string-locked', ciiV45Lock: { locked: 'true' } },
      { id: 'unlocked', ciiV45Lock: { locked: false } },
      { id: 'none', ciiV45Lock: null },
    ];
    const svc = build({
      cards: rows.map((r) => ({ id: r.id })),
      reports: { find: jest.fn().mockResolvedValue(rows) },
    });
    const pool = await svc.poolReports({ userId: 'a', role: 'ciel_admin' });
    expect(pool.map((r: any) => r.id)).toEqual(['locked', 'string-locked']);
  });

  it('keeps one analyze call well inside the 300s function limit', () => {
    expect(NPE_ANALYZE_BUDGET_MS).toBeLessThanOrEqual(120_000);
  });
});

describe('NPE reusable evaluations', () => {
  it('reuses the latest clean read of the same package version only', async () => {
    const qb: any = {
      innerJoin: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([
        { reportId: 'a', packageVersion: 'v2', flags: [], runId: 'r3' },
        { reportId: 'a', packageVersion: 'v1', flags: [], runId: 'r2' },
        { reportId: 'b', packageVersion: 'v1', flags: ['could not read'], runId: 'r3' },
        { reportId: 'c', packageVersion: 'old', flags: [], runId: 'r1' },
      ]),
    };
    const svc = build({ evaluations: { createQueryBuilder: jest.fn().mockReturnValue(qb) } });
    const out = await svc.findReusableEvaluations([
      { id: 'a', version: 'v1' },
      { id: 'b', version: 'v1' },
      { id: 'c', version: 'new' },
    ]);
    expect([...out.keys()]).toEqual(['a']);
    expect(out.get('a').runId).toBe('r2');
  });
});

describe('describeAiFailure', () => {
  it('surfaces the real reason from an HttpException body', () => {
    expect(
      describeAiFailure(new HttpException({ error: 'OpenAI API key is not configured', code: 'X' }, 500)),
    ).toBe('OpenAI API key is not configured');
    expect(describeAiFailure(new HttpException('plain text', 500))).toBe('plain text');
    expect(describeAiFailure(new Error('boom'))).toBe('boom');
    expect(describeAiFailure(undefined)).toBe('Ranking AI call failed.');
  });
});
