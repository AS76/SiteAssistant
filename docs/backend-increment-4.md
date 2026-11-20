# Backend increment 4

Implemented locally: versioned application migrations, operational-day helpers,
and optional task creation idempotency. No new dependencies or frontend changes.
No external service or deployment is activated, and no operational database
migration has been applied as part of this implementation. The separate ingestion
schema in `database/import-schema.sql` remains a proposed model with its own tests.

## Application migrations

`openDb(location, { driver, schema })` now calls
`migrate(db, { driver })` from `server/migrations/index.mjs`.
The runner reads `NNN_name.sql` files from `server/migrations/sqlite/` or
`server/migrations/pg/` in filename order. It records each version in
`schema_migrations(version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)` and skips
previously applied versions. Each migration and its version insert share one
transaction; a failed migration can be retried. Earlier successful versions stay
applied if a later migration fails. Serialize migration runners during startup;
concurrent multi-process migration coordination is outside this increment.

| Version | Change |
| --- | --- |
| `001` | Existing `sites`, `tasks`, `task_events`, `diary` DDL, with `IF NOT EXISTS` for adoption of populated databases |
| `002` | Diary `time_zone` and `day_cutoff_time`, with non-null defaults `Europe/Rome` and `06:00` |
| `003` | `idempotency_keys` response storage |

PostgreSQL event IDs retain `GENERATED ALWAYS AS IDENTITY`. The `schema` option
still selects the PostgreSQL schema. SQLite enables foreign keys in `openDb`,
outside migration SQL. Existing diary rows receive the defaults; their dates and
timestamps are preserved, without recalculation.

## Operational day and diary API

`server/operational-day.mjs` exports pure functions using `Intl.DateTimeFormat`:

- `operationalDate(instant, { timeZone = 'Europe/Rome', cutoff = '06:00' })`
  returns a `YYYY-MM-DD` date.
- `shiftOf(instant, { timeZone = 'Europe/Rome', dayStart = '06:00', nightStart = '18:00' })`
  returns `day` or `night`.
- `crossesMidnight(startHHMM, endHHMM)` returns `end <= start`, including equal
  times. Boundaries must be valid `HH:MM` strings.

The default operational day starts at 06:00 local time and ends just before the
next local 06:00. Before the cutoff, the preceding calendar date is used, including
on daylight-saving transition days. The day shift covers `[06:00, 18:00)`;
the remaining hours are the night shift.

`POST /api/diary` accepts
`{siteId, operational_date?, shift, time_zone?, day_cutoff_time?, plan?, actual?, impediments?, next_step?}`.
When `operational_date` is omitted, the server derives it from the same instant
saved as `created_at`. A supplied date retains the existing calendar-date
validation and is saved unchanged, allowing backdating. Explicit null or empty
dates remain invalid. The shift is still required; it is not inferred.

Zone and cutoff default to `Europe/Rome` and `06:00`, are validated even for a
backdated entry, and are returned and stored next to the date and instant.
Invalid zone/cutoff values return `400 VALIDATION_ERROR`. The existing unique key
`(site_id, operational_date, shift)` is unchanged.

## Task creation idempotency

`POST /api/tasks` accepts an optional `Idempotency-Key` header, also allowed by
the existing CORS policy. Without the header, each successful request creates a
new task as before. With a key:

- The request hash is SHA-256 of the original body bytes, before JSON parsing.
  Whitespace and property ordering therefore matter.
- A successful response is stored with its status and JSON body. Repeating the
  same key, route and hash replays that response, even if the task later changes.
- Reusing a key with a different hash or route returns
  `409 IDEMPOTENCY_KEY_REUSED`.
- The key reservation, task insert and response storage commit atomically. A
  primary-key collision rolls back the losing transaction before reading and
  replaying the winner. No placeholder response is committed.

Keys are globally unique within the application schema, without an expiry policy.
Only successful task creation responses are retained. Validation failures and
other failed transactions do not consume a key, so a corrected request can retry.
Malformed JSON and existing request size/content-type checks still run before
idempotency processing. Other POST routes do not use the header.

## Verification

Use Node.js 24. Run `npm test`, `npm run test:schema`, and, where configured,
`npm run test:pg`. PostgreSQL tests require `DATABASE_URL_TEST`, target only the
test database checked by `tests/helpers/db.mjs`, and isolate each fixture in a
temporary schema. They never fall back to `DATABASE_URL`.

The migration tests use temporary SQLite files and an in-memory PGlite schema;
the latter checks PostgreSQL SQL but does not replace real PostgreSQL integration.
Operational-day tests fix instants in Europe/Rome, including both 2026 clock
changes. `tests/increment-4-http.test.mjs` exercises the HTTP listener with raw
byte streams without binding a socket, including concurrent key collisions.
The existing HTTP integration tests still require permission to bind localhost.
