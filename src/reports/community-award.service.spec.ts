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

    it('the response never carries a graderRuns field for any stakeholder', async () => {
        const service = makeService();

        for (const kind of ['fac', 'uni', 'par', 'ciel'] as const) {
            const result: any = await service.notifyFromPool([], { kind, reportIds: [] });
            expect(result.graderRuns).toBeUndefined();
        }
    });
});
