import { createHash } from 'crypto';

/** A retried identical POST /opportunities inside this window returns the row already created. */
export const CREATE_DEDUPE_WINDOW_MS = 2 * 60 * 1000;

/** Statuses that never block a fresh create (creator gave up / it was closed). */
export const CREATE_DEDUPE_IGNORED_STATUSES = ['rejected', 'deleted', 'cancelled', 'draft'];

export function normalizeCreateTitle(title: unknown): string {
  return String(title ?? '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** JSON with sorted keys and undefined dropped, so key order / omitted fields do not matter. */
export function stableStringify(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

export function createPayloadFingerprint(input: {
  creatorId: string;
  organizationId: string | null;
  body: Record<string, unknown>;
}): string {
  const { title, ...rest } = input.body;
  return createHash('sha256')
    .update(
      stableStringify({
        creatorId: input.creatorId,
        organizationId: input.organizationId,
        title: normalizeCreateTitle(title),
        body: rest,
      }),
    )
    .digest('hex');
}
