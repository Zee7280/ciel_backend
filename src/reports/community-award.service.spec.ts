import { Repository } from 'typeorm';
import {
  CommunityAwardCard,
  CommunityAwardService,
} from './community-award.service';
import { StudentReport } from './entities/student-report.entity';
import { Organization } from '../organizations/entities/organization.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { NotifyCommunityAwardDto } from './dto/notify-community-award.dto';

type AwardBadge = NonNullable<StudentReport['awardBadges']>[number];

/** The minimal report row these tests feed through the mocked repository. */
type TestReport = {
  id: string;
  faculty_status: string;
  admin_status: string;
  status: string;
  studentId: string;
  awardBadges: AwardBadge[];
  awardBadgeHistory: AwardBadge[];
  section1: { team_lead: { name: string } };
  opportunity: { title: string };
};

type FindOneArgs = { where: { id: string } };

const asCards = (rows: Array<{ id: string; total: number }>) =>
  rows as unknown as CommunityAwardCard[];

function makeService() {
  return new CommunityAwardService(
    {
      findOne: jest.fn(),
      save: jest.fn(),
    } as unknown as Repository<StudentReport>,
    {} as unknown as Repository<Organization>,
    { createNotification: jest.fn() } as unknown as NotificationsService,
  );
}

describe('CommunityAwardService — notify run is unlimited for every stakeholder', () => {
  it('never caps or throws for repeated faculty notify calls in the same year', async () => {
    const service = makeService();
    const dto = { kind: 'fac' as const, reportIds: [] };

    for (let i = 0; i < 10; i++) {
      await expect(service.notifyFromPool([], dto)).resolves.toEqual(
        expect.objectContaining({ notified: 0, kind: 'fac' }),
      );
    }
  });

  it('never caps university, partner or CIEL PK notify calls either', async () => {
    const service = makeService();

    for (const kind of ['uni', 'par', 'ciel'] as const) {
      for (let i = 0; i < 5; i++) {
        await expect(
          service.notifyFromPool([], { kind, reportIds: [] }),
        ).resolves.toEqual(expect.objectContaining({ notified: 0, kind }));
      }
    }
  });

  function approvedReport(id: string): TestReport {
    return {
      id,
      faculty_status: 'approved',
      admin_status: 'approved',
      status: 'verified',
      studentId: 'student-1',
      awardBadges: [],
      awardBadgeHistory: [],
      section1: { team_lead: { name: 'Ali Raza' } },
      opportunity: { title: `Project ${id}` },
    };
  }

  it('publishes every CIEL PK national-ranking pick in the reviewed cohort', async () => {
    const save = jest.fn((row: TestReport) => Promise.resolve(row));
    const service = new CommunityAwardService(
      {
        findOne: jest.fn(({ where }: FindOneArgs) =>
          Promise.resolve(approvedReport(where.id)),
        ),
        save,
      } as unknown as Repository<StudentReport>,
      {} as unknown as Repository<Organization>,
      {
        createNotification: jest.fn().mockResolvedValue(undefined),
      } as unknown as NotificationsService,
    );
    const pool = [1, 2, 3, 4, 5].map((n) => ({ id: `r${n}`, total: 100 - n }));
    const result = await service.notifyFromPool(asCards(pool), {
      kind: 'ciel',
      scopeLabel: 'CIEL PK Network · 2026',
      picks: pool.map((card, index) => ({
        reportId: card.id,
        rank: index + 1,
        of: pool.length,
        total: card.total,
      })),
    });
    expect(save).toHaveBeenCalledTimes(5);
    expect(result.notified).toBe(5);
  });

  it('still stores only the top 3 university award picks', async () => {
    const save = jest.fn((row: TestReport) => Promise.resolve(row));
    const service = new CommunityAwardService(
      {
        findOne: jest.fn(({ where }: FindOneArgs) =>
          Promise.resolve(approvedReport(where.id)),
        ),
        save,
      } as unknown as Repository<StudentReport>,
      {} as unknown as Repository<Organization>,
      {
        createNotification: jest.fn().mockResolvedValue(undefined),
      } as unknown as NotificationsService,
    );
    const pool = [1, 2, 3, 4, 5].map((n) => ({ id: `u${n}`, total: 100 - n }));
    await service.notifyFromPool(asCards(pool), {
      kind: 'uni',
      scopeLabel: 'University cohort',
      picks: pool.map((card, index) => ({
        reportId: card.id,
        rank: index + 1,
        of: pool.length,
        total: card.total,
      })),
    });
    expect(save).toHaveBeenCalledTimes(3);
  });

  it('the response never carries a graderRuns field for any stakeholder', async () => {
    const service = makeService();

    for (const kind of ['fac', 'uni', 'par', 'ciel'] as const) {
      const result: Record<string, unknown> = await service.notifyFromPool([], {
        kind,
        reportIds: [],
      });
      expect(result.graderRuns).toBeUndefined();
    }
  });
});

