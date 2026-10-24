/**
 * Integration Hub end-to-end flow against a running backend (design §7.1 / §7.2).
 *
 * Drives the real HTTP API as three parties — Super Admin (JWT), Organization admin (JWT) and a
 * simulated vendor (HMAC) — and asserts isolation: core row counts are identical before and after.
 *
 *   BASE_URL=http://127.0.0.1:3977 npm run hub:e2e
 *
 * Tokens: pass ADMIN_TOKEN / ORG_TOKEN, or let the script mint them locally from JWT_SECRET for
 * users it picks from the core database (requires DB_* env of a LOCAL database).
 */
import * as dotenv from 'dotenv';
import * as crypto from 'crypto';
import * as jwt from 'jsonwebtoken';
import { Client } from 'pg';
import { signHubRequest } from '../src/integration-hub/security/hub-hmac.util';

dotenv.config();

const BASE = (process.env.BASE_URL ?? 'http://127.0.0.1:3977').replace(
  /\/$/,
  '',
);
const CRON_SECRET = process.env.CRON_SECRET ?? '';

type PgClient = {
  connect(): Promise<void>;
  query(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: Array<Record<string, unknown>> }>;
  end(): Promise<void>;
};
const PgClient = Client as unknown as new (
  config: Record<string, unknown>,
) => PgClient;

type Json = Record<string, unknown>;
const results: Array<{ name: string; pass: boolean; detail: string }> = [];
function check(name: string, pass: boolean, detail = '') {
  results.push({ name, pass, detail });
  console.log(
    `${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`,
  );
}

async function call(
  method: string,
  path: string,
  opts: {
    token?: string;
    body?: unknown;
    headers?: Record<string, string>;
  } = {},
): Promise<{ status: number; json: Json }> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  let body: string | undefined;
  if (opts.body !== undefined) {
    body = JSON.stringify(opts.body);
    headers['Content-Type'] = 'application/json';
  }
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const res = await fetch(`${BASE}${path}`, { method, headers, body });
  const text = await res.text();
  let json: Json = {};
  try {
    json = text ? (JSON.parse(text) as Json) : {};
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json };
}

/** Vendor call: HMAC-signed over the exact body bytes. */
async function vendor(
  method: string,
  path: string,
  cred: { keyId: string; secret: string },
  body?: unknown,
  overrides: Partial<{ secret: string; nonce: string; timestamp: string }> = {},
) {
  const raw = body === undefined ? '' : JSON.stringify(body);
  const headers = signHubRequest({
    keyId: cred.keyId,
    secret: overrides.secret ?? cred.secret,
    method,
    path,
    body: raw,
    nonce: overrides.nonce,
    timestamp: overrides.timestamp,
  });
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...headers,
      ...(raw ? { 'Content-Type': 'application/json' } : {}),
    },
    body: raw || undefined,
  });
  const text = await res.text();
  let json: Json = {};
  try {
    json = text ? (JSON.parse(text) as Json) : {};
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json };
}

function core(): PgClient {
  return new PgClient({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 5432),
    user: process.env.DB_USERNAME,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  });
}

const CORE_TABLES = [
  'users',
  'organizations',
  'opportunities',
  'participations',
  'attendance_logs',
  'reports',
  'student_reports',
  'npe_ranking_snapshots',
];

async function coreCounts(c: PgClient): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of CORE_TABLES) {
    const r = await c.query(`SELECT COUNT(*)::int AS n FROM public."${t}"`);
    out[t] = Number(r.rows[0]?.n ?? 0);
  }
  return out;
}

async function mintTokens(c: PgClient): Promise<{
  admin: string;
  org: string;
  orgId: string;
  orgName: string;
  otherOrgId: string | null;
}> {
  const secret = process.env.JWT_SECRET;
  if (!secret)
    throw new Error('JWT_SECRET missing; pass ADMIN_TOKEN/ORG_TOKEN instead');
  const admin = (
    await c.query(
      `SELECT id, email, role, "tokenVersion" FROM public.users WHERE role = 'admin' AND status = 'active' LIMIT 1`,
    )
  ).rows[0];
  const org = (
    await c.query(
      `SELECT u.id, u.email, u.role, u."tokenVersion", u."organizationId" AS org_id, o.name AS org_name
         FROM public.users u JOIN public.organizations o ON o.id = u."organizationId"
        WHERE u.role IN ('university','ngo','corporate','organization_admin') AND u.status = 'active'
          AND o."verificationStatus" = 'APPROVED' LIMIT 1`,
    )
  ).rows[0];
  if (!admin || !org)
    throw new Error(
      'Need one active admin and one active org user with an APPROVED organization',
    );
  const other = (
    await c.query(
      `SELECT id FROM public.organizations WHERE id <> $1 LIMIT 1`,
      [org.org_id],
    )
  ).rows[0];
  const sign = (u: Record<string, unknown>) =>
    jwt.sign(
      {
        sub: u.id,
        email: u.email,
        role: u.role,
        organizationId: u.org_id ?? undefined,
        tokenVersion: u.tokenVersion ?? 0,
      },
      secret,
      { expiresIn: '1h' },
    );
  return {
    admin: process.env.ADMIN_TOKEN ?? sign(admin),
    org: process.env.ORG_TOKEN ?? sign(org),
    orgId: String(org.org_id),
    orgName: String(org.org_name),
    otherOrgId: other ? String(other.id) : null,
  };
}

