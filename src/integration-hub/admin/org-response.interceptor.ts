import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, map } from 'rxjs';

/** Keys an organization user never needs; removed from every org-side response. */
const STRIP_ANYWHERE = new Set(['bucket', 'storageKey', 'secretCiphertext']);
/** Platform-admin internals removed from any nested `platform` object. */
const STRIP_IN_PLATFORM = new Set([
  'settings',
  'technicalContact',
  'agreementReference',
  'createdByUserId',
  'suspensionReason',
]);

export function sanitizeForOrg(value: unknown, parentKey = ''): unknown {
  if (Array.isArray(value))
    return value.map((v) => sanitizeForOrg(v, parentKey));
  if (value instanceof Date) return value;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (STRIP_ANYWHERE.has(k)) continue;
      if (parentKey === 'platform' && STRIP_IN_PLATFORM.has(k)) continue;
      out[k] = sanitizeForOrg(v, k);
    }
    return out;
  }
  return value;
}

/** Projects org-side responses to the fields an organization is entitled to see. */
@Injectable()
export class OrgResponseInterceptor implements NestInterceptor {
  intercept(
    _context: ExecutionContext,
    next: CallHandler,
  ): Observable<unknown> {
    return next.handle().pipe(map((body) => sanitizeForOrg(body)));
  }
}
