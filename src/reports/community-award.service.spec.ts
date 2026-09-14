import { ForbiddenException } from '@nestjs/common';
import { CommunityAwardService } from './community-award.service';

function makeGraderRunRepo() {
    const rows: Record<string, unknown>[] = [];
    const repo = {
        rows,
        manager: {
            transaction: jest.fn(async (fn: (m: unknown) => unknown) => {
                const manager = {
                    getRepository: () => ({
                        findOne: jest.fn(async ({ where }: { where: Record<string, unknown> }) =>
                            rows.find((r) =>
                                Object.entries(where).every(([k, v]) => r[k] === v),
                            ) ?? null,
                        ),
                        create: jest.fn((data: Record<string, unknown>) => ({ ...data })),
                        save: jest.fn(async (row: Record<string, unknown>) => {
                            const idx = rows.findIndex(
                                (r) =>
                                    r.pathKind === row.pathKind &&
                                    r.scope === row.scope &&
                                    r.scopeKey === row.scopeKey &&
                                    r.academicYear === row.academicYear,
                            );
                            if (idx >= 0) rows[idx] = row;
                            else rows.push(row);
                            return row;
                        }),
                    }),
                };
                return fn(manager);
            }),
        },
    };
    return repo;
}

function makeService(graderRunRepo: ReturnType<typeof makeGraderRunRepo>) {
    return new CommunityAwardService(
        { findOne: jest.fn(), save: jest.fn() } as any,
        {} as any,
        graderRunRepo as any,
        { createNotification: jest.fn() } as any,
    );
}

describe('CommunityAwardService — faculty award-run quota (advertised "4 runs / year")', () => {
    it('allows exactly 4 runs per academic year for a faculty email, then blocks the 5th', async () => {
        const graderRunRepo = makeGraderRunRepo();
        const service = makeService(graderRunRepo);
        const dto = { kind: 'fac' as const, reportIds: [] };

        await service.notifyFromPool([], dto, 'teacher@test.com');
        await service.notifyFromPool([], dto, 'teacher@test.com');
        await service.notifyFromPool([], dto, 'teacher@test.com');
        await service.notifyFromPool([], dto, 'teacher@test.com');

        await expect(service.notifyFromPool([], dto, 'teacher@test.com')).rejects.toBeInstanceOf(
            ForbiddenException,
        );
    });

    it('scopes the cap independently per faculty email', async () => {
        const graderRunRepo = makeGraderRunRepo();
        const service = makeService(graderRunRepo);
        const dto = { kind: 'fac' as const, reportIds: [] };

        await service.notifyFromPool([], dto, 'teacherA@test.com');
        await service.notifyFromPool([], dto, 'teacherA@test.com');
        await service.notifyFromPool([], dto, 'teacherA@test.com');
        await service.notifyFromPool([], dto, 'teacherA@test.com');
        await expect(
            service.notifyFromPool([], dto, 'teacherA@test.com'),
        ).rejects.toBeInstanceOf(ForbiddenException);

        // A different faculty member's own cap is untouched.
        await expect(
            service.notifyFromPool([], dto, 'teacherB@test.com'),
        ).resolves.toEqual(expect.objectContaining({ notified: 0 }));
    });

    it('does not consume or check the quota for university/partner/admin callers', async () => {
        const graderRunRepo = makeGraderRunRepo();
        const service = makeService(graderRunRepo);

        for (const kind of ['uni', 'par', 'ciel'] as const) {
            const result: any = await service.notifyFromPool([], { kind, reportIds: [] }, undefined);
            expect(result.graderRuns).toBeUndefined();
        }
        expect(graderRunRepo.rows).toHaveLength(0);
    });

    it('reports usage in the response so the UI can show remaining runs', async () => {
        const graderRunRepo = makeGraderRunRepo();
        const service = makeService(graderRunRepo);

        const result: any = await service.notifyFromPool(
            [],
            { kind: 'fac', reportIds: [] },
            'teacher@test.com',
        );
        expect(result.graderRuns).toEqual({ unlimited: false, used: 1, limit: 4 });
    });
});
