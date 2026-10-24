# CIEL PK Universal Integration Hub — Technical Design for Sign-off (v2.2)

Status: proposed for technical and governance sign-off before production implementation.
Companion: `docs/integration-hub-plan.md` (consolidated build plan). Where the two differ on
processing, this document wins: processing is event-driven, not cron-driven.

Finalized decisions applied: vendor-neutral protocol; push-first with pull/file compatibility;
dedicated Postgres schema + restricted role, portable to a separate database; no reliance on
in-process cron decorators; console inside the Super Admin dashboard; organization admins approve
their own connections and see only their own records; no merging with core data; no outbound core
data.

---

## 1. Revised architecture

```
                 EXTERNAL PLATFORM (vendor)                    CIEL PK USERS (browser)
                 ───────────────────────────                   ──────────────────────
                 HMAC-signed HTTPS requests                    JWT sessions (unchanged)
                           │                                              │
                           ▼                                              ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│  NestJS modular monolith on Vercel Functions (one deployment, one codebase)             │
│                                                                                        │
│  ┌──────────────────────────────┐          ┌──────────────────────────────────────┐    │
│  │ integration-hub module       │          │ existing core modules                │    │
│  │  /api/integrations/v1/*      │          │  auth, users, opportunities,         │    │
│  │  machine auth guard (HMAC)   │  no      │  engagement, reports, ranking, …     │    │
│  │  intake → validate → persist │  calls   │  /api/v1/*  (JWT)                    │    │
│  │  inline normalize (budgeted) │ ◄──X──►  │                                      │    │
│  │  evidence tickets + complete │          │  admin controller mounts the hub     │    │
│  │  admin + org read endpoints  │          │  console routes (JWT, roles) which   │    │
│  │  (JWT, role-scoped)          │          │  call hub services only              │    │
│  └──────────────┬───────────────┘          └──────────────────┬───────────────────┘    │
│                 │ hub DataSource (role ciel_hub_app)          │ core DataSource (ciel_app)
└─────────────────┼────────────────────────────────────────────┼─────────────────────────┘
                  ▼                                            ▼
     ┌───────────────────────────┐                ┌───────────────────────────┐
     │ Postgres schema           │  no FKs,       │ Postgres schema public    │
     │ external_hub              │  no joins,     │ (students, opportunities, │
     │ platforms, connections,   │  no grants     │  attendance, reports,     │
     │ credentials, events,      │  across the    │  CII, rankings, …)        │
     │ records, evidence meta,   │  boundary      │                           │
     │ metric catalog, audit     │                │                           │
     └─────────────┬─────────────┘                └───────────────────────────┘
                   │
                   ▼
     ┌───────────────────────────┐        ┌────────────────────────────────────────┐
     │ Private evidence bucket   │        │ Vercel Cron (maintenance only)          │
     │ quarantine/ → accepted/   │        │  retry sweeper (deferred failures)      │
     │ direct vendor upload via  │        │  pull-adapter sync (only if configured) │
     │ short-lived signed URLs   │        │  retention + quarantine purge           │
     └───────────────────────────┘        │  existing nightly core jobs (fixed)     │
                                          └────────────────────────────────────────┘
```

Data flow is one-way: vendor → hub schema → admin screens. Nothing flows from `public` to the
vendor, and nothing flows from `external_hub` into `public`. The single core touchpoint is an
optional referral URL on an opportunity, set by the organization, validated against the approved
domain on its connection.

### Submodules (`src/integration-hub/`)

| Submodule | Responsibility |
| --- | --- |
| `platforms` | platform registry, connections, scopes, status, referral domain |
| `security` | credential issuance, secret encryption, HMAC guard, nonce cache, rate limits |
| `intake` | `POST /events` validation, uniqueness, persistence, inline processing budget |
| `processing` | normalize event → record, corrections, voids, summaries, retry sweeper |
| `evidence` | upload tickets, completion validation, hash, quarantine → accepted |
| `metrics` | metric catalog, field mappings, per-connection cached summaries |
| `admin` | Super Admin console endpoints, organization external-records endpoints, health |
| `adapters` | (later) isolated pull adapters producing the same envelope |

