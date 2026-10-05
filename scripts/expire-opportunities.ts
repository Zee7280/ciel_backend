/**
 * Super Admin expire for listings that still accept applies.
 * Listings stay on Explore/Browse; Join/Apply closes. Reports and attendance stay.
 *
 *   DRY RUN (default):  npx ts-node scripts/expire-opportunities.ts
 *   APPLY:              npx ts-node scripts/expire-opportunities.ts --apply
 *   PROD:               npx ts-node scripts/expire-opportunities.ts --env-file=/path/to/prod.env --apply
 */
import { Client } from 'pg';
import * as fs from 'fs';
import * as path from 'path';

function envFileFromArgs(): string {
  const hit = process.argv.find((a) => a.startsWith('--env-file='));
  if (hit) return hit.slice('--env-file='.length);
  return path.join(__dirname, '..', '.env');
}

function loadDotEnv() {
  const envPath = envFileFromArgs();
  if (!fs.existsSync(envPath)) return;
  const force = process.argv.some((a) => a.startsWith('--env-file='));
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (force || process.env[key] === undefined) process.env[key] = value;
  }
}

async function main() {
  loadDotEnv();
  const apply = process.argv.includes('--apply');
  const host = process.env.DB_HOST || '127.0.0.1';
  const local = host === '127.0.0.1' || host === 'localhost';
  const client = new Client({
    host,
    port: Number(process.env.DB_PORT || 5432),
    user: process.env.DB_USERNAME || 'postgres',
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    ssl: local ? undefined : { rejectUnauthorized: false },
  });
  console.log(`DB host: ${host}  db: ${process.env.DB_NAME || '(unset)'}`);
  await client.connect();
  try {
    const { rows } = await client.query<{
      id: string;
      title: string;
      status: string;
      admin_hidden: boolean;
    }>(
      `SELECT id, title, status, admin_hidden
         FROM opportunities
        WHERE COALESCE(admin_expired, false) = false
        ORDER BY "createdAt" DESC`,
    );
    console.log(
      `${apply ? 'APPLY' : 'DRY RUN'}: ${rows.length} listing(s) still accepting applies`,
    );
    for (const row of rows) {
      console.log(`  - ${row.id}  [${row.status}]  ${row.title}${row.admin_hidden ? ' (hidden)' : ''}`);
    }
    if (!apply) {
      console.log('Re-run with --apply to set admin_expired = true (apply closed, listing stays visible).');
      return;
    }
    const updated = await client.query(
      `UPDATE opportunities
          SET admin_expired = true
        WHERE COALESCE(admin_expired, false) = false`,
    );
    console.log(`Expired ${updated.rowCount ?? 0} listing(s).`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