describe('CommunityAwardService.notifyFromPool — ranking is computed server-side', () => {
  const report = (id: string): TestReport => ({
    id,
    faculty_status: 'approved',
    admin_status: 'approved',
    status: 'verified',
    studentId: `student-${id}`,
    awardBadges: [],
    awardBadgeHistory: [],
    section1: { team_lead: { name: 'Ali Raza' } },
    opportunity: { title: `Project ${id}` },
  });
  const build = () => {
    const rows = new Map<string, TestReport>();
    const reports = {
      findOne: jest.fn(({ where }: FindOneArgs) => {
        if (!rows.has(where.id)) rows.set(where.id, report(where.id));
        return Promise.resolve(rows.get(where.id));
      }),
      save: jest.fn((row: TestReport) => Promise.resolve(row)),
    };
    const notifications = {
      createNotification: jest.fn().mockResolvedValue(undefined),
    };
    return {
      service: new CommunityAwardService(
        reports as unknown as Repository<StudentReport>,
        {} as unknown as Repository<Organization>,
        notifications as unknown as NotificationsService,
      ),
      rows,
      notifications,
    };
  };
  const pool = asCards([
    { id: 'r1', total: 91 },
    { id: 'r2', total: 77 },
    { id: 'r3', total: 77 },
    { id: 'r4', total: 40 },
  ]);

  it('ignores a crafted rank / of / total and stores the server-computed ones', async () => {
    const { service, rows } = build();
    await service.notifyFromPool(pool, {
      kind: 'ciel',
      scopeLabel: 'National',
      picks: [{ reportId: 'r4', rank: 1, of: 1, total: 100 }],
    });
    const badge = rows.get('r4')!.awardBadges[0];
    expect(badge).toMatchObject({ rank: 4, of: 4, score: 40 });
  });

  it('equal totals share a rank (competition ranking)', async () => {
    const { service, rows } = build();
    await service.notifyFromPool(pool, {
      kind: 'ciel',
      reportIds: ['r2', 'r3'],
    });
    expect(rows.get('r2')!.awardBadges[0].rank).toBe(2);
    expect(rows.get('r3')!.awardBadges[0].rank).toBe(2);
  });

  it('faculty / university medals only go to the TRUE top-N — a lower-ranked report cannot be promoted by the client', async () => {
    const { service, rows } = build();
    const res = await service.notifyFromPool(pool, {
      kind: 'fac', // top 1
      picks: [
        { reportId: 'r4', rank: 1 },
        { reportId: 'r1', rank: 9 },
      ],
    });
    expect(rows.has('r4')).toBe(false);
    expect(rows.get('r1')!.awardBadges[0]).toMatchObject({
      rank: 1,
      score: 91,
    });
    expect(res.notified).toBe(1);
  });

  it('re-publishing the same ranking does not duplicate the history or re-notify', async () => {
    const { service, rows, notifications } = build();
    await service.notifyFromPool(pool, {
      kind: 'ciel',
      reportIds: ['r1'],
    });
    await service.notifyFromPool(pool, {
      kind: 'ciel',
      reportIds: ['r1'],
    });
    expect(rows.get('r1')!.awardBadgeHistory).toHaveLength(1);
    expect(notifications.createNotification).toHaveBeenCalledTimes(1);
  });

  it('drops duplicate ids and ids outside the pool', async () => {
    const { service, rows } = build();
    const res = await service.notifyFromPool(pool, {
      kind: 'ciel',
      reportIds: ['r1', 'r1', 'ghost'],
    });
    expect(res.notified).toBe(1);
    expect(rows.has('ghost')).toBe(false);
  });
});

