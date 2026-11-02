/**
 * University Export API smoke test — calls the export endpoints the way a university's ERP would
 * (HMAC-signed, cursor-paged) and prints what comes back. Use it to verify a connection end to end
 * after Admin → Integrations has issued a credential and authorised the connection.
 *
 *   CIEL_BASE=https://cielbackend-ecru.vercel.app \
 *   CIEL_KEY_ID=hk_... CIEL_SECRET=... CIEL_CONNECTION_ID=<uuid> \
 *   npm run hub:export -- students            # first page
 *   npm run hub:export -- students --all      # every page, prints count + last cursor
 *   npm run hub:export -- community-service --source=quick --limit=5
 *   npm run hub:export -- summary --from=2026-09-01 --to=2027-01-31
 *   npm run hub:export -- students --cursor=<next_cursor>   # resume a sync
 *
 * Resources: students | opportunities | community-service | fyp | ventures | summary
 * Exit code 0 on HTTP 200, 1 otherwise (the body is printed either way).
 */
import * as dotenv from 'dotenv';
import { signHubRequest } from '../src/integration-hub/security/hub-hmac.util';

dotenv.config();

const BASE = (process.env.CIEL_BASE ?? process.env.BASE_URL ?? '').replace(
  /\/$/,
  '',
);
const KEY_ID = process.env.CIEL_KEY_ID ?? '';
const SECRET = process.env.CIEL_SECRET ?? '';
const CONNECTION_ID = process.env.CIEL_CONNECTION_ID ?? '';

const RESOURCES = [
  'students',
  'opportunities',
  'community-service',
  'fyp',
  'ventures',
  'summary',
];

function fail(msg: string): never {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

const [resource, ...flags] = process.argv.slice(2);
if (!resource || !RESOURCES.includes(resource)) {
  fail(`resource must be one of: ${RESOURCES.join(', ')}`);
}
if (!BASE || !KEY_ID || !SECRET || !CONNECTION_ID) {
  fail('set CIEL_BASE, CIEL_KEY_ID, CIEL_SECRET and CIEL_CONNECTION_ID');
}
const opt = (name: string): string | undefined => {
  const hit = flags.find((f) => f.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
};
const all = flags.includes('--all');

const path = `/api/integrations/v1/export/${resource}`;

async function page(query: Record<string, string>) {
  const q = new URLSearchParams(query);
  const headers = signHubRequest({
    keyId: KEY_ID,
    secret: SECRET,
    method: 'GET',
    path,
    body: '',
  });
  const started = Date.now();
  const res = await fetch(`${BASE}${path}?${q.toString()}`, { headers });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    json = { raw: text.slice(0, 500) };
  }
  return { status: res.status, json, ms: Date.now() - started, res };
}

async function main() {
  const base: Record<string, string> = { connection_id: CONNECTION_ID };
  for (const k of ['limit', 'updated_since', 'source', 'from', 'to']) {
    const v = opt(k);
    if (v) base[k] = v;
  }
  let cursor = opt('cursor');
  let pages = 0;
  let rows = 0;
  for (;;) {
    const r = await page(cursor ? { ...base, cursor } : base);
    pages += 1;
    const cache = r.res.headers.get('cache-control');
    if (r.status !== 200) {
      console.log(`HTTP ${r.status} (${r.ms} ms)`);
      console.log(JSON.stringify(r.json, null, 2));
      process.exit(1);
    }
    if (resource === 'summary') {
      console.log(`HTTP 200 (${r.ms} ms)  cache-control: ${cache}`);
      console.log(JSON.stringify(r.json, null, 2));
      return;
    }
    const pg = (r.json.page ?? {}) as {
      count?: number;
      has_more?: boolean;
      next_cursor?: string | null;
    };
    const list = (r.json.rows ?? []) as unknown[];
    rows += list.length;
    if (pages === 1) {
      console.log(
        `HTTP 200 (${r.ms} ms)  organization: ${JSON.stringify(r.json.organization)}  personal_fields: ${String(r.json.personal_fields)}  cache-control: ${cache}`,
      );
      console.log('first row:', JSON.stringify(list[0] ?? null, null, 2));
    }
    console.log(
      `page ${pages}: ${pg.count ?? list.length} rows, has_more=${String(pg.has_more)}`,
    );
    if (!all || !pg.has_more || !pg.next_cursor) {
      console.log(`total rows seen: ${rows}`);
      console.log(`next_cursor: ${pg.next_cursor ?? 'null'}`);
      return;
    }
    cursor = pg.next_cursor;
  }
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
