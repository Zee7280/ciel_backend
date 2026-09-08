import { PlatformStatsService } from './platform-stats.service';

function makeService(attendanceLogsRepository: Record<string, jest.Mock>) {
    const noop = {} as any;
    return new PlatformStatsService(
        noop, // usersRepository
        noop, // organizationsRepository
        noop, // opportunitiesRepository
        noop, // participationsRepository
        attendanceLogsRepository as any,
        noop, // studentReportsRepository
        noop, // courseProjectRepository
        noop, // fypRepository
        noop, // ventureRepository
    );
}

describe('PlatformStatsService — community dividend never trusts a report\'s own client-submitted hours', () => {
    it('sumVerifiedHoursByProject reads real verified attendance-log totals, grouped per project, in one batched query', async () => {
        const getRawMany = jest.fn().mockResolvedValue([
            { projectId: 'opp-1', total: '32' },
            { projectId: 'opp-2', total: '8' },
        ]);
        const qb: any = {
            select: jest.fn(() => qb),
            addSelect: jest.fn(() => qb),
            where: jest.fn(() => qb),
            andWhere: jest.fn(() => qb),
            groupBy: jest.fn(() => qb),
            getRawMany,
        };
        const attendanceLogsRepository = { createQueryBuilder: jest.fn(() => qb) };
        const service = makeService(attendanceLogsRepository);

        const result = await (service as any).sumVerifiedHoursByProject(['opp-1', 'opp-2', 'opp-1']);

        expect(attendanceLogsRepository.createQueryBuilder).toHaveBeenCalledTimes(1);
        expect(qb.where).toHaveBeenCalledWith(
            'log.projectId IN (:...uniqueIds)',
            { uniqueIds: ['opp-1', 'opp-2'] },
        );
        expect(qb.andWhere).toHaveBeenCalledWith(
            expect.stringContaining("log.approvalStatus = 'approved' OR log.entryStatus = 'verified'"),
        );
        expect(result.get('opp-1')).toBe(32);
        expect(result.get('opp-2')).toBe(8);
    });

    it('returns an empty map without querying when there are no project ids', async () => {
        const attendanceLogsRepository = { createQueryBuilder: jest.fn() };
        const service = makeService(attendanceLogsRepository);

        const result = await (service as any).sumVerifiedHoursByProject([]);

        expect(attendanceLogsRepository.createQueryBuilder).not.toHaveBeenCalled();
        expect(result.size).toBe(0);
    });
});
