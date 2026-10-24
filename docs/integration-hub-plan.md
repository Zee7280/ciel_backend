# CIEL PK Universal Integration Hub — Implementation Plan (v2.2 consolidated)

Consolidates the Master Plan v2.0, the Strict Data Isolation revision, and the v2.2 Lightweight
addendum into one build plan for this codebase. Where the three documents conflict, the later
document wins. This file is the engineering reference; the governance documents remain authoritative
for policy.

## 1. Governing rules (non-negotiable)

1. Third-party data lives in a separate environment and is never merged into core tables.
2. Nothing in core (students, opportunities, participation, attendance, reports, CII, Impact Wall,
   rankings, analytics, evidence) is ever disclosed to an external platform. No outbound events.
3. No Login with CIEL PK, no student identifiers sent out, no external-to-core student or
   opportunity mappings. A plain referral URL is the only outbound touchpoint.
4. Imported records never write to the attendance approval queue or grant hours or credit.
5. One universal inbound protocol for every vendor. No vendor-specific business logic in code.
6. Performance isolation is separate from data isolation: core user-facing paths must not slow
   down because ingestion grows.

## 2. Shape of the build

Modular monolith inside the existing NestJS app: `src/integration-hub/` with submodules
`platforms`, `security`, `intake`, `processing`, `evidence`, `metrics`, `admin`. No new services,
no queue brokers, no permanent workers.

### 2.1 Storage isolation

- Postgres schema `external_hub`. Every hub entity declares `schema: 'external_hub'`.
- Second TypeORM data source (`HUB_DATABASE_URL`) using a database role that has privileges on
  `external_hub` only. The intake and processing code uses this data source exclusively, so a
  bug cannot reach core tables. Admin read screens may use the same restricted source.
- No foreign keys into core. `external_connections.organization_id` is a plain UUID used for
  authorization scope only.
- Hub tables are created and changed by version-controlled TypeORM migrations
  (`migrations/hub/*`), not by `synchronize`.
- Evidence goes to a dedicated private bucket (or isolated prefix with its own policy), never the
  existing `uploads` path or the current S3 prefixes.

### 2.2 Minimum data model (8 entities)

| Entity | Purpose | Key columns / indexes |
| --- | --- | --- |
| `external_platforms` | Registered vendor system | status (sandbox/live/suspended/retired), integration_mode, approved_event_types[], rate limits, evidence limits, retention days, monitoring thresholds |
| `external_connections` | Platform ↔ organization authorization | platform_id, organization_id, status, scopes[], DPA reference, personal_fields_allowed, retention override, approved referral domain; unique (platform_id, organization_id) |
| `external_credentials` | Machine credentials | platform_id, key_id, secret (encrypted at rest), status, rotated_at, expires_at |
| `external_events` | Immutable inbound history + job state | connection_id, source_event_id, event_type, envelope JSONB, status (received/processing/accepted/rejected/dead), attempts, next_attempt_at, locked_by/locked_at, error; unique (connection_id, source_event_id); index (status, next_attempt_at), (connection_id, received_at) |
| `external_records` | Normalized current activity record | connection_id, external_activity_id, activity_type, occurred_on, payload JSONB, attestation JSONB, review_state (unreviewed/reviewed/disputed/voided), version, superseded_by; unique (connection_id, external_activity_id); index (connection_id, activity_type, occurred_on) |
| `external_evidence` | File metadata only | record_id, storage_key, size, mime, sha256, state (quarantined/accepted/rejected/purged), visibility |
| `external_metric_catalog` | Configurable metric definitions | code, unit, aggregation, classification, allowed range, platform field mapping JSONB |
| `external_audit` | Admin and security actions | actor, action, target_type, target_id, details JSONB, created_at |

Metric values are stored in `external_records.payload.metrics` (validated against the catalog), not a
separate table, until volume justifies one. Cached summaries, when needed, are a small
`external_summaries` table keyed by connection + activity and updated only for affected records.

## 3. Universal inbound protocol

Base path `/api/integrations/v1`, machine auth only (no JWT), separate guard.

- Auth: `X-Hub-Key-Id`, `X-Hub-Timestamp`, `X-Hub-Nonce`, `X-Hub-Signature` (HMAC-SHA256 over
  method, path, timestamp, nonce, body hash). 5-minute clock window; nonce replay cache per key.
- Envelope v1: `schema_version`, `event_id`, `event_type`, `connection_id`, `occurred_at`,
  `activity` (external ids + type), `payload` (activity-specific, JSONB), `metrics[]`,
  `evidence[]` (references or upload tickets), `attestation` (lawful basis, consent ref, date),
  `correlation` (corrects / voids a previous `event_id`).
- Event types v1: `activity.session`, `impact.metric`, `evidence.item`, `activity.corrected`,
  `activity.voided`.
- Endpoints:
  - `POST /events` — single or small batch (max 50). Performs only: authenticate, check
    connection active + scope + event type approved, rate and payload limits, envelope validation,
    attestation check when personal fields present, uniqueness check, persist to
    `external_events`. Returns `202` with `{event_id, status: "received"}`.
  - `GET /events/:event_id` — receipt and processing state of the caller's own event only.
    Unknown or foreign ids return 404.
  - `POST /evidence/upload-ticket` — short-lived, narrowly scoped direct-upload authorization into
    the quarantine prefix. The main server never streams evidence bytes.
  - `GET /status` — connection status only (active/suspended) for the caller.
