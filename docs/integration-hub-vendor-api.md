# CIEL PK Integration Hub — Vendor API Guide (v1)

For external platforms that push activity records to CIEL PK. One protocol for every vendor.

Base URL: `https://cielbackend-ecru.vercel.app/api/integrations/v1`
(use the sandbox credentials CIEL PK issued until your platform is switched to live)

What you receive from CIEL PK:

| Item | Example | Where it comes from |
| --- | --- | --- |
| Key id | `hk_3f9c…` | issued per platform by CIEL PK admin |
| Secret | shown once at issuance | keep it server-side, never in a browser or app |
| Connection id | UUID | one per organization you are connected to |
| Metric codes | `trees_planted`, `volunteer_hours` | the CIEL PK metric catalog |

What you never receive: CIEL PK student, opportunity, attendance, report or ranking data. The API
is one-way. The only thing you can read back is the status of your own submissions.

---

## 1. Signing every request

Every call carries four headers:

| Header | Value |
| --- | --- |
| `X-Hub-Key-Id` | your key id |
| `X-Hub-Timestamp` | current unix time in seconds; must be within ±300 s of server time |
| `X-Hub-Nonce` | random string, 16–64 chars of `A-Z a-z 0-9 _ - : .`, unique per request |
| `X-Hub-Signature` | `v1=` + hex HMAC-SHA256 of the canonical string, keyed with your secret |

Canonical string (five newlines, no trailing newline):

```
v1\n
<METHOD in upper case>\n
<path without query string, e.g. /api/integrations/v1/events>\n
<timestamp>\n
<nonce>\n
<sha256 hex of the exact request body bytes; sha256 of empty string for GET>
```

Rules: request bodies must be `Content-Type: application/json` and must be sent byte-for-byte as
hashed (no re-serialization after signing). Each nonce is accepted once. Responses to signature
problems are `401` with a `code` such as `HUB_SIGNATURE_INVALID`, `HUB_TIMESTAMP_STALE`,
`HUB_NONCE_REPLAYED`, `HUB_CREDENTIAL_INVALID`.

### Bash helper (curl + openssl)

```bash
#!/usr/bin/env bash
# usage: ./hub.sh METHOD PATH [JSON_BODY]
set -euo pipefail
BASE="https://cielbackend-ecru.vercel.app"
KEY_ID="${HUB_KEY_ID:?}"; SECRET="${HUB_SECRET:?}"
METHOD="$1"; URL_PATH="$2"; BODY="${3:-}"
TS=$(date +%s); NONCE=$(openssl rand -hex 16)
BODY_SHA=$(printf '%s' "$BODY" | openssl dgst -sha256 | awk '{print $NF}')
CANON=$(printf 'v1\n%s\n%s\n%s\n%s\n%s' "$METHOD" "$URL_PATH" "$TS" "$NONCE" "$BODY_SHA")
SIG=$(printf '%s' "$CANON" | openssl dgst -sha256 -hmac "$SECRET" | awk '{print $NF}')
curl -sS -X "$METHOD" "$BASE$URL_PATH" \
  -H "X-Hub-Key-Id: $KEY_ID" -H "X-Hub-Timestamp: $TS" \
  -H "X-Hub-Nonce: $NONCE" -H "X-Hub-Signature: v1=$SIG" \
  ${BODY:+-H "Content-Type: application/json" --data-binary "$BODY"}
echo
```

### Node.js

```js
const crypto = require('crypto');
function sign({ keyId, secret, method, path, body = '' }) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = crypto.randomBytes(16).toString('hex');
  const bodySha = crypto.createHash('sha256').update(body).digest('hex');
  const canonical = ['v1', method.toUpperCase(), path, timestamp, nonce, bodySha].join('\n');
  const mac = crypto.createHmac('sha256', secret).update(canonical).digest('hex');
  return {
    'X-Hub-Key-Id': keyId, 'X-Hub-Timestamp': timestamp,
    'X-Hub-Nonce': nonce, 'X-Hub-Signature': `v1=${mac}`,
  };
}
// const body = JSON.stringify(payload);
// fetch(BASE + path, { method: 'POST', headers: { ...sign({...}), 'Content-Type': 'application/json' }, body });
```

### Python

