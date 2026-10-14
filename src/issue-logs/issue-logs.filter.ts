import { ArgumentsHost, BadRequestException, Catch } from '@nestjs/common';
import { BaseExceptionFilter, HttpAdapterHost } from '@nestjs/core';
import { IssueLogsService } from './issue-logs.service';

/** Postgres `invalid_text_representation`: a malformed uuid / number reached a query parameter. */
const PG_INVALID_TEXT_REPRESENTATION = '22P02';

/**
 * A route that passes a raw `:id` straight into a repository call would otherwise surface a
 * database error as a 500. The request itself is at fault, so answer 400 like ParseUUIDPipe does.
 */
export function translateDatabaseInputError(exception: unknown): unknown {
  const code = (exception as { driverError?: { code?: unknown }; code?: unknown } | null)?.driverError
    ?.code ?? (exception as { code?: unknown } | null)?.code;
  if (code === PG_INVALID_TEXT_REPRESENTATION) {
    return new BadRequestException('Invalid identifier in request.');
  }
  return exception;
}

@Catch()
export class IssueLogsExceptionFilter extends BaseExceptionFilter {
  constructor(
    private readonly issueLogsService: IssueLogsService,
    adapterHost: HttpAdapterHost,
  ) {
    super(adapterHost.httpAdapter);
  }

  catch(exception: unknown, host: ArgumentsHost) {
    const translated = translateDatabaseInputError(exception);
    void this.issueLogsService.logException(translated, host);
    super.catch(translated, host);
  }
}
