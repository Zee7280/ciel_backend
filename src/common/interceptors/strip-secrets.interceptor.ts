import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

/** Keys that must never leave the server in an API response, whatever endpoint produced them. */
const SECRET_KEYS = new Set([
  'password',
  'passwordResetToken',
  'passwordResetExpiry',
]);

/**
 * Magic-link / approval tokens. The frontend only ever needs to know that one is outstanding
 * (non-empty string), never its value: anyone who reads a token can approve, reject or request
 * revision on behalf of the Faculty / Partner / executing organisation. The value is masked, the
 * key stays so presence checks keep working.
 */
const MASKED_TOKEN_KEYS = new Set([
  'faculty_verification_token',
  'execution_verification_token',
  'executionVerificationToken',
  'facultyVerificationToken',
  'partnerToken',
  'liaisonToken',
]);
export const MASKED_TOKEN_PLACEHOLDER = 'hidden';

/**
 * Last line of defence against a service accidentally serialising a whole User entity (bcrypt
 * hash, plaintext reset token). Removes the secret keys from the response tree. Pure and
 * cycle-safe; Dates / Buffers / non-plain objects are passed through untouched.
 */
export function stripSecrets<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date || Buffer.isBuffer(value)) return value;
  const obj = value as unknown as object;
  if (seen.has(obj)) return value;
  seen.add(obj);
  if (Array.isArray(value)) {
    return value.map((v) => stripSecrets(v, seen)) as unknown as T;
  }
  const proto = Object.getPrototypeOf(value);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEYS.has(k)) continue;
    if (MASKED_TOKEN_KEYS.has(k)) {
      out[k] =
        typeof v === 'string' && v.trim() ? MASKED_TOKEN_PLACEHOLDER : v;
      continue;
    }
    out[k] = stripSecrets(v, seen);
  }
  // Keep entity prototypes (class instances serialise through toJSON-less default anyway).
  return (proto && proto !== Object.prototype
    ? Object.assign(Object.create(proto), out)
    : out) as T;
}

@Injectable()
export class StripSecretsInterceptor implements NestInterceptor {
  intercept(_ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(map((body) => stripSecrets(body)));
  }
}
