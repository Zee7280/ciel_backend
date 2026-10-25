import { Repository } from 'typeorm';
import { AttendanceLog } from '../engagement/entities/attendance-log.entity';
import { PlatformStatsService } from './platform-stats.service';

type QueryBuilderMock = {
  innerJoin: jest.Mock;
  select: jest.Mock;
  addSelect: jest.Mock;
  where: jest.Mock;
  andWhere: jest.Mock;
  groupBy: jest.Mock;
  addGroupBy: jest.Mock;
  getRawMany: jest.Mock;
};
type AttendanceLogsRepositoryMock = { createQueryBuilder: jest.Mock };
/** Private-method surface exercised directly by these tests. */
type ServicePrivate = {
  sumVerifiedHoursByProjectAndStudent(
    pairs: { projectId: string; studentId: string }[],
  ): Promise<Map<string, number>>;
};

/** Untouched repository stub — these tests never reach it. */
const noop = <T>(): T => ({}) as T;

function makeService(attendanceLogsRepository: AttendanceLogsRepositoryMock) {
  const service = new PlatformStatsService(
    noop(), // usersRepository
    noop(), // organizationsRepository
    noop(), // opportunitiesRepository
    noop(), // participationsRepository
    attendanceLogsRepository as unknown as Repository<AttendanceLog>,
    noop(), // studentReportsRepository
    noop(), // courseProjectRepository
    noop(), // fypRepository
    noop(), // ventureRepository
    noop(), // quickWorkLogRepository
  );
  return service as unknown as ServicePrivate;
}

function makeQueryBuilder(getRawMany: jest.Mock): QueryBuilderMock {
  const qb: QueryBuilderMock = {
    innerJoin: jest.fn(() => qb),
    select: jest.fn(() => qb),
    addSelect: jest.fn(() => qb),
    where: jest.fn(() => qb),
    andWhere: jest.fn(() => qb),
    groupBy: jest.fn(() => qb),
    addGroupBy: jest.fn(() => qb),
    getRawMany,
  };
  return qb;
}

describe("PlatformStatsService — community dividend never trusts a report's own client-submitted hours", () => {
  it('sumVerifiedHoursByProjectAndStudent reads real verified attendance-log totals, grouped per (project, student) pair, in one batched query', async () => {
    const getRawMany = jest.fn().mockResolvedValue([
      { projectId: 'opp-1', studentId: 'stu-1', total: '32' },
      { projectId: 'opp-1', studentId: 'stu-2', total: '8' },
      { projectId: 'opp-2', studentId: 'stu-1', total: '5' },
    ]);
    const qb = makeQueryBuilder(getRawMany);
    const attendanceLogsRepository = { createQueryBuilder: jest.fn(() => qb) };
    const service = makeService(attendanceLogsRepository);

    const result = await service.sumVerifiedHoursByProjectAndStudent([
      { projectId: 'opp-1', studentId: 'stu-1' },
      { projectId: 'opp-1', studentId: 'stu-2' },
      { projectId: 'opp-1', studentId: 'stu-1' }, // duplicate pair — must not double-query or double-count
      { projectId: 'opp-2', studentId: 'stu-1' },
    ]);

    expect(attendanceLogsRepository.createQueryBuilder).toHaveBeenCalledTimes(
      1,
    );
    expect(qb.innerJoin).toHaveBeenCalledWith('log.participant', 'part');
    expect(qb.where).toHaveBeenCalledWith('log.projectId IN (:...projectIds)', {
      projectIds: ['opp-1', 'opp-2'],
    });
    expect(qb.andWhere).toHaveBeenCalledWith(
      'part.studentId IN (:...studentIds)',
      { studentIds: ['stu-1', 'stu-2'] },
    );
    expect(qb.andWhere).toHaveBeenCalledWith(
      expect.stringContaining(
        "log.approvalStatus = 'approved' OR log.entryStatus = 'verified'",
      ),
    );
    expect(result.get('opp-1:stu-1')).toBe(32);
    expect(result.get('opp-1:stu-2')).toBe(8);
    expect(result.get('opp-2:stu-1')).toBe(5);
  });

  it("does not attribute a shared opportunity's full hours to every student reporting on it", async () => {
    // Two students both verified-report against the same opportunity. Each only earned their
    // own logged hours -- the bug this test guards against is the total being counted twice
    // (once per report) using the opportunity's combined total instead of each student's own.
    const getRawMany = jest.fn().mockResolvedValue([
      { projectId: 'opp-shared', studentId: 'stu-a', total: '10' },
      { projectId: 'opp-shared', studentId: 'stu-b', total: '6' },
    ]);
    const qb = makeQueryBuilder(getRawMany);
    const attendanceLogsRepository = { createQueryBuilder: jest.fn(() => qb) };
    const service = makeService(attendanceLogsRepository);

    const result = await service.sumVerifiedHoursByProjectAndStudent([
      { projectId: 'opp-shared', studentId: 'stu-a' },
      { projectId: 'opp-shared', studentId: 'stu-b' },
    ]);

    const total =
      (result.get('opp-shared:stu-a') || 0) +
      (result.get('opp-shared:stu-b') || 0);
    expect(total).toBe(16); // 10 + 6, not 20 (the pre-fix bug would have summed 16 twice)
  });

  it('returns an empty map without querying when there are no project/student pairs', async () => {
    const attendanceLogsRepository = { createQueryBuilder: jest.fn() };
    const service = makeService(attendanceLogsRepository);

    const result = await service.sumVerifiedHoursByProjectAndStudent([]);

    expect(attendanceLogsRepository.createQueryBuilder).not.toHaveBeenCalled();
    expect(result.size).toBe(0);
  });
});