describe('CommunityAwardService.toCard — organization name', () => {
  const baseReport = {
    id: 'r1',
    studentId: 's1',
    faculty_status: 'approved',
    admin_status: 'approved',
    status: 'verified',
    awardBadges: [],
    awardBadgeHistory: [],
    section1: {
      team_lead: { name: 'Ali', university: 'BNU', year: '1st' },
      team_members: [],
      metrics: { total_verified_hours: 16 },
    },
    section2: { summary_text: 'Story' },
    section8: { evidence_files: [] },
  };

  it('uses a real partner name instead of the student-opportunity bookkeeping org', () => {
    const card = makeService().toCard({
      ...baseReport,
      opportunity: {
        title: 'Aabpashi',
        organization: { name: 'Student opportunity — Aabpashi — 9f84bc1f' },
        partner_organization: { organization_name: 'Abroo' },
      },
    } as unknown as StudentReport);
    expect(card.organization_name).toBe('Abroo');
    expect(card.organization_name).not.toMatch(/student opportunity|9f84bc1f/i);
  });

  it('falls back to Partner when only a bookkeeping org name exists', () => {
    const card = makeService().toCard({
      ...baseReport,
      opportunity: {
        title: 'Aabpashi',
        organization: { name: 'Student opportunity — Aabpashi — 9f84bc1f' },
      },
    } as unknown as StudentReport);
    expect(card.organization_name).toBe('Partner');
  });
});

describe('CommunityAwardService.listForPartnerOrg — partner linked by email/name', () => {
  type WhereArgs = [string, Record<string, unknown>?];
  function serviceWithQb() {
    const qb = {
      leftJoinAndSelect: jest.fn().mockReturnThis(),
      where: jest.fn<unknown, WhereArgs>().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([]),
    };
    const service = new CommunityAwardService(
      {
        createQueryBuilder: jest.fn().mockReturnValue(qb),
      } as unknown as Repository<StudentReport>,
      {} as unknown as Repository<Organization>,
      { createNotification: jest.fn() } as unknown as NotificationsService,
    );
    return { service, qb };
  }

  it('includes opportunities that only name the partner when ids are given', async () => {
    const { service, qb } = serviceWithQb();
    await service.listForPartnerOrg('org-1', ['opp-a', 'opp-b']);
    const [clause, params] = qb.where.mock.calls[0];
    expect(clause).toContain('opportunity.id IN (:...linkedOppIds)');
    expect(params).toEqual({ oid: 'org-1', linkedOppIds: ['opp-a', 'opp-b'] });
  });

  it('stays owned-only when no linked ids exist', async () => {
    const { service, qb } = serviceWithQb();
    await service.listForPartnerOrg('org-1');
    expect(qb.where.mock.calls[0][0]).toBe('opportunity.organizationId = :oid');
  });
});

