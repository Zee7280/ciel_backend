# CIEL PK University Export API v1

Read-only pull of a university's CIEL PK records into its own systems (ERP / SIS / LMS / warehouse).

| | |
| --- | --- |
| Base URL | `https://cielbackend-ecru.vercel.app/api/integrations/v1/export` |
| Protocol | HTTPS, `GET` only, JSON responses |
| Auth | HMAC-SHA256 request signing (same as the CIEL PK vendor API) |
| Paging | opaque cursor, max 500 rows per page |
| Rate limit | 120 requests / min per platform; `summary` 6 / min |

## Credentials

Issued by CIEL PK admin. Keep the secret server-side.

| Item | Format |
| --- | --- |
| `KEY_ID` | `hk_…` |
| `SECRET` | shown once at issuance |
| `CONNECTION_ID` | UUID of the platform → university connection |
| Scopes | `export:students` `export:opportunities` `export:community-service` `export:fyp` `export:ventures` `export:summary` |

Activation: CIEL PK registers the platform and proposes the connection → university approves it in its dashboard (Integrations) → CIEL PK authorizes it.

## Signing

Headers on every request:

| Header | Value |
| --- | --- |
| `X-Hub-Key-Id` | `KEY_ID` |
| `X-Hub-Timestamp` | unix seconds, within ±300 s of server time |
| `X-Hub-Nonce` | 16–64 chars `[A-Za-z0-9_-:.]`, unique per request |
| `X-Hub-Signature` | `v1=` + hex HMAC-SHA256(`SECRET`, canonical) |

Canonical string (newline-separated, no trailing newline):

```
v1
GET
/api/integrations/v1/export/<resource>
<timestamp>
<nonce>
e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
```

Line 3 is the path only (no query string). Line 6 is the SHA-256 of an empty body, constant for every export call.

### PHP

```php
<?php
const BASE = 'https://cielbackend-ecru.vercel.app';
const EMPTY_SHA = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

function signHeaders(string $path): array {
    $ts = (string) time();
    $nonce = bin2hex(random_bytes(16));
    $canonical = implode("\n", ['v1', 'GET', $path, $ts, $nonce, EMPTY_SHA]);
    $sig = hash_hmac('sha256', $canonical, getenv('CIEL_SECRET'));
    return [
        'X-Hub-Key-Id: ' . getenv('CIEL_KEY_ID'),
        'X-Hub-Timestamp: ' . $ts,
        'X-Hub-Nonce: ' . $nonce,
        'X-Hub-Signature: v1=' . $sig,
    ];
}

function fetchAll(string $resource, string $connectionId, array $extra = []): Generator {
    $path = "/api/integrations/v1/export/$resource";
    $cursor = null;
    do {
        $q = ['connection_id' => $connectionId, 'limit' => 500] + $extra;
        if ($cursor) $q['cursor'] = $cursor;
        $ch = curl_init(BASE . $path . '?' . http_build_query($q));
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_HTTPHEADER => signHeaders($path),
            CURLOPT_TIMEOUT => 60,
        ]);
        $raw = curl_exec($ch);
        $status = curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        curl_close($ch);
        if ($status !== 200) throw new RuntimeException("$status $raw");
        $body = json_decode($raw, true);
        foreach ($body['rows'] as $row) yield $row;
        $cursor = $body['page']['next_cursor'];   // persist after each page
    } while ($body['page']['has_more']);
}

foreach (fetchAll('students', getenv('CIEL_CONNECTION_ID')) as $s) {
    echo $s['registration_number'], ' ', $s['student_name'], PHP_EOL;
}
```

### Python