```python
import hashlib, hmac, json, os, time, requests
def sign(key_id, secret, method, path, body=b""):
    ts = str(int(time.time())); nonce = os.urandom(16).hex()
    body_sha = hashlib.sha256(body).hexdigest()
    canonical = "\n".join(["v1", method.upper(), path, ts, nonce, body_sha])
    mac = hmac.new(secret.encode(), canonical.encode(), hashlib.sha256).hexdigest()
    return {"X-Hub-Key-Id": key_id, "X-Hub-Timestamp": ts,
            "X-Hub-Nonce": nonce, "X-Hub-Signature": f"v1={mac}"}
# body = json.dumps(payload, separators=(",", ":")).encode()
# requests.post(BASE + path, data=body, headers={**sign(...), "Content-Type": "application/json"})
```

---

## 2. Endpoints

### `GET /status` — your platform and connections

```bash
./hub.sh GET /api/integrations/v1/status
```

Returns your platform status, your limits, and each connection with its id, organization,
status and scopes. Use the `connection_id` values in events.

### `POST /events` — submit one event, an array, or `{ "events": [...] }`

```bash
./hub.sh POST /api/integrations/v1/events "$(cat event.json)"
```

Response `200` when every event reached a final state in this request, `202` when some are queued
for processing. Either way the body is:

```json
{
  "success": true, "accepted": 1, "rejected": 0,
  "receipts": [
    { "event_id": "dt-2026-11-03-0001", "receipt_id": "7b1e…", "status": "processed" }
  ]
}
```

Receipt statuses: `processed`, `received` or `deferred` (queued, check later), `rejected` (with
`error_code` and `errors`), `duplicate` (that `event_id` was already submitted; same receipt).

### `GET /events/{receipt_id}` — status of one submission

```bash
./hub.sh GET /api/integrations/v1/events/7b1e…
```

`404` for any receipt that is not yours.

### Evidence: ticket → upload → complete

```bash
# 1. ask for an upload ticket
./hub.sh POST /api/integrations/v1/evidence/upload-ticket \
  '{"connection_id":"<uuid>","content_type":"image/jpeg","size_bytes":183422,"original_name":"site.jpg"}'
# → { "ticket": { "upload_id": "...", "upload_url": "https://…", "method": "PUT",
#       "headers": { "Content-Type": "image/jpeg", "Content-Length": "183422" }, "expires_in_seconds": 900 } }

# 2. upload the bytes straight to storage (not to the API), with exactly those headers
curl -sS -X PUT "<upload_url>" -H "Content-Type: image/jpeg" -H "Content-Length: 183422" --data-binary @site.jpg

# 3. tell the hub the upload finished (sha256 optional but recommended)
./hub.sh POST /api/integrations/v1/evidence/<upload_id>/complete '{"sha256":"<hex>"}'
# → { "evidence": { "evidence_id": "...", "upload_id": "...", "state": "accepted", "sha256": "..." } }
```

Then reference the `upload_id` in an event (`evidence: [{ "upload_id": "..." }]`). Evidence must
be completed and accepted before an event may reference it. Allowed types by default: jpeg, png,
webp, pdf, mp4, quicktime, webm, mp3, m4a, wav, webm audio. Default size limit 100 MB.

---

## 3. The event envelope

```json
{
  "schema_version": "1.0",
  "event_id": "dt-2026-11-03-0001",
  "event_type": "activity.session",
  "connection_id": "<uuid from CIEL PK>",
  "occurred_at": "2026-11-03T09:00:00+05:00",
  "activity": { "external_id": "plant-lhr-0007", "type": "plantation", "title": "Model Town drive" },
  "payload": { "location": "Lahore", "session_hours": 4, "participants_count": 8 },
  "metrics": [
    { "code": "trees_planted", "value": 40 },
    { "code": "volunteer_hours", "value": 32 }
  ],
  "evidence": [ { "upload_id": "<from an accepted upload>" } ],
  "attestation": { "lawful_basis": "consent", "consent_ref": "DT-C-5521", "obtained_at": "2026-11-01" },
  "correlation": { "corrects": null, "voids": null }
}
```

| Field | Rules |
| --- | --- |
| `event_id` | your unique id, 1–128 chars; resubmitting the same id returns `duplicate` |
| `event_type` | one of the five types below |
| `connection_id` | must be an active connection of your platform; the event type must be in its scopes |
| `occurred_at` | ISO-8601 with offset; not more than one day in the future |
| `activity.external_id` | your stable id for the activity; all five types key on it |
| `activity.type` | free text up to 64 chars, e.g. `plantation` |
| `payload` | any JSON object up to 64 KB per event; stored as sent |
| `metrics[]` | `code` must exist in the CIEL PK catalog; `value` numeric, within the catalog range |
| `evidence[]` | accepted upload ids only |
| `attestation` | required when the payload contains personal fields and the connection allows them |

