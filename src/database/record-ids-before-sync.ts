import { Logger } from '@nestjs/common';
import { Client } from 'pg';

/**
 * Applies the public-record-id columns and indexes to the five record tables the moment a new
 * deploy boots, *before* TypeORM `synchronize` looks at the schema — so "deploy" and "DB
 * execution" are one step, with nothing to run by hand.
 *
 * Why not leave it to `synchronize`: it would do the same work, but with no lock timeout and a
 * plain index build per table at an unpredictable moment. Doing it here means:
 *   - one instance does it (a Postgres advisory lock serialises concurrent cold starts; the others
 *     wait, then find everything in place);
 *   - every lock wait is capped (`lock_timeout`), so it can never queue the live API behind it;
 *   - it is a no-op (a single cheap catalog query) once applied, so cold starts stay fast;
 *   - the names are exactly what TypeORM generates, so `synchronize` afterwards has nothing left
 *     to change on these tables (`record-ids-before-sync.spec.ts` guards that).
 *
 * Purely additive (nullable columns without default, new indexes): nothing is dropped, rewritten
 * or backfilled. Failure is NOT fatal — nothing here protects data (unlike widenColumnsBeforeSync),
 * and `synchronize` would still add the same objects — so a lock timeout is logged and the boot
 * continues.
 */
export const RECORD_ID_TABLES = [
  'student_reports',
  'quick_work_logs',
  'venture_entries',
  'course_project_entries',
  'fyp_entries',
] as const;

export const RECORD_ID_COLUMNS = [
  { name: 'universityId', ddl: 'uuid' },
  { name: 'publicId', ddl: 'character varying(32)' },
] as const;

/** Index names TypeORM generates for these entities (asserted against its naming strategy in the spec). */
export const RECORD_ID_INDEXES: {
  table: (typeof RECORD_ID_TABLES)[number];
  column: 'universityId' | 'publicId';
  name: string;
  unique: boolean;
}[] = [
  {
    table: 'student_reports',
    column: 'universityId',
    name: 'IDX_86e4bd2e14c1e49d7ac3c7d624',
    unique: false,
  },
  {
    table: 'student_reports',
    column: 'publicId',
    name: 'IDX_6397abf2b8bf12e5364951871d',
    unique: true,
  },
  {
    table: 'quick_work_logs',
    column: 'universityId',
    name: 'IDX_f6e8277e677cc02f6f66a720b5',
    unique: false,
  },
  {
    table: 'quick_work_logs',
    column: 'publicId',
    name: 'IDX_2b8be486509e18fb137011049f',
    unique: true,
  },
  {
    table: 'venture_entries',
    column: 'universityId',
    name: 'IDX_59abfaaf314d87a9452c8fcde3',
    unique: false,
  },
  {
    table: 'venture_entries',
    column: 'publicId',
    name: 'IDX_69643699b5c7498ed55c956680',
    unique: true,
  },
  {
    table: 'course_project_entries',
    column: 'universityId',
    name: 'IDX_218eeeebae9716f97415725a29',
    unique: false,
  },
  {
    table: 'course_project_entries',
    column: 'publicId',
    name: 'IDX_04a1c7f1c373419635aba92253',
    unique: true,
  },
  {
    table: 'fyp_entries',
    column: 'universityId',
    name: 'IDX_4a1eb0b5b2f16c2dbed738ead1',
    unique: false,
  },
  {
    table: 'fyp_entries',
    column: 'publicId',
    name: 'IDX_85ba9a9bb077c744595d47f3ce',
    unique: true,
  },
];

/** Arbitrary constant: the advisory-lock key for this migration step. */
const ADVISORY_LOCK_KEY = 7_204_261_001;

type Row = Record<string, string>;
type PgClient = {
  connect(): Promise<void>;
  query(sql: string, params?: unknown[]): Promise<{ rows: Row[] }>;
  end(): Promise<void>;
};
const PgClient = Client as unknown as new (config: {
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  ssl?: { rejectUnauthorized: boolean };
}) => PgClient;

