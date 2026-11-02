import {
  decodeCursor,
  encodeCursor,
  keysetWhere,
  paginate,
  parseDateParam,
  parseExportQuery,
  parseLimit,
} from './export-cursor.util';
import {
  HUB_EXPORT_DEFAULT_LIMIT,
  HUB_EXPORT_MAX_LIMIT,
} from './export-scopes.constants';

describe('export cursor util', () => {
  it('round-trips a cursor and rejects garbage', () => {
    const c = { u: '2026-11-01T10:00:00.000Z', i: 'abc' };
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
    expect(decodeCursor(undefined)).toBeNull();
    expect(decodeCursor('')).toBeNull();
    expect(() => decodeCursor('not-base64-json')).toThrow(/next_cursor/);
    expect(() =>
      decodeCursor(Buffer.from('{"u":"nope","i":"x"}').toString('base64url')),
    ).toThrow(/next_cursor/);
  });

  it('parses limit with default and cap', () => {
    expect(parseLimit(undefined)).toBe(HUB_EXPORT_DEFAULT_LIMIT);
    expect(parseLimit('50')).toBe(50);
    expect(parseLimit('999999')).toBe(HUB_EXPORT_MAX_LIMIT);
    expect(() => parseLimit('0')).toThrow(/limit/);
    expect(() => parseLimit('abc')).toThrow(/limit/);
  });

  it('parses dates as ISO or calendar day (UTC)', () => {
    expect(parseDateParam(undefined, 'from')).toBeNull();
    expect(parseDateParam('2026-09-01', 'from')?.toISOString()).toBe(
      '2026-09-01T00:00:00.000Z',
    );
    expect(() => parseDateParam('31/12/2026', 'to')).toThrow(/ISO date/);
  });

  it('paginates limit+1 fetches into a page with a cursor at the last row', () => {
    const rows = [1, 2, 3].map((n) => ({
      id: `id-${n}`,
      updatedAt: new Date(Date.UTC(2026, 0, n)),
    }));
    const page = paginate(rows, 2, (r) => r);
    expect(page.rows.map((r) => r.id)).toEqual(['id-1', 'id-2']);
    expect(page.has_more).toBe(true);
    expect(decodeCursor(page.next_cursor)).toEqual({
      u: '2026-01-02T00:00:00.000Z',
      i: 'id-2',
    });
    const last = paginate(rows.slice(2), 2, (r) => r);
    expect(last.has_more).toBe(false);
    expect(paginate([], 2, (r: { id: string; updatedAt: Date }) => r)).toEqual({
      rows: [],
      next_cursor: null,
      has_more: false,
    });
  });

  it('builds keyset conditions only for what was supplied', () => {
    expect(keysetWhere('u', null, null)).toEqual([]);
    const q = parseExportQuery({
      cursor: encodeCursor({ u: '2026-01-02T00:00:00.000Z', i: 'id-2' }),
      limit: '10',
      updated_since: '2026-01-01',
    });
    const parts = keysetWhere('u', q.cursor, q.updatedSince);
    expect(parts).toHaveLength(2);
    expect(parts[0].sql).toContain('u.updatedAt >= :ksSince');
    expect(parts[1].sql).toContain('u.updatedAt > :ksU');
    expect(parts[1].sql).toContain('u.id > :ksI');
    expect(parts[1].params.ksI).toBe('id-2');
  });
});