---

## 2. Database isolation and role permission matrix

Pilot: schema `external_hub` on the existing Postgres instance, owned by a dedicated migrator role,
accessed at runtime by a restricted role through a second TypeORM DataSource. Moving to a separate
database later is a change of `HUB_DATABASE_URL` only, because nothing joins across the boundary.

### Roles

| Role | Used by | `public` schema | `external_hub` schema | Notes |
| --- | --- | --- | --- | --- |
| `ciel_app` (existing) | core DataSource | owner / full | **none** (`REVOKE ALL`) | unchanged for core; explicitly denied on hub |
| `ciel_hub_app` | hub DataSource at runtime | **none** (`REVOKE ALL ON SCHEMA public`, no default privileges) | `USAGE` on schema; `SELECT, INSERT, UPDATE` on all tables; `DELETE` only on `external_events`, `external_evidence`, `external_records` (retention) | cannot see core tables at all; `search_path = external_hub` |
| `ciel_hub_migrator` | migrations (CI / deploy step) | none | owner of schema and tables; `CREATE` | runs `migrations/hub/*` only |
| `ciel_hub_readonly` (optional, Phase B) | reporting / BI | none | `SELECT` | not needed for pilot |

Hard rules enforced by grants, not code:

- `ciel_hub_app` has no privilege on `public`, so an intake bug cannot read or write students,
  opportunities, attendance, reports, CII or rankings.
- `ciel_app` has no privilege on `external_hub`, so core code cannot accidentally join or import
  external records.
- No foreign keys, views, triggers or functions cross the schema boundary.
- `organization_id` on `external_connections` is a plain UUID. It is validated at write time by the
  admin/org endpoint (which runs under the user's JWT and reads the organization through the core
  DataSource), then stored without a constraint.

### Bootstrap SQL (run once by a DBA, then migrations)

```sql
CREATE ROLE ciel_hub_migrator LOGIN PASSWORD '<set>';
CREATE ROLE ciel_hub_app       LOGIN PASSWORD '<set>';
CREATE SCHEMA external_hub AUTHORIZATION ciel_hub_migrator;

REVOKE ALL ON SCHEMA public FROM ciel_hub_app, ciel_hub_migrator;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ciel_hub_app, ciel_hub_migrator;
REVOKE ALL ON SCHEMA external_hub FROM ciel_app;

GRANT USAGE ON SCHEMA external_hub TO ciel_hub_app;
ALTER DEFAULT PRIVILEGES FOR ROLE ciel_hub_migrator IN SCHEMA external_hub
  GRANT SELECT, INSERT, UPDATE ON TABLES TO ciel_hub_app;
ALTER DEFAULT PRIVILEGES FOR ROLE ciel_hub_migrator IN SCHEMA external_hub
  GRANT USAGE, SELECT ON SEQUENCES TO ciel_hub_app;
-- DELETE for retention is granted per table inside the migration that creates it.
ALTER ROLE ciel_hub_app SET search_path = external_hub;
```

### Hub DataSource settings

- `synchronize: false`, `migrationsRun: false` (migrations run in a deploy step).
- Pool `max: 2` per function instance (hub traffic is bursty and short), `idleTimeoutMillis` low.
- If the provider offers a pooler (PgBouncer / Neon pooler / Supabase pooler), the hub URL uses it.

---

## 3. Scheduling: event-driven first, cron only for maintenance

### 3.1 Push integrations: no cron

A vendor request is the event. Every `POST /events` does, in order, inside the request:

1. HMAC authentication and nonce replay check.
2. Connection active, scope includes event type, platform not suspended.
3. Payload size (enforced before body parse) and rate limits (per platform, per connection).
4. Envelope validation (schema v1), attestation check when personal fields are present.
5. Uniqueness check on `(connection_id, source_event_id)`; a duplicate returns the original receipt.
6. Insert into `external_events` with `status = received`.
7. **Inline normalize** within a time budget (default 1500 ms for the whole batch): upsert
   `external_records`, apply correction/void, validate metrics, update the affected summary row.
   On success `status = processed`; on budget exhaustion or transient error `status = deferred`
   with `next_attempt_at`.