async function main() {
  const db = core();
  await db.connect();
  const before = await coreCounts(db);
  const t = await mintTokens(db);
  const stamp = Date.now().toString(36);
  const A = `/api/v1/admin/integrations`;
  const O = `/api/v1/org/integrations`;
  const V = `/api/integrations/v1`;

  // ---- admin: platform, credential, metrics ---------------------------------------------------
  const health0 = await call('GET', `${A}/health`, { token: t.admin });
  check(
    'admin health reachable',
    health0.status === 200,
    `status ${health0.status}`,
  );

  const created = await call('POST', `${A}/platforms`, {
    token: t.admin,
    body: {
      name: `E2E Vendor ${stamp}`,
      slug: `e2e-vendor-${stamp}`,
      integrationMode: 'push',
      approvedEventTypes: [
        'activity.session',
        'impact.metric',
        'evidence.item',
        'activity.corrected',
        'activity.voided',
      ],
      settings: { rate_limit_per_minute: 600, max_batch_size: 20 },
    },
  });
  const platform = created.json.data as Json;
  check(
    'platform registered (sandbox)',
    created.status === 201 && platform?.status === 'sandbox',
    `status ${created.status}`,
  );
  const platformId = String(platform?.id);

  const cred = await call('POST', `${A}/platforms/${platformId}/credentials`, {
    token: t.admin,
    body: { label: 'e2e' },
  });
  const credential = cred.json.data as {
    keyId: string;
    secret: string;
    id: string;
  };
  check(
    'credential issued with one-time secret',
    cred.status === 201 && !!credential?.secret,
    `keyId ${credential?.keyId}`,
  );

  for (const m of [
    {
      code: 'trees_planted',
      name: 'Trees planted',
      unit: 'count',
      dataType: 'integer',
      aggregation: 'sum',
      minValue: 0,
      maxValue: 100000,
      sdgs: [13, 15],
    },
    {
      code: 'volunteer_hours',
      name: 'Volunteer hours',
      unit: 'hours',
      dataType: 'number',
      aggregation: 'sum',
      minValue: 0,
    },
  ]) {
    const r = await call('POST', `${A}/metrics`, { token: t.admin, body: m });
    check(
      `metric ${m.code} in catalog`,
      r.status === 201 || r.status === 409,
      `status ${r.status}`,
    );
  }

  // ---- connection lifecycle: admin proposes → org approves → admin authorizes ------------------
  const proposed = await call('POST', `${A}/connections`, {
    token: t.admin,
    body: {
      platformId,
      organizationId: t.orgId,
      purpose: 'E2E plantation pilot',
      dpaReference: `DPA-${stamp}`,
      referralDomain: 'app.e2e-vendor.test',
    },
  });
  const connection = proposed.json.data as Json;
  check(
    'connection proposed',
    proposed.status === 201 && connection?.status === 'proposed',
    `status ${proposed.status}`,
  );
  const connectionId = String(connection?.id);

  const orgList = await call('GET', `${O}/connections`, { token: t.org });
  const orgSees =
    Array.isArray(orgList.json.rows) &&
    (orgList.json.rows as Json[]).some((c) => c.id === connectionId);
  check('org sees its proposed connection', orgList.status === 200 && orgSees);

  const approved = await call(
    'POST',
    `${O}/connections/${connectionId}/approve`,
    { token: t.org },
  );
  check(
    'org approves connection',
    approved.status === 201 &&
      (approved.json.data as Json)?.status === 'org_approved',
    `status ${approved.status}`,
  );

  const early = await vendor('POST', `${V}/events`, credential, [
    sessionEvent(connectionId, `pre-${stamp}`, 'act-early'),
  ]);
  const earlyReceipt = (early.json.receipts as Json[] | undefined)?.[0];
  check(
    'vendor cannot submit before authorization',
    early.status === 200 &&
      earlyReceipt?.status === 'rejected' &&
      earlyReceipt?.error_code === 'CONNECTION_NOT_ACTIVE',
    `status ${early.status} ${String(earlyReceipt?.error_code)}`,
  );

  const authorized = await call(
    'POST',
    `${A}/connections/${connectionId}/authorize`,
    { token: t.admin },
  );
  check(
    'admin authorizes connection',
    authorized.status === 201 &&
      (authorized.json.data as Json)?.status === 'active',
    `status ${authorized.status}`,
  );

  // ---- vendor auth negative cases --------------------------------------------------------------
  const noAuth = await call('GET', `${V}/status`);
  check('vendor route without signature → 401', noAuth.status === 401);
  const jwtOnVendor = await call('GET', `${V}/status`, { token: t.admin });
  check('JWT on vendor route → 401', jwtOnVendor.status === 401);
  const badSig = await vendor('GET', `${V}/status`, credential, undefined, {
    secret: 'wrong-secret',
  });
  check(
    'wrong secret → 401 HUB_SIGNATURE_INVALID',
    badSig.status === 401 && badSig.json.code === 'HUB_SIGNATURE_INVALID',
    String(badSig.json.code),
  );
  const staleTs = await vendor('GET', `${V}/status`, credential, undefined, {
    timestamp: String(Math.floor(Date.now() / 1000) - 1000),
  });
  check(
    'stale timestamp → 401',
    staleTs.status === 401 && staleTs.json.code === 'HUB_TIMESTAMP_STALE',
    String(staleTs.json.code),
  );
  const nonce = crypto.randomBytes(16).toString('hex');
  const first = await vendor('GET', `${V}/status`, credential, undefined, {
    nonce,
  });
  const replay = await vendor('GET', `${V}/status`, credential, undefined, {
    nonce,
  });
  check(
    'nonce replay → 401',
    first.status === 200 &&
      replay.status === 401 &&
      replay.json.code === 'HUB_NONCE_REPLAYED',
    `${first.status}/${replay.status}`,
  );
  const machineOnCore = await vendor('GET', `/api/v1/user/me`, credential);
  check(
    'machine credentials on a core JWT route → 401',
    machineOnCore.status === 401,
    `status ${machineOnCore.status}`,
  );

  const status = await vendor('GET', `${V}/status`, credential);
  const statusConns = (status.json.connections as Json[] | undefined) ?? [];
  check(
    'vendor status lists its active connection',
    status.status === 200 &&
      statusConns.some(
        (c) => c.connection_id === connectionId && c.status === 'active',
      ),
  );

  // ---- ingestion: session → processed inline (200), duplicate, correction, void -----------------
  const actId = `plant-${stamp}`;
  const e1 = await vendor('POST', `${V}/events`, credential, {
    events: [
      sessionEvent(connectionId, `evt-${stamp}-1`, actId, {
        trees_planted: 40,
        volunteer_hours: 32,
      }),
    ],
  });
  const r1 = (e1.json.receipts as Json[] | undefined)?.[0];
  check(
    'session event processed inline → 200',
    e1.status === 200 && r1?.status === 'processed',
    `status ${e1.status} ${String(r1?.status)} ${typeof r1?.error_code === 'string' ? r1.error_code : ''}`,
  );
  const receiptId = String(r1?.receipt_id);

  const dup = await vendor('POST', `${V}/events`, credential, [
    sessionEvent(connectionId, `evt-${stamp}-1`, actId, { trees_planted: 40 }),
  ]);
  const rd = (dup.json.receipts as Json[] | undefined)?.[0];
  check(
    'replayed event_id → duplicate, same receipt',
    rd?.status === 'duplicate' && rd?.receipt_id === receiptId,
  );

  const receipt = await vendor('GET', `${V}/events/${receiptId}`, credential);
  check(
    'receipt lookup for own event',
    receipt.status === 200 &&
      (receipt.json.receipt as Json)?.status === 'processed',
  );
  const foreign = await vendor(
    'GET',
    `${V}/events/${crypto.randomUUID()}`,
    credential,
  );
  check('receipt lookup for unknown id → 404', foreign.status === 404);

  const badMetric = await vendor('POST', `${V}/events`, credential, [
    sessionEvent(connectionId, `evt-${stamp}-bad`, `other-${stamp}`, {
      not_a_metric: 1,
    }),
  ]);
  const rb = (badMetric.json.receipts as Json[] | undefined)?.[0];
  check(
    'unknown metric → rejected METRIC_INVALID',
    rb?.status === 'rejected' && rb?.error_code === 'METRIC_INVALID',
    String(rb?.error_code),
  );

  const personal = await vendor('POST', `${V}/events`, credential, [
    {
      ...sessionEvent(connectionId, `evt-${stamp}-pii`, `pii-${stamp}`),
      payload: { participants: [{ student_name: 'A Student', hours: 4 }] },
    },
  ]);
  const rp = (personal.json.receipts as Json[] | undefined)?.[0];
  check(
    'personal fields on a non-personal connection → rejected',
    rp?.status === 'rejected' && rp?.error_code === 'PERSONAL_DATA_NOT_ALLOWED',
    String(rp?.error_code),
  );

  const outOfScope = await vendor('POST', `${V}/events`, credential, [
    {
      ...sessionEvent(connectionId, `evt-${stamp}-x`, actId),
      connection_id: crypto.randomUUID(),
    },
  ]);
  const rx = (outOfScope.json.receipts as Json[] | undefined)?.[0];
  check(
    'foreign connection id → rejected CONNECTION_NOT_FOUND',
    rx?.status === 'rejected' && rx?.error_code === 'CONNECTION_NOT_FOUND',
    String(rx?.error_code),
  );

  const corr = await vendor('POST', `${V}/events`, credential, [
    {
      ...sessionEvent(connectionId, `evt-${stamp}-2`, actId, {
        trees_planted: 32,
        volunteer_hours: 32,
      }),
      event_type: 'activity.corrected',
      correlation: { corrects: `evt-${stamp}-1` },
    },
  ]);
  const rc = (corr.json.receipts as Json[] | undefined)?.[0];
  check(
    'correction processed (40 → 32 trees)',
    corr.status === 200 && rc?.status === 'processed',
    String(rc?.error_code ?? rc?.status),
  );

  const summaries = await call(
    'GET',
    `${A}/summaries?connectionId=${connectionId}`,
    { token: t.admin },
  );
  const connAll = ((summaries.json.data as Json[]) ?? []).find(
    (s) => s.scopeKey === 'connection' && s.period === 'all',
  );
  const totals = (connAll?.metricTotals as Record<string, number>) ?? {};
  check(
    'summary reflects the correction only',
    totals.trees_planted === 32 &&
      totals.volunteer_hours === 32 &&
      connAll?.recordCount === 1,
    JSON.stringify(totals),
  );
  const rebuilt = await call(
    'POST',
    `${A}/connections/${connectionId}/rebuild-summaries`,
    { token: t.admin },
  );
  const summariesAfterRebuild = await call(
    'GET',
    `${A}/summaries?connectionId=${connectionId}`,
    { token: t.admin },
  );
  const rebuiltAll = ((summariesAfterRebuild.json.data as Json[]) ?? []).find(
    (s) => s.scopeKey === 'connection' && s.period === 'all',
  );
  check(
    'rebuilt summaries equal incrementally maintained ones',
    rebuilt.status === 201 &&
      JSON.stringify(rebuiltAll?.metricTotals) === JSON.stringify(totals) &&
      rebuiltAll?.recordCount === 1,
    JSON.stringify(rebuiltAll?.metricTotals),
  );

  const records = await call(
    'GET',
    `${A}/records?connectionId=${connectionId}`,
    { token: t.admin },
  );
  const current = ((records.json.rows as Json[]) ?? []).find(
    (r) => r.externalActivityId === actId,
  );
  check(
    'one current record, version 2',
    !!current && current.version === 2 && current.status === 'current',
    `version ${String(current?.version)}`,
  );
  const recordId = String(current?.id);

  const detail = await call('GET', `${A}/records/${recordId}`, {
    token: t.admin,
  });
  const versions = ((detail.json.data as Json)?.versions as Json[]) ?? [];
  check(
    'record detail shows both versions',
    detail.status === 200 && versions.length === 2,
  );

  const review = await call('POST', `${A}/records/${recordId}/review`, {
    token: t.admin,
    body: { reviewState: 'reviewed', note: 'e2e' },
  });
  check(
    'admin review state stored',
    review.status === 201 &&
      (review.json.data as Json)?.reviewState === 'reviewed',
  );

  const orgRec = await call('GET', `${O}/records/${recordId}`, {
    token: t.org,
  });
  check('org reads its own record', orgRec.status === 200);
  const orgEvents = await call(
    'GET',
    `${A}/events?connectionId=${connectionId}`,
    { token: t.admin },
  );
  check(
    'admin events list has the processed + rejected rows',
    orgEvents.status === 200 && Number(orgEvents.json.total) >= 3,
    `total ${String(orgEvents.json.total)}`,
  );

  const voided = await vendor('POST', `${V}/events`, credential, [
    {
      ...sessionEvent(connectionId, `evt-${stamp}-3`, actId),
      event_type: 'activity.voided',
      payload: undefined,
      metrics: undefined,
    },
  ]);
  const rv = (voided.json.receipts as Json[] | undefined)?.[0];
  check(
    'void processed',
    rv?.status === 'processed',
    String(rv?.error_code ?? rv?.status),
  );
  const summaries2 = await call(
    'GET',
    `${A}/summaries?connectionId=${connectionId}`,
    { token: t.admin },
  );
  const connAll2 = ((summaries2.json.data as Json[]) ?? []).find(
    (s) => s.scopeKey === 'connection' && s.period === 'all',
  );
  const totals2 = (connAll2?.metricTotals as Record<string, number>) ?? {};
  check(
    'summary after void is zero',
    totals2.trees_planted === 0 && connAll2?.recordCount === 0,
    JSON.stringify(totals2),
  );
  const resubmit = await vendor('POST', `${V}/events`, credential, [
    sessionEvent(connectionId, `evt-${stamp}-4`, actId, { trees_planted: 7 }),
  ]);
  const rr = (resubmit.json.receipts as Json[] | undefined)?.[0];
  const afterResubmit = await call(
    'GET',
    `${A}/records?connectionId=${connectionId}&q=${actId}`,
    { token: t.admin },
  );
  const resubmitted = ((afterResubmit.json.rows as Json[]) ?? []).find(
    (r) => r.externalActivityId === actId,
  );
  check(
    'activity re-submitted after void becomes version 3',
    rr?.status === 'processed' &&
      resubmitted?.version === 3 &&
      resubmitted?.status === 'current',
    `${String(rr?.status)} v${String(resubmitted?.version)}`,
  );
  const replayProcessed = await call(
    'POST',
    `${A}/events/${receiptId}/replay`,
    { token: t.admin },
  );
  check(
    'replaying a processed event is refused (400)',
    replayProcessed.status === 400,
    `status ${replayProcessed.status}`,
  );
  const badFilter = await call('GET', `${A}/records?connectionId=not-a-uuid`, {
    token: t.admin,
  });
  check(
    'malformed uuid filter → 400 not 500',
    badFilter.status === 400,
    `status ${badFilter.status}`,
  );
  const formBody = 'events[0][event_id]=x';
  const formHeaders = signHubRequest({
    keyId: credential.keyId,
    secret: credential.secret,
    method: 'POST',
    path: `${V}/events`,
    body: formBody,
  });
  const formRes = await fetch(`${BASE}${V}/events`, {
    method: 'POST',
    headers: {
      ...formHeaders,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: formBody,
  });
  check(
    'non-JSON vendor body → 415',
    formRes.status === 415,
    `status ${formRes.status}`,
  );

  // ---- batch, 202 path and sweeper ------------------------------------------------------------
  const batch = Array.from({ length: 5 }, (_, i) =>
    sessionEvent(connectionId, `evt-${stamp}-b${i}`, `batch-${stamp}-${i}`, {
      trees_planted: 5,
    }),
  );
  const eb = await vendor('POST', `${V}/events`, credential, { events: batch });
  const statuses = ((eb.json.receipts as Json[]) ?? []).map((r) => r.status);
  check(
    'batch of 5 accepted',
    (eb.status === 200 || eb.status === 202) &&
      statuses.length === 5 &&
      statuses.every((s) => s === 'processed' || s === 'received'),
    `${eb.status} ${statuses.join(',')}`,
  );
  const sweep = await call('POST', `${A}/events/sweep`, { token: t.admin });
  check(
    'admin sweep runs',
    sweep.status === 201 &&
      typeof (sweep.json.data as Json)?.claimed === 'number',
  );
  if (CRON_SECRET) {
    const cronSweep = await call(
      'GET',
      `/api/v1/internal/jobs/hub-retry-sweeper`,
      { headers: { Authorization: `Bearer ${CRON_SECRET}` } },
    );
    check('cron sweeper endpoint with secret → 200', cronSweep.status === 200);
    const cronNo = await call('GET', `/api/v1/internal/jobs/hub-retry-sweeper`);
    check('cron sweeper endpoint without secret → 401', cronNo.status === 401);
    const retention = await call('GET', `/api/v1/internal/jobs/hub-retention`, {
      headers: { Authorization: `Bearer ${CRON_SECRET}` },
    });
    check(
      'cron retention endpoint runs',
      retention.status === 200 &&
        typeof retention.json.connections_scanned === 'number',
      `status ${retention.status}`,
    );
  }

  // ---- evidence: ticket → direct upload → complete → link → authorized view -------------------
  const cfg = ((health0.json.data as Json)?.configuration as Json) ?? {};
  if (
    process.env.HUB_E2E_EVIDENCE === '1' &&
    cfg.evidence_storage_configured === true
  ) {
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
      'base64',
    );
    const sha = crypto.createHash('sha256').update(png).digest('hex');
    const badMime = await vendor(
      'POST',
      `${V}/evidence/upload-ticket`,
      credential,
      {
        connection_id: connectionId,
        content_type: 'text/html',
        size_bytes: png.length,
      },
    );
    check(
      'upload ticket with disallowed mime → 400',
      badMime.status === 400 &&
        badMime.json.code === 'EVIDENCE_TYPE_NOT_ALLOWED',
      String(badMime.json.code),
    );
    const ticketRes = await vendor(
      'POST',
      `${V}/evidence/upload-ticket`,
      credential,
      {
        connection_id: connectionId,
        content_type: 'image/png',
        size_bytes: png.length,
        original_name: 'e2e.png',
      },
    );
    const ticket = ticketRes.json.ticket as
      | {
          upload_id: string;
          upload_url: string;
          headers: Record<string, string>;
        }
      | undefined;
    check(
      'upload ticket issued',
      ticketRes.status === 201 && !!ticket?.upload_url,
      `status ${ticketRes.status}`,
    );
    // Video and audio evidence use the same path as images.
    const clip = Buffer.from('e2e-not-a-real-video-but-bytes-are-bytes');
    const clipSha = crypto.createHash('sha256').update(clip).digest('hex');
    const videoTicketRes = await vendor(
      'POST',
      `${V}/evidence/upload-ticket`,
      credential,
      {
        connection_id: connectionId,
        content_type: 'video/mp4',
        size_bytes: clip.length,
        original_name: 'e2e.mp4',
      },
    );
    const videoTicket = videoTicketRes.json.ticket as
      | {
          upload_id: string;
          upload_url: string;
          headers: Record<string, string>;
        }
      | undefined;
    let videoAccepted = false;
    if (videoTicket) {
      const putClip = await fetch(videoTicket.upload_url, {
        method: 'PUT',
        headers: videoTicket.headers,
        body: clip,
      });
      const doneClip = await vendor(
        'POST',
        `${V}/evidence/${videoTicket.upload_id}/complete`,
        credential,
        { sha256: clipSha },
      );
      const evClip = doneClip.json.evidence as Json | undefined;
      videoAccepted = putClip.status === 200 && evClip?.state === 'accepted';
    }
    check(
      'video/mp4 evidence ticket, upload and completion',
      videoTicketRes.status === 201 && videoAccepted,
      `status ${videoTicketRes.status}`,
    );
    if (ticket) {
      const put = await fetch(ticket.upload_url, {
        method: 'PUT',
        headers: ticket.headers,
        body: png,
      });
      check(
        'direct PUT to quarantine succeeds',
        put.status === 200,
        `status ${put.status}`,
      );
      const done = await vendor(
        'POST',
        `${V}/evidence/${ticket.upload_id}/complete`,
        credential,
        { sha256: sha },
      );
      const ev = done.json.evidence as Json | undefined;
      check(
        'evidence completed and accepted with matching hash',
        done.status === 200 && ev?.state === 'accepted' && ev?.sha256 === sha,
        `status ${done.status} ${String(ev?.state)}`,
      );
      const evId = String(ev?.evidence_id);
      const withEvidence = await vendor('POST', `${V}/events`, credential, [
        {
          ...sessionEvent(connectionId, `evt-${stamp}-ev`, `ev-${stamp}`, {
            trees_planted: 3,
          }),
          evidence: [{ upload_id: ticket.upload_id }],
        },
      ]);
      const rev = (withEvidence.json.receipts as Json[] | undefined)?.[0];
      check(
        'event referencing evidence processed',
        rev?.status === 'processed',
        String(rev?.error_code ?? rev?.status),
      );
      const recs = await call(
        'GET',
        `${A}/records?connectionId=${connectionId}&q=ev-${stamp}`,
        { token: t.admin },
      );
      const evRecord = ((recs.json.rows as Json[]) ?? [])[0];
      const evDetail = evRecord
        ? await call('GET', `${A}/records/${String(evRecord.id)}`, {
            token: t.admin,
          })
        : null;
      const linked = ((evDetail?.json.data as Json)?.evidence as Json[]) ?? [];
      check(
        'evidence linked to the record',
        linked.length === 1 && linked[0].state === 'accepted',
        `${linked.length} linked`,
      );
      const adminView = await call('GET', `${A}/evidence/${evId}/view-url`, {
        token: t.admin,
      });
      const urlRaw = (adminView.json.data as Json)?.url;
      const url = typeof urlRaw === 'string' ? urlRaw : '';
      const fetched = url ? await fetch(url) : null;
      const bytes = fetched
        ? Buffer.from(await fetched.arrayBuffer())
        : Buffer.alloc(0);
      check(
        'admin signed view URL serves the object',
        adminView.status === 200 &&
          fetched?.status === 200 &&
          bytes.equals(png),
        `status ${fetched?.status}`,
      );
      const orgDenied = await call('GET', `${O}/evidence/${evId}/view-url`, {
        token: t.org,
      });
      check(
        'org cannot open originals without explicit permission → 404',
        orgDenied.status === 404,
        `${orgDenied.status}`,
      );
      await call('PATCH', `${A}/connections/${connectionId}`, {
        token: t.admin,
        body: { orgEvidenceOpenAllowed: true },
      });
      const orgAllowed = await call('GET', `${O}/evidence/${evId}/view-url`, {
        token: t.org,
      });
      check(
        'org can open originals once granted',
        orgAllowed.status === 200,
        `${orgAllowed.status}`,
      );
      const unknownUpload = await vendor('POST', `${V}/events`, credential, [
        {
          ...sessionEvent(connectionId, `evt-${stamp}-ev2`, `ev2-${stamp}`),
          evidence: [{ upload_id: crypto.randomUUID() }],
        },
      ]);
      const ru = (unknownUpload.json.receipts as Json[] | undefined)?.[0];
      check(
        'unknown evidence upload id → rejected EVIDENCE_NOT_FOUND',
        ru?.status === 'rejected' && ru?.error_code === 'EVIDENCE_NOT_FOUND',
        String(ru?.error_code),
      );
      const pendingTicket = await vendor(
        'POST',
        `${V}/evidence/upload-ticket`,
        credential,
        {
          connection_id: connectionId,
          content_type: 'image/png',
          size_bytes: png.length,
        },
      );
      const pendingUpload = (
        pendingTicket.json.ticket as { upload_id: string } | undefined
      )?.upload_id;
      const notAccepted = await vendor('POST', `${V}/events`, credential, [
        {
          ...sessionEvent(connectionId, `evt-${stamp}-ev3`, `ev3-${stamp}`),
          evidence: [{ upload_id: pendingUpload }],
        },
      ]);
      const rna = (notAccepted.json.receipts as Json[] | undefined)?.[0];
      check(
        'evidence never completed → rejected EVIDENCE_NOT_ACCEPTED',
        rna?.status === 'rejected' &&
          rna?.error_code === 'EVIDENCE_NOT_ACCEPTED',
        String(rna?.error_code),
      );
      const orgEvidence = await call(
        'GET',
        `${O}/evidence?connectionId=${connectionId}`,
        { token: t.org },
      );
      const orgEvRow = ((orgEvidence.json.rows as Json[]) ?? [])[0];
      check(
        'org evidence view hides storage internals',
        orgEvidence.status === 200 &&
          !!orgEvRow &&
          !('bucket' in orgEvRow) &&
          !('storageKey' in orgEvRow),
      );
    }
  } else {
    check(
      'evidence flow',
      true,
      'skipped (set HUB_E2E_EVIDENCE=1 with storage configured)',
    );
  }

  // ---- suspension semantics -------------------------------------------------------------------
  const susp = await call('POST', `${A}/connections/${connectionId}/suspend`, {
    token: t.admin,
    body: { reason: 'e2e' },
  });
  check(
    'admin suspends connection',
    susp.status === 201 && (susp.json.data as Json)?.status === 'suspended',
  );
  const whileSuspended = await vendor('POST', `${V}/events`, credential, [
    sessionEvent(connectionId, `evt-${stamp}-s`, `s-${stamp}`),
  ]);
  const rs = (whileSuspended.json.receipts as Json[] | undefined)?.[0];
  check(
    'submission while suspended → rejected CONNECTION_NOT_ACTIVE',
    rs?.status === 'rejected' && rs?.error_code === 'CONNECTION_NOT_ACTIVE',
    String(rs?.error_code),
  );
  const resumed = await call(
    'POST',
    `${A}/connections/${connectionId}/resume`,
    { token: t.admin },
  );
  check(
    'admin resumes connection',
    resumed.status === 201 && (resumed.json.data as Json)?.status === 'active',
  );

  const platSusp = await call('POST', `${A}/platforms/${platformId}/status`, {
    token: t.admin,
    body: { status: 'suspended', reason: 'e2e' },
  });
  const platCall = await vendor('GET', `${V}/status`, credential);
  check(
    'suspended platform cannot authenticate → 403',
    platSusp.status === 201 &&
      platCall.status === 403 &&
      platCall.json.code === 'PLATFORM_SUSPENDED',
    `${platCall.status}`,
  );
  await call('POST', `${A}/platforms/${platformId}/status`, {
    token: t.admin,
    body: { status: 'live' },
  });

  const revoked = await call(
    'POST',
    `${A}/platforms/${platformId}/credentials/${credential.id}/revoke`,
    { token: t.admin },
  );
  const afterRevoke = await vendor('GET', `${V}/status`, credential);
  check(
    'revoked credential → 401',
    revoked.status === 201 && afterRevoke.status === 401,
    `${afterRevoke.status}`,
  );

  // ---- organization scoping -------------------------------------------------------------------
  const orgOther = await call(
    'GET',
    `${O}/connections?organizationId=${t.otherOrgId ?? crypto.randomUUID()}`,
    { token: t.org },
  );
  const leaked = ((orgOther.json.rows as Json[]) ?? []).some(
    (c) => c.organizationId !== t.orgId,
  );
  check(
    'org cannot widen scope via query param',
    orgOther.status === 200 && !leaked,
  );
  const orgConn = await call('GET', `${O}/connections/${connectionId}`, {
    token: t.org,
  });
  const orgPlatformView = ((orgConn.json.data as Json)?.connection as Json)
    ?.platform as Json | undefined;
  check(
    'org connection view hides platform internals',
    orgConn.status === 200 &&
      !!orgPlatformView &&
      !('settings' in orgPlatformView) &&
      !('technicalContact' in orgPlatformView) &&
      typeof orgPlatformView.name === 'string',
  );
  const orgOnAdmin = await call('GET', `${A}/platforms`, { token: t.org });
  check(
    'org token on admin console → 403',
    orgOnAdmin.status === 403,
    `${orgOnAdmin.status}`,
  );
  const adminOnOrg = await call('GET', `${O}/connections`, { token: t.admin });
  check(
    'admin token on org routes → 403 (separate interface)',
    adminOnOrg.status === 403,
    `${adminOnOrg.status}`,
  );

  // ---- audit + health -------------------------------------------------------------------------
  const audit = await call('GET', `${A}/audit?connectionId=${connectionId}`, {
    token: t.admin,
  });
  const actions = ((audit.json.rows as Json[]) ?? []).map((a) => a.action);
  check(
    'audit trail covers propose/approve/authorize/suspend/resume/review',
    [
      'CONNECTION_PROPOSED',
      'CONNECTION_ORG_APPROVED',
      'CONNECTION_AUTHORIZED',
      'CONNECTION_SUSPENDED',
      'CONNECTION_RESUMED',
      'RECORD_REVIEWED',
    ].every((a) => actions.includes(a)),
    actions.join(','),
  );
  const health = await call('GET', `${A}/health?refresh=1`, { token: t.admin });
  const h = health.json.data as Json;
  check(
    'health summary computed',
    health.status === 200 &&
      typeof (h?.queue as Json)?.pending === 'number' &&
      Array.isArray(h?.platforms),
  );

  // ---- isolation: core untouched -------------------------------------------------------------
  const after = await coreCounts(db);
  const changed = CORE_TABLES.filter((tname) => before[tname] !== after[tname]);
  check(
    'core table row counts unchanged by the whole flow',
    changed.length === 0,
    changed.length
      ? `changed: ${changed.join(',')}`
      : `${CORE_TABLES.length} tables identical`,
  );

  await db.end();
  const failed = results.filter((r) => !r.pass).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed === 0 ? 0 : 1);
}

function sessionEvent(
  connectionId: string,
  eventId: string,
  activityId: string,
  metrics: Record<string, number> = { trees_planted: 10 },
) {
  return {
    schema_version: '1.0',
    event_id: eventId,
    event_type: 'activity.session',
    connection_id: connectionId,
    occurred_at: new Date(Date.now() - 3 * 86_400_000).toISOString(),
    activity: {
      external_id: activityId,
      type: 'plantation',
      title: 'E2E plantation drive',
    },
    payload: { location: 'Lahore', session_hours: 4, participants_count: 8 },
    metrics: Object.entries(metrics).map(([code, value]) => ({ code, value })),
  };
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
