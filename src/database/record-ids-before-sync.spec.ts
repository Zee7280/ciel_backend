import { DefaultNamingStrategy } from 'typeorm';
import {
  prepareRecordIdsBeforeSync,
  RECORD_ID_COLUMNS,
  RECORD_ID_INDEXES,
  RECORD_ID_TABLES,
} from './record-ids-before-sync';
import { CourseProjectEntry } from '../paths/entities/course-project-entry.entity';
import { FypEntry } from '../paths/entities/fyp-entry.entity';
import { VentureEntry } from '../paths/entities/venture-entry.entity';
import { QuickWorkLog } from '../quick-work/entities/quick-work-log.entity';
import { StudentReport } from '../reports/entities/student-report.entity';

type Q = { sql: string; params?: unknown[] };
let queries: Q[];
let script: (
  sql: string,
  params?: unknown[],
) => { rows: Record<string, string>[] };
let failOn: RegExp | null;
const end = jest.fn(() => Promise.resolve());

jest.mock('pg', () => ({
  Client: jest.fn().mockImplementation(() => ({
    connect: jest.fn(() => Promise.resolve()),
    end: (...a: unknown[]) =>
      (end as unknown as (...x: unknown[]) => Promise<void>)(...a),
    query: jest.fn((sql: string, params?: unknown[]) => {
      queries.push({ sql, params });
      if (failOn && failOn.test(sql))
        return Promise.reject(new Error('lock timeout'));
      return Promise.resolve(script(sql, params));
    }),
  })),
}));

const logger = { log: jest.fn(), warn: jest.fn() };
const ALL_TABLES = RECORD_ID_TABLES.map((t) => ({ table_name: t }));
const ddl = () => queries.filter((q) => /^(ALTER|CREATE)/.test(q.sql));

beforeEach(() => {
  queries = [];
  failOn = null;
  end.mockClear();
  logger.log.mockClear();
  logger.warn.mockClear();
});

/** A catalog that reports `tables`, plus the given already-present columns / indexes. */
const catalog =
  (tables: string[], cols: string[] = [], idx: string[] = []) =>
  (sql: string) => {
    if (/information_schema\.tables/.test(sql))
      return { rows: tables.map((t) => ({ table_name: t })) };
    if (/information_schema\.columns/.test(sql))
      return { rows: cols.map((k) => ({ k })) };
    if (/pg_indexes/.test(sql))
      return { rows: idx.map((indexname) => ({ indexname })) };
    return { rows: [] };
  };

describe('index names', () => {
  it('match exactly what TypeORM generates, so synchronize finds them already in place', () => {
    const naming = new DefaultNamingStrategy();
    const entities = {
      student_reports: StudentReport,
      quick_work_logs: QuickWorkLog,
      venture_entries: VentureEntry,
      course_project_entries: CourseProjectEntry,
      fyp_entries: FypEntry,
    } as const;
    expect(Object.keys(entities).sort()).toEqual([...RECORD_ID_TABLES].sort());
    for (const idx of RECORD_ID_INDEXES) {
      expect(idx.name).toBe(naming.indexName(idx.table, [idx.column]));
    }
    expect(RECORD_ID_INDEXES).toHaveLength(RECORD_ID_TABLES.length * 2);
  });

  it('declares publicId unique and universityId non-unique, as the entities do', () => {
    for (const idx of RECORD_ID_INDEXES)
      expect(idx.unique).toBe(idx.column === 'publicId');
  });
});

