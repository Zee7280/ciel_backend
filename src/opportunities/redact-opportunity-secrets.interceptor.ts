import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { Observable } from 'rxjs';
import { mergeMap } from 'rxjs/operators';
import { DataSource } from 'typeorm';
import { alignFacultyDepartments } from './faculty-department-align.util';
import {
  redactOpportunityContactDetails,
  redactOpportunitySecrets,
} from './opportunity-secrets.util';

/**
 * Strips emailed magic-link credentials from every JSON response of the decorated controller, and
 * shows the registered faculty's own profile department (not what the student typed) on every card.
 */
@Injectable()
export class RedactOpportunitySecretsInterceptor implements NestInterceptor {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  intercept(
    _context: ExecutionContext,
    next: CallHandler,
  ): Observable<unknown> {
    return next
      .handle()
      .pipe(
        mergeMap(async (body) =>
          redactOpportunitySecrets(
            await alignFacultyDepartments(body, this.dataSource),
          ),
        ),
      );
  }
}

/** Browse-only endpoints (any student sees live rows): credentials AND third-party contact details. */
@Injectable()
export class RedactOpportunityBrowseInterceptor implements NestInterceptor {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  intercept(
    _context: ExecutionContext,
    next: CallHandler,
  ): Observable<unknown> {
    return next
      .handle()
      .pipe(
        mergeMap(async (body) =>
          redactOpportunityContactDetails(
            redactOpportunitySecrets(
              await alignFacultyDepartments(body, this.dataSource),
            ),
          ),
        ),
      );
  }
}

/** Alignment only (no redaction) — for admin responses that must keep every field. */
@Injectable()
export class FacultyDepartmentAlignInterceptor implements NestInterceptor {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  intercept(
    _context: ExecutionContext,
    next: CallHandler,
  ): Observable<unknown> {
    return next
      .handle()
      .pipe(
        mergeMap(async (body) =>
          alignFacultyDepartments(body, this.dataSource),
        ),
      );
  }
}