Personal data: payloads are scanned for fields that identify a person (`name`, `email`, `phone`,
`cnic`, `student_name`, addresses, e-mail or CNIC-looking strings). Unless CIEL PK has enabled
personal fields on your connection, such events are rejected with `PERSONAL_DATA_NOT_ALLOWED`.
Send counts (`participants_count`), not identities.

## 4. The five event types

| Type | Effect | Required |
| --- | --- | --- |
| `activity.session` | creates the activity record, or a new version if it already exists | `payload`, usually `metrics` |
| `impact.metric` | updates only the metrics of an existing activity (merged by code) | `metrics`, existing activity |
| `evidence.item` | attaches accepted uploads to an existing activity | `evidence[]`, existing activity |
| `activity.corrected` | replaces payload/metrics with a new version; totals move from old to new | `correlation.corrects` = the `event_id` being corrected |
| `activity.voided` | withdraws the activity; it leaves all totals | existing activity |

Examples (only the differing fields shown):

```json
{ "event_type": "impact.metric", "event_id": "dt-0002", "activity": { "external_id": "plant-lhr-0007", "type": "plantation" },
  "metrics": [ { "code": "survival_rate", "value": 87.5 } ] }

{ "event_type": "activity.corrected", "event_id": "dt-0003", "activity": { "external_id": "plant-lhr-0007", "type": "plantation" },
  "payload": { "location": "Lahore", "session_hours": 4, "participants_count": 8 },
  "metrics": [ { "code": "trees_planted", "value": 32 } ], "correlation": { "corrects": "dt-2026-11-03-0001" } }

{ "event_type": "activity.voided", "event_id": "dt-0004", "activity": { "external_id": "plant-lhr-0007", "type": "plantation" } }
```

## 5. Error codes you will see

| Code | Meaning | What to do |
| --- | --- | --- |
| `ENVELOPE_INVALID` | structural problem; `errors` lists each one | fix and resend with the same `event_id` |
| `EVENT_TYPE_NOT_IN_SCOPE` | type not enabled for that connection | ask CIEL PK to widen scopes |
| `CONNECTION_NOT_FOUND` / `CONNECTION_NOT_ACTIVE` / `CONNECTION_EXPIRED` | connection problem | check `/status` |
| `METRIC_INVALID` | unknown code, wrong unit or out of range | use catalog codes |
| `PERSONAL_DATA_NOT_ALLOWED` / `ATTESTATION_REQUIRED` | personal fields present | remove them, or supply attestation if allowed |
| `RECORD_NOT_FOUND` | metric/evidence/correction/void for an activity never submitted | send `activity.session` first |
| `EVIDENCE_NOT_FOUND` / `EVIDENCE_NOT_ACCEPTED` / `EVIDENCE_ALREADY_LINKED` | upload id problems | complete the upload first; one record per upload |
| `RATE_LIMITED` (429) | over your per-minute quota | wait `Retry-After` seconds |
| `PAYLOAD_TOO_LARGE` (413) / `BATCH_TOO_LARGE` | request too big | split the batch |
| `UNSUPPORTED_MEDIA_TYPE` (415) | body was not JSON | send `application/json` |

## 6. Limits (defaults; CIEL PK can adjust per platform)

Requests per minute 120 · events per request 50 · request body 256 KB · event 64 KB ·
metrics per event 50 · evidence per event 20 · evidence file 100 MB · upload ticket valid 15 min.

## 7. Go-live checklist (sandbox)

1. `/status` succeeds with your key.
2. One `activity.session` → `processed`; resend the same `event_id` → `duplicate`.
3. One `activity.corrected` and one `activity.voided` → `processed`.
4. Evidence ticket → upload → complete → event referencing it → `processed`.
5. A deliberately wrong signature → `401 HUB_SIGNATURE_INVALID`.
6. A metric code not in the catalog → `rejected METRIC_INVALID`.

When these pass, CIEL PK switches the platform from sandbox to live. Nothing changes in your
integration at that moment.
