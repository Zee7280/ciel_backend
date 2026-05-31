import { ArgumentsHost, BadRequestException } from '@nestjs/common';
import { IssueLogsService } from './issue-logs.service';

describe('IssueLogsService', () => {
  const makeHost = (request: any): ArgumentsHost =>
    ({
      switchToHttp: () => ({
        getRequest: () => request,
      }),
    }) as any;

  const makeQueryBuilder = (rows: unknown[] = [], total = 0) => {
    const chain = {
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getManyAndCount: jest.fn().mockResolvedValue([rows, total]),
    };
    return chain;
  };

  const makeRepository = (qb = makeQueryBuilder()) => ({
    create: jest.fn((value) => value),
    save: jest.fn().mockResolvedValue(undefined),
    findAndCount: jest.fn().mockResolvedValue([[], 0]),
    findOne: jest.fn().mockResolvedValue(null),
    createQueryBuilder: jest.fn().mockReturnValue(qb),
  });

  it('logs user-facing report errors with safe metadata', async () => {
    const repository = makeRepository();
    const service = new IssueLogsService(repository as any);

    const method = 'POST';
    const requestUrl =
      '/api/v1/student/reports/project-1/submit';
    const acceptHeaderValue = 'application/json';
    const exception = new BadRequestException('Report validation failed');

    await service.logException(
      exception,
      makeHost({
        method,
        originalUrl: requestUrl,
        url: requestUrl,
        route: { path: '/student/reports/:id/submit' },
        ip: '127.0.0.1',
        headers: {
          accept: acceptHeaderValue,
          'user-agent': 'jest',
          authorization: 'Bearer secret',
          'x-request-id': 'request-1',
        },
        params: { id: 'project-1' },
        query: {},
        body: {
          opportunityId: 'project-1',
          password: 'should-not-store',
          section: 'section3',
        },
        user: {
          id: 'user-1',
          email: 'student@example.com',
          role: 'student',
        },
      }),
    );

    expect(repository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        module: 'student',
        stage: 'section3',
        statusCode: 400,
        userId: 'user-1',
        userEmail: 'student@example.com',
        targetType: 'report',
        targetId: 'project-1',
        requestId: 'request-1',
      }),
    );
    expect(repository.save.mock.calls[0][0].metadata.body.password).toBe(
      '[REDACTED]',
    );

    const saved = repository.save.mock.calls[0][0];
    expect(typeof saved.stack).toBe('string');
    expect(saved.stack!.length).toBeGreaterThan(0);
    expect(saved.metadata.exceptionConstructName).toBe(
      exception.constructor.name,
    );
    expect(saved.metadata.requestTrace).toEqual(
      expect.objectContaining({
        method,
        originalUrl: requestUrl,
      }),
    );
    expect(saved.metadata.safeHeaders).toEqual(
      expect.objectContaining({
        accept: acceptHeaderValue,
      }),
    );
    expect(saved.metadata.safeHeaders).not.toHaveProperty('authorization');
    expect(saved.metadata.safeHeaders).not.toHaveProperty('user-agent');
  });

  it('swallows repository errors so logging cannot break the response flow', async () => {
    const repository = makeRepository();
    repository.save.mockRejectedValueOnce(new Error('db down'));
    const service = new IssueLogsService(repository as any);

    await expect(
      service.logException(
        new Error('Original error'),
        makeHost({
          method: 'GET',
          originalUrl: '/api/v1/student/dashboard',
          url: '/api/v1/student/dashboard',
          headers: {},
          params: {},
          query: {},
          body: {},
        }),
      ),
    ).resolves.toBeUndefined();
  });

  it('logs operational attendance failures with reason metadata', async () => {
    const repository = makeRepository();
    const service = new IssueLogsService(repository as any);

    await service.logOperationalIssue({
      eventType: 'attendance_submit_failure',
      module: 'engagement',
      stage: 'attendance_submit',
      message: 'Not authorized',
      statusCode: 400,
      userId: 'student-1',
      userEmail: 'student@example.com',
      targetType: 'participation',
      targetId: 'part-1',
      metadata: { reasonCode: 'not_authorized', hasEvidence: true },
    });

    expect(repository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'attendance_submit_failure',
        module: 'engagement',
        stage: 'attendance_submit',
        statusCode: 400,
        targetId: 'part-1',
      }),
    );
    expect(repository.save.mock.calls[0][0].metadata).toEqual(
      expect.objectContaining({ reasonCode: 'not_authorized', hasEvidence: true }),
    );
  });

  it('caps admin list page size', async () => {
    const qb = makeQueryBuilder([], 0);
    const repository = makeRepository(qb);
    const service = new IssueLogsService(repository as any);

    await service.findAll({
      page: '2',
      limit: '500',
      userEmail: 'student@example.com',
    });

    expect(qb.skip).toHaveBeenCalledWith(100);
    expect(qb.take).toHaveBeenCalledWith(100);
  });

  it('applies search and module filters via query builder', async () => {
    const qb = makeQueryBuilder([{ id: 'log-1' }], 1);
    const repository = makeRepository(qb);
    const service = new IssueLogsService(repository as any);

    const result = await service.findAll({
      search: 'Invalid credentials',
      module: 'student',
      severity: 'warning',
      page: '1',
      limit: '20',
    });

    expect(repository.createQueryBuilder).toHaveBeenCalledWith('log');
    expect(qb.andWhere).toHaveBeenCalled();
    expect(qb.orderBy).toHaveBeenCalledWith('log.createdAt', 'DESC');
    expect(result.meta?.total).toBe(1);
    expect(result.data).toHaveLength(1);
  });
});