8. Respond `202 Accepted` with `{ event_id, status }`. The status is technical only.

Normalization is JSON validation plus one or two indexed upserts, so in the normal case the event
is fully processed before the response and nothing is left for a scheduler. Evidence is handled
by its own vendor-driven requests (section 4), also without cron.

### 3.2 Where scheduled jobs are allowed

| Job | Trigger | Schedule (UTC) | Guard | Cost when idle |
| --- | --- | --- | --- | --- |
| Retry sweeper (deferred / failed events) | Vercel Cron | `*/15 * * * *` Pro (or once daily on Hobby) | `CRON_SECRET` bearer | one indexed `EXISTS` query, returns immediately when nothing is deferred |
| Pull-adapter sync | Vercel Cron | per adapter config; **not registered until a pull connection exists** | `CRON_SECRET` | none when no pull connections |
| Retention + quarantine purge | Vercel Cron | `30 21 * * *` (02:30 PKT) | `CRON_SECRET` | bounded delete batches |
| Existing nightly core jobs (attendance SLA, enrollment reconcile) | Vercel Cron | `0 21 * * *` (02:00 PKT) | `CRON_SECRET` | unchanged work, now actually scheduled |

Admin console also exposes "Run sweeper now" and "Replay event" buttons for on-demand processing.
There is no continuous polling anywhere.

### 3.3 `vercel.json` additions

```json
{
  "crons": [
    { "path": "/api/v1/internal/jobs/nightly",            "schedule": "0 21 * * *" },
    { "path": "/api/v1/internal/jobs/hub-retention",      "schedule": "30 21 * * *" },
    { "path": "/api/v1/internal/jobs/hub-retry-sweeper",  "schedule": "*/15 * * * *" }
  ]
}
```

Vercel sends `Authorization: Bearer $CRON_SECRET` to cron paths when `CRON_SECRET` is set in the
project environment. The internal controller rejects any request without it. The pull-adapter cron
entry is added only when the first pull connection is configured.

### 3.4 Audit of the existing daily job

Finding: `PlatformJobsService.runNightlyJobs` uses `@Cron(EVERY_DAY_AT_2AM)` from
`@nestjs/schedule`. On Vercel Functions a timer only fires if a warm instance exists at that moment
and is not frozen, which is not guaranteed and not observable. `vercel.json` has no `crons` entry.
The job therefore cannot be assumed to run in production. Manual triggers exist
(`POST /admin/jobs/attendance-sla`, `POST /admin/jobs/enrollment-reconcile`, Super Admin only).

Verification steps (to run in the Vercel dashboard, not possible from the repository):

1. Search function logs for `Starting nightly platform jobs` over the last 30 days.
2. Compare timestamps of attendance-SLA side effects (notifications / status changes) with 02:00 PKT.

Correction (included in Phase A, step 2): move the two nightly services behind
`POST /api/v1/internal/jobs/nightly` guarded by `CRON_SECRET`, register the cron entry above, and
set `DISABLE_PLATFORM_CRON=true` on Vercel so the decorator does not double-run if an instance is
warm. The manual admin triggers stay.

### 3.5 Hosting facts (verified 24 Oct 2026 via the Vercel CLI and API, project `ciel_backend`)

| Item | Verified value | Consequence |
| --- | --- | --- |
| Plan | **Pro** (team `zain's projects`) | cron schedules down to 1 minute; 300 s max duration allowed |
| Fluid Compute | **enabled** | instances are reused and may stay warm; in-process timers are still not a schedule |
| Function region | **iad1** (US East) | database should be in or near us-east; confirm provider region |
| Function max duration | **300 s** (vercel.json) | inline processing budget 1.5 s is far inside the limit |
| Memory setting | 8192 (project resource config) | not a constraint for the hub |
| Node version | 24.x | fine for `crypto.timingSafeEqual`, AES-GCM |
| Cron feature | **enabled** on the project; no cron entries existed before this work | the nightly job had never been scheduled by Vercel |
| `CRON_SECRET` | **not set** in any environment | must be added before the cron entry takes effect |
| Env vars present | DB_HOST/PORT/USERNAME/PASSWORD/NAME, JWT_*, AWS_* (one bucket), MAIL_*, FRONTEND_URL | hub needs HUB_DATABASE_URL, HUB_MIGRATION_DATABASE_URL (CI only), HUB_SECRETS_KEY, HUB_EVIDENCE_BUCKET |

