import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import {
  redactOpportunityContactDetails,
  redactOpportunitySecrets,
} from './opportunity-secrets.util';

/** Strips emailed magic-link credentials from every JSON response of the decorated controller. */
@Injectable()
export class RedactOpportunitySecretsInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(map((body) => redactOpportunitySecrets(body)));
  }
}

/** Browse-only endpoints (any student sees live rows): credentials AND third-party contact details. */
@Injectable()
export class RedactOpportunityBrowseInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next
      .handle()
      .pipe(
        map((body) =>
          redactOpportunityContactDetails(redactOpportunitySecrets(body)),
        ),
      );
  }
}