- Rate limits per platform and per connection, with `429` + `Retry-After`. Payload cap enforced
  before body parsing.

## 4. Processing

Superseded by `docs/integration-hub-technical-design.md` section 3: push events are normalized
inline within the intake request (budgeted), and a Vercel Cron sweeper handles only deferred or
failed events, pull adapters and retention. The batch rules below still apply to the sweeper.
Note: `@nestjs/schedule` cron decorators are not reliable on Vercel functions; use Vercel Cron for
every scheduled job.

Each sweeper run:

1. Claim up to N events atomically (`UPDATE ... WHERE status='received' AND next_attempt_at<=now()
   ... FOR UPDATE SKIP LOCKED LIMIT N`, N starts at 25).
2. Per-connection fairness: no more than M events per connection per run; skip suspended
   connections before executing anything.
3. Normalize into `external_records` (insert, or new version on correction; mark voided on void).
   Validate metrics against the catalog. Record provenance in the event row.
4. Evidence: confirm object exists and size, validate type, compute sha256, mark accepted or
   rejected, move out of quarantine.
5. Update only the affected cached summary.
6. On failure: increment attempts, exponential backoff, dead after max attempts. Stale locks
   (older than the function timeout) are released at the start of each run.
7. Stop before the function time budget is reached.

Idle connections produce no work. No per-vendor workers.

## 5. Retention

Per-platform defaults, per-connection overrides, enforced by a daily Vercel Cron:

- processing logs and rejected events: short
- quarantined uploads: hours
- accepted records and evidence: contractual period
- corrected and voided records: retained with the original for the audit period
- security audit: longest, never purged for performance

Purges write an `external_audit` entry.

## 6. Admin interfaces (frontend)

Two interfaces only, both paginated server-side with small default page sizes and lazy loading.

**A. Super Admin → Integration Console** (`/dashboard/admin/integrations/*`)
platforms (register, approve, sandbox→live, suspend, retire), credentials (issue, rotate, revoke),
connections (scopes, retention, referral domain, suspend), metric catalog, events (filter by
platform/connection/status, replay dead events), records (per connection, review state actions:
reviewed / disputed / voided / request clarification), evidence (metadata table, thumbnail,
restricted open), audit, health (periodic summary: received, success/failure, pending count and
oldest age, latency, storage, per-platform traffic, rate-limit hits).

**B. Organization → External Records** (`/dashboard/partner/integrations`, university equivalent)
approve or reject connection proposals, view connection status, browse that organization's
accepted records and metric summaries. Read-only otherwise.

No widgets on student, faculty, CII, ranking or report screens.

Frontend plumbing follows the existing pattern: Next.js API proxy routes under
`src/app/api/v1/admin/integrations/*`, `authenticatedFetch`, admin table components.

## 7. Dynamic vendor configuration

A conforming push vendor needs zero code: platform row, credentials, connection, approved event
types, metric mappings, field mapping, limits, retention, thresholds. Pull-only vendors get a small
isolated adapter under `integration-hub/adapters/<name>` that produces the same envelope and
submits it through the same intake service. Adapters never touch core modules.

## 8. Acceptance tests (shipped as e2e specs)

1. Hub DB role cannot read or write any `public` schema table (grant test).
2. Machine credentials get 401 on every JWT core route; JWT users get 401 on machine routes.
3. Vendor A requesting vendor B's event receipt gets 404.
4. Submitting and processing events leaves row counts of participations, attendance_logs,
   reports, student_reports and ranking tables unchanged.
5. Replaying the same `event_id` yields one normalized record.
6. Suspended connection: new submissions rejected, queued events skipped.
7. One connection flooding the queue does not starve a second connection in the same run.
8. Correction updates only the affected summary.
9. Retention purge removes expired rows and evidence, keeps audit.
10. A second simulated vendor completes the full flow with configuration only.
11. Load test: core dashboard endpoints within the agreed degradation budget while intake runs.

## 9. Phase A build order

1. Migrations + `external_hub` schema + restricted data source + entities.
2. Secrets encryption helper, credential issuance and HMAC guard.
3. Platforms and connections services + admin registry/connection pages + org approval page.
4. Intake endpoint with validation, limits, uniqueness, 202 ack, receipt lookup.
5. Processor endpoint + Vercel Cron, normalization, corrections, voids, dead-letter.
6. Evidence upload tickets, quarantine validation, evidence table and viewer.
7. Metric catalog, mapping, cached summaries, records review states.
8. Events/records/evidence/audit admin pages, health summary page.
9. Retention cron, suspension semantics, rate limiting.
10. Acceptance e2e suite and load test script; second simulated vendor fixture.

Phases B–E follow the addendum (reliability, multi-vendor scale, higher-volume optimization,
ecosystem growth) without changing the protocol or weakening isolation.

## 10. Open decisions

- Pilot vendor delivery model: push to our endpoint (preferred, zero code) or pull adapter.
- Isolation level for the pilot: `external_hub` schema with a restricted role on the existing
  Postgres instance (recommended to start) vs a separately provisioned database. The data source
  abstraction makes moving later a connection-string change.
- Confirm Vercel plan limits (cron minimum interval, function timeout) to set batch size and
  time budget.
- Super admin only for the console; organization admins limited to interface B.
