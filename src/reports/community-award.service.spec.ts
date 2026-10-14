import { CommunityAwardService } from './community-award.service';

function makeService() {
    return new CommunityAwardService(
        { findOne: jest.fn(), save: jest.fn() } as any,
        {} as any,
        { createNotification: jest.fn() } as any,
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

    function approvedReport(id: string) {
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
        const save = jest.fn().mockImplementation(async (row) => row);
        const service = new CommunityAwardService(
            {
                findOne: jest.fn().mockImplementation(async ({ where }) => approvedReport(where.id)),
                save,
            } as any,
            {} as any,
            { createNotification: jest.fn().mockResolvedValue(undefined) } as any,
        );
        const pool = [1, 2, 3, 4, 5].map((n) => ({ id: `r${n}`, total: 100 - n }));
        const result = await service.notifyFromPool(pool as any, {
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
        const save = jest.fn().mockImplementation(async (row) => row);
        const service = new CommunityAwardService(
            {
                findOne: jest.fn().mockImplementation(async ({ where }) => approvedReport(where.id)),
                save,
            } as any,
            {} as any,
            { createNotification: jest.fn().mockResolvedValue(undefined) } as any,
        );
        const pool = [1, 2, 3, 4, 5].map((n) => ({ id: `u${n}`, total: 100 - n }));
        await service.notifyFromPool(pool as any, {
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
            const result: any = await service.notifyFromPool([], { kind, reportIds: [] });
            expect(result.graderRuns).toBeUndefined();
        }
    });
});

describe('CommunityAwardService.notifyFromPool — ranking is computed server-side', () => {
    const report = (id: string) => ({
        id,
        faculty_status: 'approved',
        admin_status: 'approved',
        status: 'verified',
        studentId: `student-${id}`,
        awardBadges: [] as any[],
        awardBadgeHistory: [] as any[],
        section1: { team_lead: { name: 'Ali Raza' } },
        opportunity: { title: `Project ${id}` },
    });
    const build = () => {
        const rows = new Map<string, any>();
        const reports = {
            findOne: jest.fn(async ({ where }) => {
                if (!rows.has(where.id)) rows.set(where.id, report(where.id));
                return rows.get(where.id);
            }),
            save: jest.fn(async (row) => row),
        };
        const notifications = { createNotification: jest.fn().mockResolvedValue(undefined) };
        return { service: new CommunityAwardService(reports as any, {} as any, notifications as any), rows, notifications };
    };
    const pool = [
        { id: 'r1', total: 91 },
        { id: 'r2', total: 77 },
        { id: 'r3', total: 77 },
        { id: 'r4', total: 40 },
    ] as any;

    it('ignores a crafted rank / of / total and stores the server-computed ones', async () => {
        const { service, rows } = build();
        await service.notifyFromPool(pool, {
            kind: 'ciel',
            scopeLabel: 'National',
            picks: [{ reportId: 'r4', rank: 1, of: 1, total: 100 }],
        } as any);
        const badge = rows.get('r4').awardBadges[0];
        expect(badge).toMatchObject({ rank: 4, of: 4, score: 40 });
    });

    it('equal totals share a rank (competition ranking)', async () => {
        const { service, rows } = build();
        await service.notifyFromPool(pool, { kind: 'ciel', reportIds: ['r2', 'r3'] } as any);
        expect(rows.get('r2').awardBadges[0].rank).toBe(2);
        expect(rows.get('r3').awardBadges[0].rank).toBe(2);
    });

    it('faculty / university medals only go to the TRUE top-N — a lower-ranked report cannot be promoted by the client', async () => {
        const { service, rows } = build();
        const res = await service.notifyFromPool(pool, {
            kind: 'fac', // top 1
            picks: [
                { reportId: 'r4', rank: 1 },
                { reportId: 'r1', rank: 9 },
            ],
        } as any);
        expect(rows.has('r4')).toBe(false);
        expect(rows.get('r1').awardBadges[0]).toMatchObject({ rank: 1, score: 91 });
        expect(res.notified).toBe(1);
    });

    it('re-publishing the same ranking does not duplicate the history or re-notify', async () => {
        const { service, rows, notifications } = build();
        await service.notifyFromPool(pool, { kind: 'ciel', reportIds: ['r1'] } as any);
        await service.notifyFromPool(pool, { kind: 'ciel', reportIds: ['r1'] } as any);
        expect(rows.get('r1').awardBadgeHistory).toHaveLength(1);
        expect(notifications.createNotification).toHaveBeenCalledTimes(1);
    });

    it('drops duplicate ids and ids outside the pool', async () => {
        const { service, rows } = build();
        const res = await service.notifyFromPool(pool, { kind: 'ciel', reportIds: ['r1', 'r1', 'ghost'] } as any);
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
        } as any);
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
        } as any);
        expect(card.organization_name).toBe('Partner');
    });
});

