# CIEL PK University Export API (v1)

For a university's own systems (ERP / student information system, LMS, data warehouse) to pull
the university's CIEL PK records: students, opportunities, verified community-service hours,
approved FYPs, approved ventures and a period summary. Read-only. One protocol for every
university, shared with the Integration Hub vendor API (same signing, same credentials).

Base URL: `https://cielbackend-ecru.vercel.app/api/integrations/v1/export`

What the university receives from CIEL PK:

| Item | Example | Where it comes from |
| --- | --- | --- |
| Key id | `hk_3f9c…` | issued per platform by CIEL PK admin (Admin → Integrations → Platforms) |
| Secret | shown once at issuance | keep it server-side, never in a browser or app |
| Connection id | UUID | the connection between the platform and the university organization |
| Scopes | `export:students`, … | granted on the platform and on the connection |

Approval flow, in order:

1. CIEL PK admin registers a platform for the university's system (for example "BNU ERP"), ticks
   the export scopes under **Approved capabilities**, and issues a credential.
2. CIEL PK admin proposes a connection to the university organization with the export scopes.
3. The university approves the connection from its dashboard (**Integrations**).
4. CIEL PK admin authorizes it. From then on the endpoints below answer.

Personal fields (student email and phone) are included only when the connection's **personal
fields** switch is on; otherwise the keys are absent (not blank). The registration number is
always included because it is the matching key on the university side.

---

## 1. Signing every request

Identical to the vendor API. Every call carries four headers:

| Header | Value |
| --- | --- |
| `X-Hub-Key-Id` | your key id |
| `X-Hub-Timestamp` | current unix time in seconds; must be within ±300 s of server time |
| `X-Hub-Nonce` | random string, 16–64 chars of `A-Z a-z 0-9 _ - : .`, unique per request |
| `X-Hub-Signature` | `v1=` + hex HMAC-SHA256 of the canonical string, keyed with your secret |

Canonical string (five newlines, no trailing newline):

```
v1\n
GET\n
<path without query string, e.g. /api/integrations/v1/export/students>\n
<timestamp>\n
<nonce>\n
<sha256 hex of the empty string: e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855>
```

All export calls are `GET` with no body, so the body hash is always the hash of the empty string.
The query string is **not** part of the signature.

### Python

```python
import hashlib, hmac, os, time, requests

BASE = "https://cielbackend-ecru.vercel.app"
KEY_ID = os.environ["CIEL_KEY_ID"]
SECRET = os.environ["CIEL_SECRET"]
EMPTY_SHA = hashlib.sha256(b"").hexdigest()

def sign(path: str) -> dict:
    ts = str(int(time.time()))
    nonce = os.urandom(16).hex()
    canonical = "\n".join(["v1", "GET", path, ts, nonce, EMPTY_SHA])
    sig = hmac.new(SECRET.encode(), canonical.encode(), hashlib.sha256).hexdigest()
    return {"X-Hub-Key-Id": KEY_ID, "X-Hub-Timestamp": ts, "X-Hub-Nonce": nonce, "X-Hub-Signature": f"v1={sig}"}

def fetch_all(resource: str, connection_id: str, cursor: str | None = None, **params):
    path = f"/api/integrations/v1/export/{resource}"
    while True:
        q = {"connection_id": connection_id, "limit": 500, **params}
        if cursor:
            q["cursor"] = cursor
        r = requests.get(BASE + path, params=q, headers=sign(path), timeout=60)
        r.raise_for_status()
        body = r.json()
        yield from body["rows"]
        cursor = body["page"]["next_cursor"]       # store this after each page
        if not body["page"]["has_more"]:
            return

for row in fetch_all("students", "<connection uuid>"):
    print(row["registration_number"], row["student_name"])
```

### Node.js

