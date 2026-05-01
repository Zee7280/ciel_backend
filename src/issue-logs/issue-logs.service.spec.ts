import { ArgumentsHost, BadRequestException } from '@nestjs/common';
import { IssueLogsService } from './issue-logs.service';

describe('IssueLogsService', () => {
  const makeHost = (request: any): ArgumentsHost =>
    ({
      switchToHttp: () => ({
        getRequest: () => request,
      }),
    }) as any;

  const makeRepository = () => ({
    create: jest.fn((value) => value),
    save: jest.fn().mockResolvedValue(undefined),
    findAndCount: jest.fn().mockResolvedValue([[], 0]),
    findOne: jest.fn().mockResolvedValue(null),
  });

  it('logs user-facing report errors with safe metadata', async () => {
    const repository = makeRepository();
    const service = new IssueLogsService(repository as any);
    const exception = new BadRequestException('Report validation failed');

    await service.logException(
      exception,
      makeHost({
        method: 'POST',
        originalUrl: '/api/v1/student/reports/project-1/submit',
        url: '/api/v1/student/reports/project-1/submit',
        route: { path: '/student/reports/:id/submit' },
        ip: '127.0.0.1',
        headers: {
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

  it('caps admin list page size', async () => {
    const repository = makeRepository();
    const service = new IssueLogsService(repository as any);

    await service.findAll({
      page: '2',
      limit: '500',
      userEmail: 'student@example.com',
    });

    expect(repository.findAndCount).toHaveBeenCalledWith(
      expect.objectContaining({
        skip: 100,
        take: 100,
      }),
    );
  });
});
