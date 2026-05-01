import { ArgumentsHost, Catch } from '@nestjs/common';
import { BaseExceptionFilter, HttpAdapterHost } from '@nestjs/core';
import { IssueLogsService } from './issue-logs.service';

@Catch()
export class IssueLogsExceptionFilter extends BaseExceptionFilter {
  constructor(
    private readonly issueLogsService: IssueLogsService,
    adapterHost: HttpAdapterHost,
  ) {
    super(adapterHost.httpAdapter);
  }

  catch(exception: unknown, host: ArgumentsHost) {
    void this.issueLogsService.logException(exception, host);
    super.catch(exception, host);
  }
}