describe('CommunityAwardService.listForPartnerOrg — partner linked by email/name', () => {
    function serviceWithQb() {
        const qb: any = {
            leftJoinAndSelect: jest.fn().mockReturnThis(),
            where: jest.fn().mockReturnThis(),
            andWhere: jest.fn().mockReturnThis(),
            orderBy: jest.fn().mockReturnThis(),
            getMany: jest.fn().mockResolvedValue([]),
        };
        const service = new CommunityAwardService(
            { createQueryBuilder: jest.fn().mockReturnValue(qb) } as any,
            {} as any,
            { createNotification: jest.fn() } as any,
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
    function build(reportsById: Record<string, any>) {
        const saved: any[] = [];
        const notes: any[] = [];
        const reports: any = {
            findOne: jest.fn(async ({ where }: any) => reportsById[where.id] ?? null),
            find: jest.fn(async ({ where }: any) => Object.values(reportsById).filter((r: any) => where.id.value?.includes(r.id) ?? true)),
            save: jest.fn(async (r: any) => { saved.push(JSON.parse(JSON.stringify(r))); return r; }),
        };
        const svc = new CommunityAwardService(
            reports, {} as any,
            { createNotification: jest.fn(async (...a: any[]) => { notes.push(a); }) } as any,
        );
        return { svc, saved, notes };
    }
    const approved = (id: string, badges: any[] = []) => ({
        id, studentId: `stu-${id}`, status: 'verified', faculty_status: 'approved', admin_status: 'approved',
        awardBadges: badges, awardBadgeHistory: [], section1: { team_lead: { name: 'Sam' } }, opportunity: { title: `P ${id}` },
    });

    it('award-notify takes rank, cohort size and score from the published ranking and ignores unranked projects', async () => {
        const r: any = { a: approved('a'), b: approved('b'), z: approved('z') };
        const { svc, saved } = build(r);
        const pool: any[] = [{ id: 'a', total: 10 }, { id: 'b', total: 99 }, { id: 'z', total: 80 }];
        await svc.notifyFromPool(pool, { kind: 'ciel', reportIds: ['a', 'b', 'z'], scopeLabel: 'National' } as any, 'admin', [
            { reportId: 'a', rank: 1, score: 88.5 }, { reportId: 'b', rank: 2, score: 70 },
        ]);
        const byId = Object.fromEntries(saved.map((s) => [s.id, s.awardBadges[0]]));
        expect(byId.a).toMatchObject({ rank: 1, of: 2, score: 88.5 });
        expect(byId.b).toMatchObject({ rank: 2, of: 2, score: 70 });
        expect(byId.z).toBeUndefined();
    });

    it('sync rewrites an existing national medal, records history and notifies; unchanged ones are left alone', async () => {
        const old = { kind: 'ciel', rank: 5, of: 6, score: 66, scope: 'CIEL PK Ranking', label: 'x', at: 't' };
        const same = { kind: 'ciel', rank: 2, of: 2, score: 70, scope: 'National', label: 'x', at: 't' };
        const r: any = { a: approved('a', [old]), b: approved('b', [same]) };
        const { svc, saved, notes } = build(r);
        (svc as any).reports.find = jest.fn(async () => Object.values(r));
        const out = await svc.syncBadgesToPublishedRanking('ciel', 'National', [
            { reportId: 'a', rank: 1, score: 88.5 }, { reportId: 'b', rank: 2, score: 70 },
        ]);
        expect(out.updated).toBe(1);
        expect(saved).toHaveLength(1);
        expect(saved[0].awardBadges[0]).toMatchObject({ rank: 1, of: 2, score: 88.5, scope: 'National' });
        expect(saved[0].awardBadgeHistory).toHaveLength(1);
        expect(notes).toHaveLength(1);
    });

    it('top-N honours are dropped (history kept) when the published rank is outside the top N', async () => {
        const uni = { kind: 'uni', rank: 1, of: 6, score: 80, scope: 'X', label: 'x', at: 't' };
        const r: any = { a: approved('a', [uni]) };
        const { svc, saved } = build(r);
        (svc as any).reports.find = jest.fn(async () => Object.values(r));
        await svc.syncBadgesToPublishedRanking('uni', 'X', [{ reportId: 'a', rank: 5, score: 40 }]);
        expect(saved[0].awardBadges.find((b: any) => b.kind === 'uni')).toBeUndefined();
        expect(saved[0].awardBadgeHistory[0]).toMatchObject({ kind: 'uni', rank: 5 });
    });
});
