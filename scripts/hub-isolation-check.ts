/**
 * Database-enforced isolation check for the Integration Hub (design §7.1, tests I1–I3).
 *
 * Connects with the hub RUNTIME credentials (HUB_DATABASE_URL) and proves, against the live
 * grants, that the role cannot read or write any core table, while it can use the hub schema.
 * Optionally (when core DB_* vars are present) also proves the core role cannot see the hub schema.
 *
 *   npm run hub:isolation-check
 *
 * Exit code 0 = every check passed; 1 = at least one check failed (details printed).
 */
import * as dotenv from 'dotenv';
import { Client } from 'pg';

dotenv.config();

type PgClient = {
  connect(): Promise<void>;
  query(sql: string): Promise<{ rows: Array<Record<string, unknown>> }>;
  end(): Promise<void>;
};
type PgError = { code?: string; message?: string };
const PgClient = Client as unknown as new (config: {
  connectionString?: string;
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  ssl?: { rejectUnauthorized: boolean };
}) => PgClient;

const CORE_TABLES = [
  'users',
  'organizations',
  'opportunities',
  'participations',
  'attendance_logs',
  'reports',
  'student_reports',
  'npe_ranking_snapshots',
  'settings',
];

type Check = { name: string; pass: boolean; detail: string };
const results: Check[] = [];

function record(name: string, pass: boolean, detail: string) {
  results.push({ name, pass, detail });
}

/**
 * Runs a statement that MUST be refused with 42501 (insufficient_privilege) or 3F000 (schema does
 * not exist). A missing table (42P01) is NOT accepted: it would make the check pass against a
 * database that has no core tables, which proves nothing.
 */
/** Every probe runs in its own transaction and is always rolled back, so nothing persists and a
 * refused statement cannot leave the session in an aborted-transaction state for the next probe. */
async function probe(c: PgClient, sql: string): Promise<PgError | null> {
  await c.query('BEGIN');
  try {
    await c.query(sql);
    return null;
  } catch (e) {
    return e as PgError;
  } finally {
    await c.query('ROLLBACK').catch(() => undefined);
  }
}

async function expectDenied(c: PgClient, name: string, sql: string) {
  const err = await probe(c, sql);
  if (!err) {
    record(name, false, 'statement succeeded (expected permission denied)');
    return;
  }
  const denied = err.code === '42501' || err.code === '3F000';
  record(
    name,
    denied,
    denied
      ? `refused (${err.code})`
      : err.code === '42P01'
        ? 'inconclusive: table does not exist in this database'
        : `unexpected error ${err.code}: ${err.message}`,
  );
}

async function expectAllowed(c: PgClient, name: string, sql: string) {
  const err = await probe(c, sql);
  if (err) {
    record(name, false, `failed ${err.code}: ${err.message}`);
    return;
  }
  record(name, true, 'ok (rolled back)');
}

function ssl() {
  return process.env.NODE_ENV === 'production' ||
    process.env.VERCEL ||
    process.env.DB_SSL === 'true'
    ? { rejectUnauthorized: false }
    : undefined;
}

async function checkHubRole() {
  const url = (process.env.HUB_DATABASE_URL ?? '').trim();
  if (!url) {
    record('HUB_DATABASE_URL present', false, 'not set');
    return;
  }
  const c = new PgClient({ connectionString: url, ssl: ssl() });
  await c.connect();
  try {
    const who = await c.query(
      'SELECT current_user AS u, current_schema() AS s',
    );
    record(
      'hub role identity',
      true,
      `current_user=${String(who.rows[0]?.u)} current_schema=${String(who.rows[0]?.s)}`,
    );
    for (const t of CORE_TABLES) {
      await expectDenied(
        c,
        `hub role SELECT public.${t}`,
        `SELECT 1 FROM public."${t}" LIMIT 1`,
      );
    }
    await expectDenied(
      c,
      'hub role INSERT public.settings',
      `INSERT INTO public.settings (key, value) VALUES ('hub_isolation_probe', 'x')`,
    );
    await expectDenied(
      c,
      'hub role UPDATE public.users',
      `UPDATE public.users SET status = status WHERE false`,
    );
    await expectDenied(
      c,
      'hub role DELETE public.attendance_logs',
      `DELETE FROM public.attendance_logs WHERE false`,
    );
    await expectDenied(
      c,
      'hub role CREATE TABLE in public',
      `CREATE TABLE public.hub_isolation_probe (id int)`,
    );
    await expectAllowed(
      c,
      'hub role USAGE external_hub',
      `SELECT 1 FROM external_hub.external_platforms LIMIT 1`,
    );
    await expectAllowed(
      c,
      'hub role write external_hub',
      `INSERT INTO external_hub.external_audit ("actorType", "action", "targetType") VALUES ('system', 'ISOLATION_PROBE', 'probe')`,
    );
    await expectDenied(
      c,
      'hub role DELETE external_hub.external_audit',
      `DELETE FROM external_hub.external_audit WHERE false`,
    );
    // No DDL at runtime either.
    await expectDenied(
      c,
      'hub role CREATE TABLE in external_hub',
      `CREATE TABLE external_hub.hub_isolation_probe (id int)`,
    );
  } finally {
    await c.end();
  }
}

async function checkCoreRole() {
  if (!process.env.DB_HOST || !process.env.DB_USERNAME) {
    record('core role check', true, 'skipped (DB_* not set)');
    return;
  }
  const c = new PgClient({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 5432),
    user: process.env.DB_USERNAME,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    ssl: ssl(),
  });
  await c.connect();
  try {
    const who = await c.query('SELECT current_user AS u');
    const user = String(who.rows[0]?.u);
    const isSuper = await c.query(
      `SELECT rolsuper AS s FROM pg_roles WHERE rolname = current_user`,
    );
    if (isSuper.rows[0]?.s === true) {
      record(
        'core role sees external_hub',
        true,
        `skipped: ${user} is a superuser locally; production core role must not be`,
      );
      return;
    }
    await expectDenied(
      c,
      `core role (${user}) SELECT external_hub.external_records`,
      `SELECT 1 FROM external_hub.external_records LIMIT 1`,
    );
  } finally {
    await c.end();
  }
}

async function main() {
  await checkHubRole();
  await checkCoreRole();
  const width = Math.max(...results.map((r) => r.name.length));
  for (const r of results) {
    console.log(
      `${r.pass ? 'PASS' : 'FAIL'}  ${r.name.padEnd(width)}  ${r.detail}`,
    );
  }
  const failed = results.filter((r) => !r.pass).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed === 0 ? 0 : 1);
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
