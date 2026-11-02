import { HttpException, HttpStatus } from '@nestjs/common';
import {
  HUB_EXPORT_DEFAULT_LIMIT,
  HUB_EXPORT_MAX_LIMIT,
} from './export-scopes.constants';

/** Error shape every export endpoint returns: `{ success: false, code, message }`. */
export class HubExportError extends HttpException {
  constructor(status: HttpStatus, code: string, message: string) {
    super({ success: false, code, message }, status);
  }
}

/**
 * Keyset cursor: the last row's `updated_at` (ISO) and `id`. Rows are served in
 * (updated_at ASC, id ASC) order, so a consumer that stores the last cursor and re-calls gets only
 * rows changed since, and re-running after a crash is safe (a row is never skipped, at worst
 * repeated). Opaque to callers: base64url JSON.
 */
export type ExportCursor = { u: string; i: string };

export function encodeCursor(cursor: ExportCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodeCursor(raw: unknown): ExportCursor | null {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string' || raw.length > 400) {
    throw new HubExportError(
      HttpStatus.BAD_REQUEST,
      'CURSOR_INVALID',
      'cursor must be the next_cursor value from a previous page',
    );
  }
  try {
    const parsed = JSON.parse(
      Buffer.from(raw, 'base64url').toString('utf8'),
    ) as Partial<ExportCursor>;
    if (
      !parsed ||
      typeof parsed.u !== 'string' ||
      typeof parsed.i !== 'string' ||
      Number.isNaN(new Date(parsed.u).getTime()) ||
      !parsed.i
    ) {
      throw new Error('shape');
    }
    return { u: parsed.u, i: parsed.i };
  } catch {
    throw new HubExportError(
      HttpStatus.BAD_REQUEST,
      'CURSOR_INVALID',
      'cursor must be the next_cursor value from a previous page',
    );
  }
}

export function parseLimit(raw: unknown): number {
  if (raw === undefined || raw === null || raw === '') {
    return HUB_EXPORT_DEFAULT_LIMIT;
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new HubExportError(
      HttpStatus.BAD_REQUEST,
      'LIMIT_INVALID',
      `limit must be an integer between 1 and ${HUB_EXPORT_MAX_LIMIT}`,
    );
  }
  return Math.min(n, HUB_EXPORT_MAX_LIMIT);
}

/** `updated_since` / `from` / `to`: ISO date-time or YYYY-MM-DD (treated as UTC midnight). */
export function parseDateParam(raw: unknown, name: string): Date | null {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string' || raw.length > 40) {
    throw new HubExportError(
      HttpStatus.BAD_REQUEST,
      'DATE_INVALID',
      `${name} must be an ISO date (YYYY-MM-DD) or date-time`,
    );
  }
  const text = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T00:00:00.000Z` : raw;
  const d = new Date(text);
  if (Number.isNaN(d.getTime())) {
    throw new HubExportError(
      HttpStatus.BAD_REQUEST,
      'DATE_INVALID',
      `${name} must be an ISO date (YYYY-MM-DD) or date-time`,
    );
  }
  return d;
}

export type ExportQuery = {
  cursor: ExportCursor | null;
  limit: number;
  updatedSince: Date | null;
};

export function parseExportQuery(q: Record<string, unknown>): ExportQuery {
  return {
    cursor: decodeCursor(q.cursor),
    limit: parseLimit(q.limit),
    updatedSince: parseDateParam(q.updated_since, 'updated_since'),
  };
}

/**
 * Takes `limit + 1` rows fetched in cursor order and returns the page plus the cursor pointing at
 * its last row. `updatedAt` / `id` are read from each row by the given accessors.
 */
export function paginate<T>(
  fetched: T[],
  limit: number,
  key: (row: T) => { updatedAt: Date | string; id: string },
): { rows: T[]; next_cursor: string | null; has_more: boolean } {
  const has_more = fetched.length > limit;
  const rows = has_more ? fetched.slice(0, limit) : fetched;
  const last = rows[rows.length - 1];
  const next_cursor = last
    ? encodeCursor({
        u: new Date(key(last).updatedAt).toISOString(),
        i: key(last).id,
      })
    : null;
  return { rows, next_cursor, has_more };
}

/** SQL fragment + params for the keyset condition on `<alias>.updatedAt` / `<alias>.id`. */
export function keysetWhere(
  alias: string,
  cursor: ExportCursor | null,
  updatedSince: Date | null,
  prefix = 'ks',
): { sql: string; params: Record<string, string | Date> }[] {
  const out: { sql: string; params: Record<string, string | Date> }[] = [];
  if (updatedSince) {
    out.push({
      sql: `${alias}.updatedAt >= :${prefix}Since`,
      params: { [`${prefix}Since`]: updatedSince },
    });
  }
  if (cursor) {
    out.push({
      sql: `(${alias}.updatedAt > :${prefix}U OR (${alias}.updatedAt = :${prefix}U AND ${alias}.id > :${prefix}I))`,
      params: { [`${prefix}U`]: new Date(cursor.u), [`${prefix}I`]: cursor.i },
    });
  }
  return out;
}