```js
const crypto = require("crypto");
const BASE = "https://cielbackend-ecru.vercel.app";
const EMPTY_SHA = crypto.createHash("sha256").update("").digest("hex");

function sign(path) {
  const ts = String(Math.floor(Date.now() / 1000));
  const nonce = crypto.randomBytes(16).toString("hex");
  const canonical = ["v1", "GET", path, ts, nonce, EMPTY_SHA].join("\n");
  const sig = crypto.createHmac("sha256", process.env.CIEL_SECRET).update(canonical).digest("hex");
  return { "X-Hub-Key-Id": process.env.CIEL_KEY_ID, "X-Hub-Timestamp": ts, "X-Hub-Nonce": nonce, "X-Hub-Signature": `v1=${sig}` };
}

async function* fetchAll(resource, connectionId, extra = {}) {
  const path = `/api/integrations/v1/export/${resource}`;
  let cursor = null;
  for (;;) {
    const q = new URLSearchParams({ connection_id: connectionId, limit: "500", ...extra });
    if (cursor) q.set("cursor", cursor);
    const res = await fetch(`${BASE}${path}?${q}`, { headers: sign(path) });
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    const body = await res.json();
    yield* body.rows;
    cursor = body.page.next_cursor;
    if (!body.page.has_more) return;
  }
}
```

---

## 2. Paging and incremental sync

Every list endpoint takes:

| Query | Meaning |
| --- | --- |
| `connection_id` | required: your connection to the university |
| `limit` | rows per page, 1–500 (default 200) |
| `cursor` | the `page.next_cursor` of the previous page; opaque |
| `updated_since` | `YYYY-MM-DD` or ISO date-time: only rows changed at or after this instant |

Rows are ordered by `updated_at` then `id`. For a nightly sync: store the last `next_cursor` you
received, and start the next run from it. A row is never skipped; after a crash at worst a row is
repeated, so upsert by the row id (`id` or `record_id`) and the registration number.

A page may contain fewer rows than `limit` even when `has_more` is true (some sources are
filtered after the database read). Keep paging until `has_more` is `false`.

Response envelope:

```json
{
  "success": true,
  "schema_version": "1.0",
  "scope": "export:students",
  "connection_id": "…",
  "organization": { "id": "…", "name": "Beaconhouse National University (BNU)" },
  "personal_fields": false,
  "rows": [ … ],
  "page": { "limit": 200, "count": 200, "next_cursor": "eyJ1Ijoi…", "has_more": true }
}
```

---

## 3. Endpoints

### `GET /students` — scope `export:students`

Students affiliated with the university: linked to its organization account, or whose profile
names it. Only students (no faculty or staff).

| Field | Notes |
| --- | --- |
| `id` | CIEL PK user id (stable) |
| `registration_number` | as entered by the student / roster |
| `student_name`, `department`, `programme`, `enrollment_year` | profile fields |
| `university`, `institution`, `city` | profile fields |
| `account_status`, `profile_verified`, `identity_verified` | CIEL PK verification state |
| `linked_to_university_account` | true when the account is formally linked to the university |
| `email`, `phone` | only with personal fields |
| `created_at`, `updated_at` | ISO |

### `GET /opportunities` — scope `export:opportunities`

Approved opportunities the university dashboard lists: owned by the university, published by
its authorised faculty, or joined by its students.

Fields: `id`, `title`, `types`, `mode`, `city`, `venue`, `start_date`, `end_date`,
`expected_hours`, `volunteers_required`, `primary_sdg`, `secondary_sdgs`, `status`,
`workflow_stage`, `is_student_created`, `owned_by_university`, `host_organization {id, name,
type}`, `faculty_supervisor {name, email?}`, `created_at`, `updated_at`.

### `GET /community-service` — scope `export:community-service`

Verified community-service credit, one row per student per project. `source=structured`
(default) is CIEL PK-verified project reports; `source=quick` is approved Quick Community Impact.

| Field | Notes |
| --- | --- |
| `record_id` | report id, or `logId:participantId` for quick impact |
| `source` | `structured` or `quick` |
| `student_id`, `registration_number`, `student_name`, `department`, `programme`, `enrollment_year` | |
| `opportunity_id`, `title`, `host_organization` | `opportunity_id` is null for quick impact |
| `hours` | credited hours (attendance logs when present, else the verified report) |
| `hours_source` | `attendance`, `report` or `quick` |
| `sdgs` | SDG numbers |
| `faculty_name` | supervising faculty |
| `verified_at` | when CIEL PK verified it |
| `certificate_id`, `verify_url` | public verification of the credit |
| `activity_date` | quick impact only |
| `email`, `phone` | only with personal fields |
| `updated_at` | |

