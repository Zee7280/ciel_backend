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