describe('CommunityAwardService — badges follow a published ranking', () => {
  type FindArgs = { where: { id: { value?: string[] } } };
  type ServiceWithReports = {
    reports: { find: (...args: unknown[]) => Promise<TestReport[]> };
  };
  function build(reportsById: Record<string, TestReport>) {
    const saved: TestReport[] = [];
    const notes: unknown[][] = [];
    const reports = {
      findOne: jest.fn(({ where }: FindOneArgs) =>
        Promise.resolve(reportsById[where.id] ?? null),
      ),
      find: jest.fn(({ where }: FindArgs) =>
        Promise.resolve(
          Object.values(reportsById).filter(
            (r) => where.id.value?.includes(r.id) ?? true,
          ),
        ),
      ),
      save: jest.fn((r: TestReport) => {
        saved.push(JSON.parse(JSON.stringify(r)) as TestReport);
        return Promise.resolve(r);
      }),
    };
    const svc = new CommunityAwardService(
      reports as unknown as Repository<StudentReport>,
      {} as unknown as Repository<Organization>,
      {
        createNotification: jest.fn((...a: unknown[]) => {
          notes.push(a);
          return Promise.resolve();
        }),
      } as unknown as NotificationsService,
    );
    return { svc, saved, notes };
  }
  const approved = (id: string, badges: AwardBadge[] = []): TestReport => ({
    id,
    studentId: `stu-${id}`,
    status: 'verified',
    faculty_status: 'approved',
    admin_status: 'approved',
    awardBadges: badges,
    awardBadgeHistory: [],
    section1: { team_lead: { name: 'Sam' } },
    opportunity: { title: `P ${id}` },
  });

  it('award-notify takes rank, cohort size and score from the published ranking and ignores unranked projects', async () => {
    const r: Record<string, TestReport> = {
      a: approved('a'),
      b: approved('b'),
      z: approved('z'),
    };
    const { svc, saved } = build(r);
    const pool = asCards([
      { id: 'a', total: 10 },
      { id: 'b', total: 99 },
      { id: 'z', total: 80 },
    ]);
    const dto: NotifyCommunityAwardDto = {
      kind: 'ciel',
      reportIds: ['a', 'b', 'z'],
      scopeLabel: 'National',
    };
    await svc.notifyFromPool(pool, dto, 'admin', [
      { reportId: 'a', rank: 1, score: 88.5 },
      { reportId: 'b', rank: 2, score: 70 },
    ]);
    const byId = Object.fromEntries(saved.map((s) => [s.id, s.awardBadges[0]]));
    expect(byId.a).toMatchObject({ rank: 1, of: 2, score: 88.5 });
    expect(byId.b).toMatchObject({ rank: 2, of: 2, score: 70 });
    expect(byId.z).toBeUndefined();
  });

  it('sync rewrites an existing national medal, records history and notifies; unchanged ones are left alone', async () => {
    const old: AwardBadge = {
      kind: 'ciel',
      rank: 5,
      of: 6,
      score: 66,
      scope: 'CIEL PK Ranking',
      label: 'x',
      at: 't',
    };
    const same: AwardBadge = {
      kind: 'ciel',
      rank: 2,
      of: 2,
      score: 70,
      scope: 'National',
      label: 'x',
      at: 't',
    };
    const r: Record<string, TestReport> = {
      a: approved('a', [old]),
      b: approved('b', [same]),
    };
    const { svc, saved, notes } = build(r);
    (svc as unknown as ServiceWithReports).reports.find = jest.fn(() =>
      Promise.resolve(Object.values(r)),
    );
    const out = await svc.syncBadgesToPublishedRanking('ciel', 'National', [
      { reportId: 'a', rank: 1, score: 88.5 },
      { reportId: 'b', rank: 2, score: 70 },
    ]);
    expect(out.updated).toBe(1);
    expect(saved).toHaveLength(1);
    expect(saved[0].awardBadges[0]).toMatchObject({
      rank: 1,
      of: 2,
      score: 88.5,
      scope: 'National',
    });
    expect(saved[0].awardBadgeHistory).toHaveLength(1);
    expect(notes).toHaveLength(1);
  });

  it('top-N honours are dropped (history kept) when the published rank is outside the top N', async () => {
    const uni: AwardBadge = {
      kind: 'uni',
      rank: 1,
      of: 6,
      score: 80,
      scope: 'X',
      label: 'x',
      at: 't',
    };
    const r: Record<string, TestReport> = { a: approved('a', [uni]) };
    const { svc, saved } = build(r);
    (svc as unknown as ServiceWithReports).reports.find = jest.fn(() =>
      Promise.resolve(Object.values(r)),
    );
    await svc.syncBadgesToPublishedRanking('uni', 'X', [
      { reportId: 'a', rank: 5, score: 40 },
    ]);
    expect(saved[0].awardBadges.find((b) => b.kind === 'uni')).toBeUndefined();
    expect(saved[0].awardBadgeHistory[0]).toMatchObject({
      kind: 'uni',
      rank: 5,
    });
  });
});
