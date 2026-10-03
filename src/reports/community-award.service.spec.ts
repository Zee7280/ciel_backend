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
