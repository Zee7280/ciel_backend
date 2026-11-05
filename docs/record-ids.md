# Public record IDs

Every submitted record gets a readable id: `CIEL-{UNI}-{YEAR}-{SEQ}` (for example `CIEL-BNU-2026-0421`).

- `UNI` is the university code (unique, stored on the `universities` table).
- `YEAR` is the academic year; it starts on 1 August.
- `SEQ` is padded to 4 digits and keeps growing past 9999.
- One counter per (university, academic year), shared by all five record kinds:
  community engagement (`student_reports`), Quick Impact (`quick_work_logs`),
  coursework (`course_project_entries`), FYP (`fyp_entries`) and startup (`venture_entries`).

## What happens on deploy (no manual SQL)

1. On the first boot, `prepareRecordIdsBeforeSync` (`src/database/record-ids-before-sync.ts`) runs right after
   `widenColumnsBeforeSync`. Under a Postgres advisory lock it adds the nullable `universityId` / `publicId`
   columns and their indexes to the five tables (`ADD COLUMN IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, with the
   same index names TypeORM generates). Lock waits are capped, it is a cheap no-op afterwards, and a failure only
   logs a warning (schema sync then adds the same things). Look for the log line
   `Public record ids: added … column(s) and … index(es)`.
2. TypeORM `synchronize` creates the `universities` and `record_counters` tables. The 96 listed universities are
   seeded at startup (idempotent).
3. New records are stamped when they are first submitted. A draft or a resubmit never changes an id.
4. Existing records are stamped by the nightly job (500 per night, oldest first) or immediately by an admin:
   `POST /api/v1/admin/record-ids/backfill` with `{"dryRun": false, "limit": 500}`. Records created before the
   backfill take lower numbers than ones submitted after it, so run the backfill soon after deploying.

## Rules worth knowing

- `publicId` and `universityId` are write-once (`update: false` in the ORM). Only `RecordIdsService` writes them,
  with raw SQL, so a stale entity save can never overwrite an issued id.
- The `users` table never gains columns (guarded by `user.entity.columns.spec.ts`); a user's university is derived
  from their profile each time.
- A record's university is resolved in the same order as `isAffiliatedWithUniversity` (organisation, then profile,
  then typed claims). Records that cannot be matched are never guessed: they are listed by
  `GET /api/v1/admin/record-ids/unmatched`.
- A record with a stamped `universityId` stays with that university. Records not yet stamped fall back to the old
  university-name matching.
- Stamping never blocks a submit: errors are logged and the record is stamped later by the backfill.

## Admin endpoints (super admin only, `admin/record-ids`)

`GET universities`, `POST universities`, `PATCH universities/:id` (the code is frozen once ids exist),
`POST backfill`, `GET unmatched`, `GET lookup/:publicId`.