```python
import hashlib, hmac, os, time, requests

BASE = "https://cielbackend-ecru.vercel.app"
EMPTY_SHA = hashlib.sha256(b"").hexdigest()

def sign(path):
    ts, nonce = str(int(time.time())), os.urandom(16).hex()
    canonical = "\n".join(["v1", "GET", path, ts, nonce, EMPTY_SHA])
    sig = hmac.new(os.environ["CIEL_SECRET"].encode(), canonical.encode(), hashlib.sha256).hexdigest()
    return {"X-Hub-Key-Id": os.environ["CIEL_KEY_ID"], "X-Hub-Timestamp": ts,
            "X-Hub-Nonce": nonce, "X-Hub-Signature": f"v1={sig}"}

def fetch_all(resource, connection_id, **params):
    path, cursor = f"/api/integrations/v1/export/{resource}", None
    while True:
        q = {"connection_id": connection_id, "limit": 500, **params}
        if cursor: q["cursor"] = cursor
        r = requests.get(BASE + path, params=q, headers=sign(path), timeout=60)
        r.raise_for_status()
        body = r.json()
        yield from body["rows"]
        cursor = body["page"]["next_cursor"]
        if not body["page"]["has_more"]: return
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
  return { "X-Hub-Key-Id": process.env.CIEL_KEY_ID, "X-Hub-Timestamp": ts,
           "X-Hub-Nonce": nonce, "X-Hub-Signature": `v1=${sig}` };
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

## Paging

Query parameters on every list endpoint:

| Param | Required | Description |
| --- | --- | --- |
| `connection_id` | yes | UUID |
| `limit` | no | 1–500, default 200 |
| `cursor` | no | `page.next_cursor` from the previous page |
| `updated_since` | no | `YYYY-MM-DD` or ISO date-time; rows changed at or after it |

Order: `updated_at`, then `id`. Store the last `next_cursor`; start the next run from it. Rows are never skipped; after a crash a row may repeat, so upsert on `id` / `record_id`. A page may hold fewer than `limit` rows while `has_more` is true; loop until `has_more` is false.

Response envelope:

```json
{
  "success": true,
  "schema_version": "1.0",
  "scope": "export:students",
  "connection_id": "…",
  "organization": { "id": "…", "name": "…" },
  "personal_fields": false,
  "rows": [],
  "page": { "limit": 200, "count": 200, "next_cursor": "…", "has_more": true }
}
```

## Personal fields

`email`, `phone` and supervisor `email` are present only when the connection's personal-fields flag is on **and** the platform is live. Sandbox never returns them. Absent means the key is missing, not null. `registration_number` is always present.

## Endpoints

### GET /students — `export:students`

Students affiliated with the university (linked account, or profile names it). Students only.

| Field | Type |
| --- | --- |
| `id` | uuid |
| `registration_number` | string \| null |
| `student_name` `department` `programme` `enrollment_year` | string \| null |
| `university` `institution` `city` | string \| null |
| `account_status` | string |
| `profile_verified` `identity_verified` `linked_to_university_account` | boolean |
| `email` `phone` | string \| null (personal) |
| `created_at` `updated_at` | ISO |

### GET /opportunities — `export:opportunities`

Approved, visible opportunities on the university dashboard (owned, via authorised faculty, or joined by its students).

| Field | Type |
| --- | --- |
| `id` `title` | |
| `types` | string[] |
| `mode` `city` `venue` | string \| null |
| `start_date` `end_date` | string \| null |
| `expected_hours` `volunteers_required` | number \| null |
| `primary_sdg` | number \| null |
| `secondary_sdgs` | number[] |
| `status` `workflow_stage` | string \| null |
| `is_student_created` `owned_by_university` | boolean |
| `host_organization` | `{ id, name, type }` \| null |
| `faculty_supervisor` | `{ name, email? }` |
| `created_at` `updated_at` | ISO |

### GET /community-service — `export:community-service`

Verified credit, one row per student per activity. Extra param `source`: `structured` (default, CIEL PK-verified project reports) or `quick` (approved Quick Community Impact).

| Field | Type |
| --- | --- |
| `record_id` | report id, or `logId:participantId` for quick |
| `source` | `structured` \| `quick` |
| `student_id` `registration_number` `student_name` `department` `programme` `enrollment_year` | |
| `opportunity_id` | uuid \| null (null for quick) |
| `title` `host_organization` | string \| null |
| `hours` | number |
| `hours_source` | `attendance` \| `report` \| `quick` |
| `sdgs` | number[] |
| `faculty_name` | string \| null |
| `verified_at` | ISO |
| `certificate_id` `verify_url` | string \| null |
| `activity_date` | string \| null (quick only) |
| `email` `phone` | personal |
| `updated_at` | ISO |

### GET /fyp — `export:fyp`

Submitted FYP / thesis entries approved by the supervisor.

| Field | Type |
| --- | --- |
| `id` | uuid |
| student block | as above |
| `title` `school` `degree` `graduation_year` | string \| null |
| `project_types` | string[] |
| `supervisor` | `{ name, email? }` |
| `sdgs` | number[] |
| `approval` | `{ status, approved_at }` |
| `merit_rank` | `{ rank, of, scope }` \| null |
| `verify_url` | public verification page |
| `created_at` `updated_at` | ISO |

### GET /ventures — `export:ventures`

Submitted venture entries approved by the supervisor. Founder contact is never exported.

| Field | Type |
| --- | --- |
| `id` | uuid |
| student block | as above |
| `venture_name` `stage` `faculty` `venture_department` `program` `academic_year` | string \| null |
| `supervisor` | `{ name, email? }` |
| `sdgs` | number[] |
| `visible_on_showcase` | boolean |
| `approval` | `{ supervisor_status, university_status }` |
| `merit_rank` | `{ rank, of, scope }` \| null |
| `verify_url` | public verification page |
| `created_at` `updated_at` | ISO |

### GET /summary — `export:summary`

Period totals from the same rows as the list endpoints. Params: `connection_id`, optional `from`, `to` (`YYYY-MM-DD` or ISO). Period test: `verified_at` for community service, `approved_at` for FYP, `updated_at` for ventures.

```json
{
  "success": true,
  "schema_version": "1.0",
  "scope": "export:summary",
  "connection_id": "…",
  "organization": { "id": "…", "name": "…" },
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

## Errors

Body: `{ "success": false, "code": "…", "message": "…" }`

| HTTP | Code |
| --- | --- |
| 401 | `HUB_AUTH_HEADERS_MISSING` `HUB_TIMESTAMP_STALE` `HUB_NONCE_INVALID` `HUB_NONCE_REPLAYED` `HUB_CREDENTIAL_INVALID` `HUB_SIGNATURE_INVALID` |
| 400 | `CONNECTION_ID_REQUIRED` `CURSOR_INVALID` `LIMIT_INVALID` `DATE_INVALID` `SOURCE_INVALID` `PERIOD_INVALID` |
| 403 | `CONNECTION_NOT_FOUND` `CONNECTION_NOT_ACTIVE` `CONNECTION_NOT_YET_VALID` `CONNECTION_EXPIRED` `SCOPE_NOT_GRANTED` `ORGANIZATION_NOT_UNIVERSITY` `PLATFORM_SUSPENDED` |
| 429 | `RATE_LIMITED` — honour `Retry-After` |
| 500 | audit write failed; retry later |

## Operational notes

- Responses are `Cache-Control: no-store`. Do not cache or log bodies.
- Every call is audited (connection, scope, row count, IP) before the response is sent.
- Query string is not signed; TLS plus timestamp and single-use nonce cover it. HTTPS only.

## Go-live

1. Sandbox credential + connection with export scopes; university approves, CIEL PK authorizes.
2. Full pull of `students` and `community-service` against sandbox; match registration numbers.
3. Personal-fields decision recorded on the connection and in the data agreement.
4. Nightly job with cursor storage and retry.
5. Platform set to live; live credential issued; sandbox credential revoked.