describe('prepareRecordIdsBeforeSync', () => {
  it('does nothing on a brand-new database (synchronize creates the tables itself)', async () => {
    script = catalog([]);
    await expect(prepareRecordIdsBeforeSync({}, logger)).resolves.toEqual({
      columns: 0,
      indexes: 0,
    });
    expect(ddl()).toHaveLength(0);
    expect(queries.some((q) => /advisory/.test(q.sql))).toBe(false);
  });

  it('adds every missing column and index on an existing database, under a lock with timeouts', async () => {
    script = catalog(ALL_TABLES.map((t) => t.table_name));
    const out = await prepareRecordIdsBeforeSync({}, logger);
    expect(out).toEqual({ columns: 10, indexes: 10 });
    const adds = ddl().filter((q) => q.sql.startsWith('ALTER'));
    expect(adds).toHaveLength(10);
    for (const q of adds) expect(q.sql).toMatch(/ADD COLUMN IF NOT EXISTS/);
    const creates = ddl().filter((q) => q.sql.startsWith('CREATE'));
    expect(creates).toHaveLength(10);
    for (const q of creates) expect(q.sql).toMatch(/INDEX IF NOT EXISTS/);
    expect(creates.filter((q) => /UNIQUE/.test(q.sql))).toHaveLength(5);
    // nothing destructive, ever
    expect(
      queries.some((q) => /DROP|DELETE|UPDATE|TRUNCATE/i.test(q.sql)),
    ).toBe(false);
    // lock_timeout is set before any DDL, and the advisory lock is taken and released
    const firstDdl = queries.findIndex((q) => /^(ALTER|CREATE)/.test(q.sql));
    expect(
      queries.slice(0, firstDdl).some((q) => /lock_timeout = '5s'/.test(q.sql)),
    ).toBe(true);
    expect(queries.some((q) => /pg_advisory_lock/.test(q.sql))).toBe(true);
    expect(queries.some((q) => /pg_advisory_unlock/.test(q.sql))).toBe(true);
    expect(end).toHaveBeenCalled();
  });

  it('is a no-op after it has run once (no lock, no DDL)', async () => {
    const cols = RECORD_ID_TABLES.flatMap((t) =>
      RECORD_ID_COLUMNS.map((c) => `${t}.${c.name}`),
    );
    script = catalog(
      [...RECORD_ID_TABLES],
      cols,
      RECORD_ID_INDEXES.map((i) => i.name),
    );
    await expect(prepareRecordIdsBeforeSync({}, logger)).resolves.toEqual({
      columns: 0,
      indexes: 0,
    });
    expect(ddl()).toHaveLength(0);
    expect(queries.some((q) => /advisory/.test(q.sql))).toBe(false);
    expect(queries).toHaveLength(3); // tables, columns, indexes — nothing else
  });

  it('only adds what is missing (a partially applied earlier run)', async () => {
    const cols = ['fyp_entries.universityId', 'fyp_entries.publicId'];
    script = catalog([...RECORD_ID_TABLES], cols, [
      'IDX_4a1eb0b5b2f16c2dbed738ead1',
    ]);
    const out = await prepareRecordIdsBeforeSync({}, logger);
    expect(out.columns).toBe(8);
    expect(out.indexes).toBe(9);
    expect(ddl().some((q) => /"fyp_entries"\s+ADD/.test(q.sql))).toBe(false);
  });

  it('skips tables that do not exist yet', async () => {
    script = catalog(['fyp_entries']);
    const out = await prepareRecordIdsBeforeSync({}, logger);
    expect(out).toEqual({ columns: 2, indexes: 2 });
    expect(ddl().every((q) => /fyp_entries/.test(q.sql))).toBe(true);
  });

  it('never throws: a lock timeout is logged, the lock is released and the boot goes on', async () => {
    script = catalog([...RECORD_ID_TABLES]);
    failOn = /^ALTER TABLE "quick_work_logs"/;
    await expect(prepareRecordIdsBeforeSync({}, logger)).resolves.toBeDefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('did not finish'),
    );
    expect(queries.some((q) => /pg_advisory_unlock/.test(q.sql))).toBe(true);
    expect(end).toHaveBeenCalled();
  });

  it('never throws when the database cannot be reached at all', async () => {
    script = () => {
      throw new Error('ECONNREFUSED');
    };
    await expect(prepareRecordIdsBeforeSync({}, logger)).resolves.toEqual({
      columns: 0,
      indexes: 0,
    });
    expect(logger.warn).toHaveBeenCalled();
  });
});