export type RecordIdsPrepConfig = {
  host?: string;
  port?: number;
  username?: string;
  password?: string;
  database?: string;
  ssl?: { rejectUnauthorized: boolean };
};

/** What is still missing, from the catalog. Tables that do not exist yet are left to `synchronize`. */
async function findMissing(client: PgClient) {
  const tables = (
    await client.query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = current_schema() AND table_name = ANY($1)`,
      [RECORD_ID_TABLES],
    )
  ).rows.map((r) => r.table_name);
  if (!tables.length)
    return { tables, columns: [] as string[], indexes: [] as string[] };
  const haveCols = new Set(
    (
      await client.query(
        `SELECT table_name || '.' || column_name AS k FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name = ANY($1)
            AND column_name = ANY($2)`,
        [tables, RECORD_ID_COLUMNS.map((c) => c.name)],
      )
    ).rows.map((r) => r.k),
  );
  const haveIdx = new Set(
    (
      await client.query(
        `SELECT indexname FROM pg_indexes
          WHERE schemaname = current_schema() AND indexname = ANY($1)`,
        [RECORD_ID_INDEXES.map((i) => i.name)],
      )
    ).rows.map((r) => r.indexname),
  );
  const columns: string[] = [];
  for (const t of tables)
    for (const c of RECORD_ID_COLUMNS)
      if (!haveCols.has(`${t}.${c.name}`)) columns.push(`${t}.${c.name}`);
  const indexes = RECORD_ID_INDEXES.filter(
    (i) => tables.includes(i.table) && !haveIdx.has(i.name),
  ).map((i) => i.name);
  return { tables, columns, indexes };
}

/** Never throws. Returns what it applied (for logs / tests). */
export async function prepareRecordIdsBeforeSync(
  config: RecordIdsPrepConfig,
  logger: Pick<Logger, 'log' | 'warn'> = new Logger('RecordIdsBeforeSync'),
): Promise<{ columns: number; indexes: number }> {
  const applied = { columns: 0, indexes: 0 };
  let client: PgClient | null = null;
  let locked = false;
  try {
    client = new PgClient({
      host: config.host,
      port: config.port ? Number(config.port) : undefined,
      user: config.username,
      password: config.password,
      database: config.database,
      ssl: config.ssl,
    });
    await client.connect();
    let missing = await findMissing(client);
    if (!missing.columns.length && !missing.indexes.length) return applied; // fast path

    // Serialise concurrent cold starts: the first does the work, the rest wait and re-check.
    await client.query(`SET lock_timeout = '30s'`);
    await client.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_KEY]);
    locked = true;
    missing = await findMissing(client);
    // From here every lock wait on a live table is short: fail fast instead of queueing the API.
    await client.query(`SET lock_timeout = '5s'`);

    for (const key of missing.columns) {
      const [table, column] = key.split('.');
      const def = RECORD_ID_COLUMNS.find((c) => c.name === column)!;
      await client.query(
        `ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS "${column}" ${def.ddl}`,
      );
      applied.columns += 1;
    }
    for (const idx of RECORD_ID_INDEXES.filter((i) =>
      missing.indexes.includes(i.name),
    )) {
      await client.query(
        `CREATE ${idx.unique ? 'UNIQUE ' : ''}INDEX IF NOT EXISTS "${idx.name}" ON "${idx.table}" ("${idx.column}")`,
      );
      applied.indexes += 1;
    }
    if (applied.columns || applied.indexes) {
      logger.log(
        `Public record ids: added ${applied.columns} column(s) and ${applied.indexes} index(es) before schema sync.`,
      );
    }
  } catch (err) {
    logger.warn(
      `Public record ids pre-sync step did not finish (${(err as Error)?.message ?? err}); ` +
        'schema sync will apply the same additive changes.',
    );
  } finally {
    if (client) {
      try {
        if (locked)
          await client.query('SELECT pg_advisory_unlock($1)', [
            ADVISORY_LOCK_KEY,
          ]);
      } catch {
        /* the session ends right below, which releases the lock anyway */
      }
      await client.end().catch(() => undefined);
    }
  }
  return applied;
}