Still to confirm by the project owner (not readable from the CLI without materializing secrets):

| Item | Why it matters |
| --- | --- |
| Postgres provider, region and connection cap | pool `max`, whether to use a pooler, permission to create roles and a schema |
| Whether a second private S3 bucket may be created | evidence isolation (preferred) vs isolated prefix |

---

## 4. Pilot ingestion design (vendor-neutral; DeliveTree is configuration)

### 4.1 Onboarding (configuration only)

1. Super Admin registers the platform (sandbox status), approved event types
   (`activity.session`, `impact.metric`, `evidence.item`, `activity.corrected`, `activity.voided`),
   rate limits, evidence limits, retention days.
2. Super Admin issues credentials: `key_id` + secret shown once, stored encrypted (AES-256-GCM with
   `HUB_SECRETS_KEY`). Rotation creates a second active key; revocation ends the old one.
3. Organization admin (BNU) approves the connection proposal: purpose, scopes, DPA reference,
   `personal_fields_allowed`, referral domain. Super Admin authorizes. Status `active`.
4. Vendor runs the conformance checklist against sandbox: auth, duplicate replay, correction, void,
   evidence round trip, rate-limit response. Super Admin flips platform to `live`.

### 4.2 Envelope v1 (same for every vendor)

```json
{
  "schema_version": "1.0",
  "event_id": "vendor-unique-id",
  "event_type": "activity.session",
  "connection_id": "uuid-issued-by-ciel",
  "occurred_at": "2026-11-03T09:00:00+05:00",
  "activity": { "external_id": "plant-2026-11-03-lhr-07", "type": "plantation", "title": "…" },
  "payload": { "location": "…", "session_hours": 4, "participants_count": 8, "notes": "…" },
  "metrics": [ { "code": "trees_planted", "value": 40, "unit": "count", "classification": "observed" } ],
  "evidence": [ { "upload_id": "uuid-from-upload-ticket" } ],
  "attestation": { "lawful_basis": "consent", "consent_ref": "DT-C-5521", "obtained_at": "2026-11-01" },
  "correlation": { "corrects": null, "voids": null }
}
```

Rules: `payload` is JSONB validated against the connection's field mapping; unknown fields are
stored but never displayed or summarized until mapped; `metrics[].code` must exist in the catalog
and be in range; personal fields (names, emails, phone, national ID) are rejected unless the
connection allows them **and** `attestation` is valid; participants are a count, never identities,
unless explicitly allowed.

### 4.3 Request lifecycle (push)

```
vendor ──POST /api/integrations/v1/events──► HMAC guard ─► connection/scope/rate ─► validate
      ◄──202 {event_id,status}────────────── inline normalize (≤ budget) ◄── persist event
```

Corrections (`activity.corrected` with `correlation.corrects`) create a new record version and
mark the previous `superseded_by`; voids mark the current version `voided`. Both update only the
affected summary row (`external_summaries` keyed by connection + activity external_id + period).

### 4.4 Evidence (vendor-driven, no cron)

```
vendor ──POST /evidence/upload-ticket {size,mime,sha256?}──► 201 {upload_id, url, expires_in}
vendor ──PUT <signed url> (direct to bucket quarantine/)
vendor ──POST /evidence/:upload_id/complete──► HEAD object, size ≤ limit, mime allowlist,
                                               sha256 (streamed, capped), move to accepted/,
                                               state=accepted ──► 200 {evidence_id}
```

Evidence bytes never pass through the application function. Objects left in `quarantine/` past
the ticket lifetime are deleted by the retention cron and bucket lifecycle rule. Evidence objects
are private; the admin console opens them through short-lived signed GET URLs, with thumbnails or
metadata in tables.

### 4.5 Receipt lookup

