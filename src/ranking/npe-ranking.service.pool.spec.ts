import { HttpException } from '@nestjs/common';
import { NpeRankingService, NPE_ANALYZE_BUDGET_MS, describeAiFailure } from './npe-ranking.service';

function build(over: { reports?: any; evaluations?: any; cards?: any[]; attendanceLogs?: any; participations?: any } = {}) {
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
    over.attendanceLogs,
    over.participations,
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

  it('judges the hours gate on LIVE attendance logs, not the stored section1 snapshot', async () => {
    const PROJECT = '11111111-2222-4333-8444-555555555555';
    const report: any = {
      id: 'rep',
      studentId: 'lead-user',
      opportunityId: PROJECT,
      status: 'verified',
      faculty_status: 'approved',
      admin_status: 'approved',
      ciiV45Lock: { locked: true },
      updatedAt: new Date('2026-10-01T00:00:00Z'),
      opportunity: { title: 'T', timeline: { expected_hours: 20 } },
      // stored snapshot: lead has hours, the teammate's hours were never written into the JSON
      section1: { participation_type: 'team', team_lead: { id: 'seat-lead', hours: 20 }, team_members: [{ id: 'seat-mate', fullName: 'Mate' }], attendance_logs: [] },
    };
    const seats = [
      { id: 'seat-lead', projectId: PROJECT, studentId: 'lead-user', fullName: 'Lead', isTeamLead: true, teamId: 'T1', participationMode: 'team', status: 'approved' },
      { id: 'seat-mate', projectId: PROJECT, studentId: 'mate-user', fullName: 'Mate', isTeamLead: false, teamId: 'T1', participationMode: 'team', status: 'approved' },
      { id: 'seat-mate-dup', projectId: PROJECT, studentId: 'mate-user', fullName: 'Mate', isTeamLead: false, teamId: 'T1', participationMode: 'team', status: 'approved' },
      { id: 'seat-other-team', projectId: PROJECT, studentId: 'other', fullName: 'Other', isTeamLead: true, teamId: 'T2', participationMode: 'team', status: 'approved' },
    ];
    const logs = [
      { id: 'l1', projectId: PROJECT, participantId: 'seat-lead', sessionHours: '20', approvalStatus: 'pending' },
      { id: 'l2', projectId: PROJECT, participantId: 'seat-mate', sessionHours: '12', approvalStatus: 'pending' },
      { id: 'l3', projectId: PROJECT, participantId: 'seat-mate-dup', sessionHours: '8', approvalStatus: 'pending' }, // ghost seat holds the rest
      { id: 'l4', projectId: PROJECT, participantId: 'seat-mate', sessionHours: '5', approvalStatus: 'rejected' },
    ];
    const svc = build({
      cards: [{ id: 'rep' }],
      reports: { find: jest.fn().mockResolvedValue([report]) },
      attendanceLogs: { find: jest.fn().mockResolvedValue(logs) },
      participations: { find: jest.fn().mockResolvedValue(seats) },
    });
    const { buildNpePackageRecord, gateNpePackage } = require('./npe-ranking-eligibility');
    expect(buildNpePackageRecord(report).hoursMet).toBe(false); // stored JSON alone would hold it
    const pool = await svc.poolReports({ userId: 'a', role: 'ciel_admin' });
    const pkg = buildNpePackageRecord(pool[0]);
    expect(pkg.hoursMet).toBe(true);
    expect(gateNpePackage(pkg).reason).not.toMatch(/hours/);
    const s1 = pool[0].section1 as any;
    expect(s1.team_members).toHaveLength(1); // ghost duplicate folded, other team excluded
    expect(s1.team_members[0].hours).toBe(20); // 12 + 8 on the canonical seat, rejected 5 ignored
    expect(s1.team_lead.hours).toBe(20);
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
        { reportId: 'a', packageVersion: 'v2', flags: [], runId: 'r3', audit: { payloadVersion: 2 } },
        { reportId: 'a', packageVersion: 'v1', flags: [], runId: 'r2', audit: { payloadVersion: 2 } },
        { reportId: 'a', packageVersion: 'v1', flags: [], runId: 'r0', audit: null }, // thinner (old) package: never trusted
        { reportId: 'b', packageVersion: 'v1', flags: ['could not read'], runId: 'r3', audit: { payloadVersion: 2 } },
        { reportId: 'c', packageVersion: 'old', flags: [], runId: 'r1', audit: { payloadVersion: 2 } },
        { reportId: 'd', packageVersion: 'v1', flags: [], runId: 'r1', audit: { model: 'x' } }, // marker missing
      ]),
    };
    const svc = build({ evaluations: { createQueryBuilder: jest.fn().mockReturnValue(qb) } });
    const out = await svc.findReusableEvaluations([
      { id: 'a', version: 'v1' },
      { id: 'b', version: 'v1' },
      { id: 'c', version: 'new' },
      { id: 'd', version: 'v1' },
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