### `GET /fyp` — scope `export:fyp`

Submitted FYP / thesis entries approved by the supervisor, for the university's students.

Fields: `id`, student block, `title`, `school`, `degree`, `graduation_year`, `project_types`,
`supervisor {name, email?}`, `sdgs`, `approval {status, approved_at}`, `merit_rank {rank, of,
scope}` (null until a ranking was published), `created_at`, `updated_at`.

### `GET /ventures` — scope `export:ventures`

Submitted startup / venture entries approved by the supervisor, for the university's students.

Fields: `id`, student block, `venture_name`, `stage`, `faculty`, `venture_department`,
`program`, `academic_year`, `supervisor {name, email?}`, `sdgs`, `visible_on_showcase`,
`approval {supervisor_status, university_status}`, `merit_rank`, `created_at`, `updated_at`.

Founder email and WhatsApp are never exported.

### `GET /summary` — scope `export:summary`

Totals for a period, computed from the same rows the list endpoints return.

Query: `connection_id`, optional `from` and `to` (`YYYY-MM-DD` or ISO). Verified-at is the
period test for community service, approval date for FYPs, last update for ventures.

```json
{
  "summary": {
    "period": { "from": "2026-09-01T00:00:00.000Z", "to": "2027-01-31T00:00:00.000Z" },
    "students": { "total": 1240, "with_verified_community_service": 310 },
    "opportunities": { "total": 42 },
    "community_service": {
      "structured_records": 290, "structured_hours": 4120.5,
      "quick_impact_records": 75, "quick_impact_hours": 160,
      "total_hours": 4280.5
    },
    "fyp": { "approved": 18 },
    "ventures": { "approved": 6 },
    "by_department": [ { "department": "Computer Science", "students": 120, "records": 140, "hours": 1900 } ]
  }
}
```

---

## 4. Error codes

| HTTP | `code` | Meaning |
| --- | --- | --- |
| 401 | `HUB_AUTH_HEADERS_MISSING`, `HUB_SIGNATURE_INVALID`, `HUB_TIMESTAMP_STALE`, `HUB_NONCE_REPLAYED`, `HUB_CREDENTIAL_INVALID` | signing problems (see vendor guide) |
| 400 | `CONNECTION_ID_REQUIRED` | `connection_id` missing or not a UUID |
| 400 | `CURSOR_INVALID`, `LIMIT_INVALID`, `DATE_INVALID`, `SOURCE_INVALID`, `PERIOD_INVALID` | bad query values |
| 403 | `CONNECTION_NOT_FOUND`, `CONNECTION_NOT_ACTIVE`, `CONNECTION_NOT_YET_VALID`, `CONNECTION_EXPIRED` | the connection is not usable |
| 403 | `SCOPE_NOT_GRANTED` | the platform or the connection lacks the scope |
| 403 | `ORGANIZATION_NOT_UNIVERSITY` | export is only for university connections |
| 403 | `PLATFORM_SUSPENDED` | the platform was suspended by CIEL PK |
| 429 | `RATE_LIMITED` | per-platform limit; honour `Retry-After` |

---

## 5. Limits and audit

- Rate limit per platform as configured by CIEL PK (default 120 requests / minute).
- Max 500 rows per page.
- Every call is written to the hub audit trail with the connection, scope, row count and source IP;
  CIEL PK admin sees it under Integrations → Audit.

## 6. Go-live checklist

1. Sandbox credential issued; connection proposed with the export scopes.
2. University approves the connection; CIEL PK authorizes it.
3. University runs a full pull of `students` and `community-service` against the sandbox and
   confirms registration numbers match its records.
4. Personal-fields decision recorded on the connection (and in the data agreement).
5. Nightly job scheduled with cursor storage and retry.
6. Platform switched to live; live credential issued; sandbox credential revoked.