`GET /events/:event_id` returns `{ event_id, status, received_at, processed_at, error_code? }` for
the caller's own event only. Any other id returns 404. No other machine-readable endpoint exists.

### 4.6 Pull and file imports (compatibility, not built for the pilot)

A pull adapter or an admin CSV import produces the same envelope and calls the same intake service
in-process. They share validation, uniqueness, corrections, evidence and audit. Pull adapters get a
cron entry only when configured.

---

## 5. Admin and organization interfaces

Both live in the existing Next.js app behind the current JWT and role guards and use the existing
proxy-route pattern. Server-side pagination (default 25 rows), filters on indexed columns only,
no auto-refresh; the health page is a cached summary recomputed at most every 5 minutes on demand.

| Screen | Super Admin | Organization admin |
| --- | --- | --- |
| Platforms (register, approve, sandbox/live, suspend, retire) | yes | no |
| Credentials (issue, rotate, revoke) | yes | no |
| Connections (scopes, retention, referral domain, suspend) | all | own: approve / reject / request suspension, view status |
| Events (filter, replay, dead-letter) | all | no |
| Records (review state: reviewed / disputed / voided / clarification) | all | own connections, read-only |
| Evidence (metadata, thumbnail, signed open) | all | own connections, metadata + open if visibility allows |
| Metric catalog and mappings | yes | no |
| Audit log | yes | own connection entries |
| Health summary | yes | no |

No hub component is rendered on student, faculty, CII, ranking or report pages.

---

## 6. Estimated development effort

Assumptions: one backend developer and one frontend developer working in parallel, existing
patterns reused, DeliveTree's API confirmed as push-capable. Figures are engineering estimates for
planning, not commitments.

| Workstream | Backend (days) | Frontend (days) |
| --- | --- | --- |
| Migrations, schema, roles, hub DataSource, entities | 3 | – |
| Nightly job fix + internal jobs controller + `CRON_SECRET` + crons | 1 | – |
| Secrets encryption, credentials, HMAC guard, nonce cache, rate limits | 3 | – |
| Platforms and connections services + endpoints (admin + org) | 3 | 4 |
| Intake endpoint, envelope validation, uniqueness, inline normalize, receipts | 4 | – |
| Corrections, voids, summaries, retry sweeper, dead-letter | 3 | – |
| Evidence tickets, completion validation, bucket policy, signed reads | 3 | 2 |
| Metric catalog and field mapping | 2 | 2 |
| Events / records / evidence / audit admin screens | – | 5 |
| Organization external-records screens | – | 2 |
| Health summary endpoint + screen | 1 | 1 |
| Retention job | 1 | – |
| Isolation and performance test suite, second simulated vendor, load script | 4 | 1 |
| Sandbox conformance checklist, docs for vendors | 1 | – |
| **Total** | **29** | **17** |

Calendar: roughly 6 to 7 weeks for Phase A with the two streams in parallel, plus one week of
pilot conformance testing with the vendor. Phase B (monitoring, scanning, DB tuning) is estimated
separately after baseline measurements.

---

## 7. Isolation and performance test plan

### 7.1 Isolation tests (automated, run in CI against a test database with the real grants)

| # | Test | Expected |
| --- | --- | --- |
| I1 | As `ciel_hub_app`, `SELECT` from `public.users`, `public.opportunities`, `public.attendance_logs`, `public.reports` | permission denied |
| I2 | As `ciel_hub_app`, `INSERT`/`UPDATE`/`DELETE` on any `public` table | permission denied |
| I3 | As `ciel_app`, `SELECT` from `external_hub.external_records` | permission denied |
| I4 | Machine credentials call every JWT route group (`/api/v1/users/me`, `/admin/*`, `/opportunities/*`, …) | 401 |
| I5 | A valid JWT calls `/api/integrations/v1/*` | 401 |
| I6 | Vendor A requests vendor B's event receipt | 404 |
| I7 | Vendor A submits with vendor B's `connection_id` | 403, audited |
| I8 | Suspended platform or connection submits | 403; sweeper skips its deferred events |
| I9 | Full event + evidence flow, then row counts of `participations`, `attendance_logs`, `reports`, `student_reports`, ranking tables compared before/after | identical |
| I10 | Schema scan: no FK, view, trigger or function references `public` from `external_hub` or vice versa | none found |
| I11 | Personal fields submitted on a connection with `personal_fields_allowed = false` | 422, nothing stored |
| I12 | Evidence signed URL expiry and cross-vendor access | expired → 403; other vendor → 404 |
| I13 | Second simulated vendor completes onboarding + full flow via configuration only | pass, zero code changes |

