import { Client } from 'pg';

/**
 * Columns whose declared varchar length has grown. TypeORM `synchronize` (0.3.x, Postgres) DROPs
 * and re-ADDs a column whose length changes, which would wipe every stored value, so each one is
 * widened in place here before TypeORM connects. Widening a varchar is a catalog-only change in
 * Postgres (no rewrite, no data touched). Only ever add entries that make a column longer.
 */
export const WIDENED_COLUMNS: {
  table: string;
  column: string;
  length: number;
}[] = [{ table: 'quick_work_logs', column: 'summary', length: 1000 }];

/** `pg` ships no typings (and @types/pg is not installed): the few client members used here. */
type PgClient = {
  connect(): Promise<void>;
  query(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: { length: number | null }[] }>;
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

/**
 * Throws when the database cannot be checked: starting with `synchronize` on a column that was
 * not widened would lose its data, so a failed check must stop the boot.
 */
export async function widenColumnsBeforeSync(config: {
  host?: string;
  port?: number;
  username?: string;
  password?: string;
  database?: string;
  ssl?: { rejectUnauthorized: boolean };
}): Promise<void> {
  const client = new PgClient({
    host: config.host,
    port: config.port ? Number(config.port) : undefined,
    user: config.username,
    password: config.password,
    database: config.database,
    ssl: config.ssl,
  });
  await client.connect();
  try {
    for (const { table, column, length } of WIDENED_COLUMNS) {
      const { rows } = await client.query(
        `SELECT character_maximum_length AS length FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2`,
        [table, column],
      );
      const current = rows[0]?.length;
      // No table yet (fresh database: synchronize creates it) or already long enough.
      if (current == null || current >= length) continue;
      // Fail fast (and stop the boot) rather than queue every read of the table behind a long lock wait.
      await client.query(`SET lock_timeout = '5s'`);
      await client.query(
        `ALTER TABLE "${table}" ALTER COLUMN "${column}" TYPE varchar(${length})`,
      );
    }
  } finally {
    await client.end();
  }
}