### 7.2 Idempotency and correctness

| # | Test | Expected |
| --- | --- | --- |
| C1 | Replay the same `event_id` 10× | one event row, one record, same receipt |
| C2 | Correction 40 → 32 trees | new record version, old superseded, only that summary row changes |
| C3 | Void after correction | current version voided, summary excludes it |
| C4 | Simulated transient DB error during inline normalize | event `deferred`, sweeper processes it, final state identical to C1 |
| C5 | Sweeper with two connections, one holding 500 deferred events | the other connection's events are processed in the same run (per-connection cap) |
| C6 | Interrupted sweeper (killed mid-batch) | stale locks released next run, no duplicate records |

### 7.3 Performance tests (k6 or autocannon, staging with production-like limits)

| # | Scenario | Target (provisional, to be agreed after baseline) |
| --- | --- | --- |
| P1 | Baseline: core endpoints (`/users/me`, student dashboard, opportunity listing, admin reports list) p95 latency with no hub traffic | recorded |
| P2 | Same core endpoints while 20 req/s of valid small events hit intake for 10 minutes | p95 degradation < 10 % vs P1 |
| P3 | Intake p95 for valid small events (< 8 KB) | 95 % acknowledged < 1 s |
| P4 | 200 events in one burst from one platform above its rate limit | 429 with `Retry-After`; other platform unaffected |
| P5 | 10 MB evidence uploads × 20 concurrent | function memory flat (bytes go direct to bucket); completion endpoint < 2 s |
| P6 | Deferred backlog of 2,000 events | sweeper drains within bounded runs; pending count monotonic decreasing; oldest-event age reported |
| P7 | Admin events page with 100k events | paginated query uses `(connection_id, received_at)` index; p95 < 500 ms |
| P8 | Database connections during P2 | hub pool ≤ 2 per instance; total connections under provider cap |

### 7.4 Exit criteria for pilot approval

All I-tests and C-tests pass in CI; P2, P3, P5, P8 meet targets on staging; the nightly job is
observed running from Vercel Cron for 3 consecutive nights; DeliveTree passes the sandbox
conformance checklist; a signed DPA reference is recorded on the BNU connection.

---

## 8. Implementation status and local verification

Phase A is implemented on branch `partner-flows-and-signup-docs` (backend) and `main` (frontend),
uncommitted at time of writing.

| Piece | Files | Verified by |
| --- | --- | --- |
| Nightly job fix (§3.4) | `src/jobs/cron-secret.guard.ts`, `src/jobs/internal-jobs.controller.ts`, `src/jobs/platform-jobs.service.ts`, `vercel.json` (`crons`), `POST /admin/jobs/nightly` | unit tests; local boot: GET without secret → 401, wrong secret → 401, correct secret → 200 with run summary; audit row `PLATFORM_NIGHTLY_JOBS_RUN` written |
| Hub schema + roles (§2) | `scripts/hub-bootstrap-roles.sql`, `migrations/hub/1761300000000-InitExternalHub.ts` | migration applied as `ciel_hub_migrator` on local Postgres 16 |
| Restricted DataSource + entities | `src/integration-hub/hub-data-source.ts`, `entities/*`, `integration-hub.module.ts`, conditional import in `app.module.ts` | `npm run hub:schema-check`: 9/9 entities match; app boots with `HUB_DATABASE_URL` set and without it |
| DB-enforced isolation test (§7.1 I1–I3) | `scripts/hub-isolation-check.ts` | 19/19 checks pass against the local dev DB with real grants: hub role refused on every core table (42501), allowed inside `external_hub`, no DELETE on audit, no DDL |
| Security (§3, §4) | `security/hub-secrets.service.ts` (AES-256-GCM at rest), `security/hub-hmac.util.ts`, `security/hub-nonce-cache.ts`, `security/hub-rate-limiter.ts`, `security/credentials.service.ts`, `security/platform-auth.guard.ts`; raw-body capture + prefix exclusion in `main.ts` | unit tests (signing round trip, timestamp window, nonce replay, rate limit, cipher tamper detection); e2e: missing/JWT/wrong-secret/stale/replayed → 401, suspended platform → 403, revoked key → 401 |
| Platforms, connections, metrics | `platforms/*.service.ts`, `platforms/dto/platform.dto.ts`, `metrics/metric-catalog.service.ts`, `audit/hub-audit.service.ts` | e2e lifecycle: register → credential → propose → org approve → authorize → suspend → resume → revoke; audit trail asserted |
| Intake + processing (§4.3) | `intake/envelope.util.ts`, `intake/intake.service.ts`, `processing/processing.service.ts`, `processing/summaries.util.ts` | unit tests (envelope, personal-field detection, metric validation, summary deltas); e2e: inline processing → 200, duplicate → same receipt, correction 40→32 reflected only in affected summaries, void → zero, batch of 5, unknown metric / personal data / foreign connection rejected with codes |
| Evidence (§4.4) | `evidence/hub-storage.service.ts`, `evidence/evidence.service.ts` | e2e against real S3: ticket → direct PUT → complete (size, type, sha256) → linked by event → admin signed view; org denied until `orgEvidenceOpenAllowed`; disallowed mime → 400; unknown upload id → rejected |
| Vendor API | `vendor/hub-vendor.controller.ts` at `/api/integrations/v1` | e2e receipts (own → 200, unknown → 404), status, 200 vs 202 semantics |
| Admin console API + org API | `admin/hub-admin.controller.ts`, `admin/hub-org.controller.ts`, `admin/hub-records.service.ts`, `admin/hub-health.service.ts` | e2e: org token on admin routes → 403, admin token on org routes → 403, org cannot widen scope via query, health snapshot |
| Maintenance (§3.2) | `maintenance/hub-internal-jobs.controller.ts`, `maintenance/retention.service.ts`, `vercel.json` crons (`hub-retry-sweeper` */15, `hub-retention` 02:30 PKT) | e2e: sweeper and retention endpoints 200 with secret, 401 without |
| Core isolation (§7.1 I9) | — | e2e: row counts of users, organizations, opportunities, participations, attendance_logs, reports, student_reports, npe_ranking_snapshots identical before and after the whole flow |
| Frontend | `ciel_frontend/src/app/dashboard/admin/integrations/**`, `ciel_frontend/src/app/dashboard/partner/integrations/**`, `ciel_frontend/src/utils/integrationHub.ts`, sidebar + header entries | `tsc`, `eslint`, `next build` |

End-to-end run (`npm run hub:e2e` with `HUB_E2E_EVIDENCE=1`): **67/67 checks pass** against the
local backend. Backend unit suite: 139 suites, 1534 tests pass. Lint: clean.

Independent review pass (backend + frontend, 36 findings, all applied) added: per-event row locks
and status re-checks so intake, sweeper and replay can never apply an event twice; replay limited
to failed events; fair sweeper claim (per-connection cap inside the claim query); platform status
and validity window re-checked at processing time; evidence must be accepted and unlinked before
an event may reference it; version numbers span voided records; summary record counts move with
type/month corrections; per-connection lock shared by summaries and rebuild; vendor bodies must be
JSON (415 otherwise), parsed by a dedicated strict parser with a 2 MB ceiling, with per-platform
quota charged only after signature verification and a per-IP limiter in front; UUID/date filters
return 400 instead of 500; organization responses are projected (no platform internals, no storage
keys); metric PATCH validated; hub DataSource fails fast on a bad URL; bootstrap SQL is
transactional, refuses to run without its variables, and no longer touches the PUBLIC grant on
schema `public` (verified on a throwaway database: core role unaffected, hub role denied).

### Environment variables (backend)

| Variable | Required | Purpose |
| --- | --- | --- |
| `HUB_DATABASE_URL` | to enable the hub | runtime URL for role `ciel_hub_app`; absent ⇒ hub module not loaded |
| `HUB_MIGRATION_DATABASE_URL` | CI / deploy step only | URL for role `ciel_hub_migrator`; used by `npm run hub:migrate` |
| `HUB_SECRETS_KEY` | yes (hub) | 64-hex or passphrase; AES-256-GCM key for vendor signing secrets. Without it credential issuance and vendor auth are refused |
| `HUB_EVIDENCE_BUCKET` | **required in production** | dedicated private bucket. Production (`NODE_ENV=production` or Vercel) refuses evidence until it is set; only a developer machine falls back to `AWS_S3_BUCKET` under the isolated prefix `external-hub/` |
| `CRON_SECRET` | yes | shared by all `/api/v1/internal/jobs/*` endpoints; Vercel sends it automatically on cron calls |
| `HUB_DB_POOL_MAX` | optional (default 2) | hub pool size per function instance |
| `HUB_INLINE_BUDGET_MS` | optional (default 1500) | inline processing budget per intake request |

### Vendor signing contract (universal)

Headers `X-Hub-Key-Id`, `X-Hub-Timestamp` (unix seconds, ±300 s), `X-Hub-Nonce` (16–64 chars,
single use), `X-Hub-Signature` = `v1=` + hex HMAC-SHA256 over
`"v1\n" + METHOD + "\n" + path + "\n" + timestamp + "\n" + nonce + "\n" + sha256hex(body)`.
Reference implementation: `signHubRequest()` in `src/integration-hub/security/hub-hmac.util.ts`,
exercised by `scripts/hub-e2e-flow.ts`.

### Local setup

```bash
# 1. roles + schema (as the DB owner; core_role = your DB_USERNAME; passwords are required)
psql -h 127.0.0.1 -U postgres -d <dbname> -v core_role=postgres \
  -v hub_app_pw='<pw>' -v hub_migrator_pw='<pw>' -f scripts/hub-bootstrap-roles.sql
# 2. migrate as the migrator role
HUB_MIGRATION_DATABASE_URL=postgres://ciel_hub_migrator:<pw>@127.0.0.1:5432/<dbname> npm run hub:migrate
# 3. prove isolation and schema match with the runtime role
HUB_DATABASE_URL=postgres://ciel_hub_app:<pw>@127.0.0.1:5432/<dbname> npm run hub:isolation-check
HUB_DATABASE_URL=postgres://ciel_hub_app:<pw>@127.0.0.1:5432/<dbname> npm run hub:schema-check
# 4. run the app with the hub enabled
HUB_DATABASE_URL=... HUB_SECRETS_KEY=<32+ chars> CRON_SECRET=<32+ chars> npm run start:dev
# 5. full end-to-end flow (admin + org + simulated vendor + isolation assertions)
BASE_URL=http://127.0.0.1:3000 CRON_SECRET=<same> HUB_E2E_EVIDENCE=1 npm run hub:e2e
```

Note: `nest build` emits `dist/src/main.js` (root-level helper scripts widen the compile root), so
`npm run start:prod` as written (`node dist/main`) does not start the server. Vercel is unaffected
because it compiles `src/main.ts` directly. Worth fixing separately.

### Production rollout for the nightly-job fix

1. Add `CRON_SECRET` (32+ random characters) to the Production environment.
2. Deploy; Vercel registers the cron from `vercel.json` on the production deployment.
3. Confirm: function logs show `Finished nightly platform jobs (trigger=vercel-cron, success=true …)`
   at 02:00 PKT, and the admin audit page lists `PLATFORM_NIGHTLY_JOBS_RUN` daily.

## 9. Items requiring confirmation before implementation settings are fixed

1. Vercel plan, function limits, cron interval (section 3.5).
2. Production Postgres provider, connection cap, pooler availability, and permission to create
   roles and a schema.
3. Permission to create a second private S3 bucket (or an isolated prefix with its own policy).
4. DeliveTree's API capabilities: push webhook support, signing, evidence delivery method.
5. Whether organization admins may open evidence files or only see metadata.
