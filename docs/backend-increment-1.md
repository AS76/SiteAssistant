# Backend increment 1

Historical increment documentation. The current migration, operational-day and
task idempotency behavior is described in [Backend increment 4](backend-increment-4.md).

Local demo API for sites, tasks, transition history and diary entries. Requires
Node.js 24 with `node:sqlite` (`DatabaseSync`). No npm dependencies, external
services or frontend changes. The frontend remains a separate localStorage demo;
it is not connected to this API and the backend does not serve `app/`.

## Run

Run from the repository root; no `npm install` is necessary:

```sh
npm run seed
npm start
```

The API listens on `127.0.0.1:8787`. Set `PORT` to override it (`0` selects an
ephemeral port). Stop with Ctrl+C. Tables are created automatically on database
open. Seed data is entirely fictional: two sites, four tasks and one diary entry.
The seed is transactional and skips the database if any site already exists,
including a partially populated database; it does not repair or overwrite data.

`DATA_DIR` is interpreted literally as the **SQLite database file pathname**,
defaulting to `./data/app.db`, relative to the working directory. Its parent must
already exist; `data/.gitkeep` supplies the default directory. For example:

```sh
DATA_DIR=/tmp/siteassistant-demo.db PORT=8788 npm start
```

Despite the variable name, the value is a file pathname, not a directory. This
avoids filesystem imports and directory creation under the four-module allowlist
(`node:http`, `node:sqlite`, `node:test`, `node:crypto`). Database files under
`data/` are ignored by Git. `openDb(path?)` returns a new connection and
`closeDb(db)` closes it; the HTTP factory `createServer(db)` leaves connection
ownership to its caller.

## JSON API

POST requests require `Content-Type: application/json` and a JSON object (at most
65,536 decoded characters). Responses are JSON objects for single resources and
arrays for lists. Resources use schema field names, including `site_id` in
responses; creation payloads and query filters use `siteId` as shown below.

| Method | Endpoint | Body / behavior |
| --- | --- | --- |
| GET | `/api/sites` | List sites |
| POST | `/api/sites` | `{code,name,location?,start_date?,end_date?}`; returns `201` |
| GET | `/api/sites/:id` | One site |
| GET | `/api/tasks?siteId=&status=` | List tasks; filters optional and combined with AND |
| POST | `/api/tasks` | `{siteId,title,area?,company?,executor,verifier,priority?,due_date?}`; returns `201` with status `todo` |
| GET | `/api/tasks/:id` | Task fields plus `events`, ordered by `at`, then integer event ID ascending |
| POST | `/api/tasks/:id/transition` | `{to,actor,note?,reason?}`; returns `200` with updated task and events |
| GET | `/api/diary?siteId=` | List entries, optionally filtered by site |
| POST | `/api/diary` | `{siteId,operational_date,shift,plan?,actual?,impediments?,next_step?}`; returns `201` |

Text is trimmed, limited to 10,000 characters per field, and type checked.
Required text must be non-empty. Optional text defaults to an empty string;
optional dates default to `null`. Dates must be real `YYYY-MM-DD` calendar dates;
a site's end cannot precede its start. Site codes are unique and case sensitive.
Executor and verifier are required, distinct, case-sensitive identity strings.
Priority is free text and defaults to `normal`. IDs and timestamps supplied in a
creation body are ignored: UUIDs and UTC ISO timestamps are generated server side.
New tasks have no events until their first transition.

Errors consistently use `{ "error": "message", "code": "MACHINE_CODE" }`:

- `400`: invalid JSON, fields, dates, status filter/target, equal executor/verifier,
  missing actor, or a required note/reason.
- `404`: unknown resource or route; creation with an unknown site also returns
  `404`. List filters matching no data return `[]`.
- `409`: forbidden state-machine edge, closure by someone other than the assigned
  verifier, duplicate site code or duplicate diary `(site,date,shift)`.
- `500`: unexpected internal failure, with details kept out of the JSON response.

## State machine

| Current status | Allowed next statuses | Additional requirements |
| --- | --- | --- |
| `todo` | `in_progress`, `blocked` | Blocking requires `reason` |
| `in_progress` | `to_verify`, `blocked` | Completion requires `note`; blocking requires `reason` |
| `to_verify` | `closed`, `blocked` | Closure requires `note` and `actor === verifier`; blocking requires `reason` |
| `closed` | `in_progress` | Reopening requires `reason` |
| `blocked` | None in this increment | No unblock edge was specified |

Every transition requires an actor. Notes and reasons must contain non-whitespace
text where required. Rejected transitions change neither task nor history.
Successful transitions update status and append an event in one SQLite transaction.
Reopening retains all prior events. No executor-only rule is imposed on starting
or submitting work; only closure has the specified verifier check.

## Schema

The exact DDL is in `server/db.mjs`. Foreign keys are enabled on every connection.

| Table | Columns and constraints |
| --- | --- |
| `sites` | `id TEXT PK`, `code TEXT UNIQUE NOT NULL`, `name TEXT NOT NULL`, `location`, `start_date`, `end_date`, `created_at NOT NULL` |
| `tasks` | `id TEXT PK`, `site_id NOT NULL REFERENCES sites(id)`, `title NOT NULL`, `area`, `company`, `executor NOT NULL`, `verifier NOT NULL`, `priority`, `due_date`, `status NOT NULL CHECK IN ('todo','in_progress','to_verify','closed','blocked')`, `created_at NOT NULL` |
| `task_events` | `id INTEGER PK`, `task_id NOT NULL REFERENCES tasks(id)`, `at NOT NULL`, `actor NOT NULL`, `from_status NOT NULL`, `to_status NOT NULL`, `note`, `reason` |
| `diary` | `id TEXT PK`, `site_id NOT NULL REFERENCES sites(id)`, `operational_date NOT NULL`, `shift NOT NULL CHECK IN ('day','night')`, `plan`, `actual`, `impediments`, `next_step`, `created_at NOT NULL`; `UNIQUE(site_id,operational_date,shift)` |

All unspecified column types in the table above are `TEXT`. UUID primary keys are
non-null and generated with `crypto.randomUUID()`; event IDs are SQLite integers.
Dates, timestamps and notes are stored as text. Schema creation uses `IF NOT
EXISTS`, without a migration framework.

## Tests

```sh
npm test
```

This runs the existing frontend domain tests and the new backend tests. Backend
tests use `node:test`, its built-in assertions and global `fetch` against an
ephemeral HTTP server on `127.0.0.1` (port `0`). Each gets a unique temporary
`DATA_DIR` file under `/tmp`, independent of demo data. Connections and listeners
are closed after each test. Temporary database files remain under
`/tmp/siteassistant-test-*.db`; no filesystem module is used to remove them.
There are no outbound network requests.

`tests/index.js` provides the directory entry for the exact `node --test tests/`
command on Node 24. Repository tests also run without an HTTP listener, exercise
actual SQLite constraints and verify rollback on injected write failures. They
can be run separately in an environment that forbids local listeners:

```sh
node --test tests/domain.test.mjs tests/repository.test.mjs
```

## Known limits

**Demo only. No authentication and no concurrency control.** Actor/verifier
strings are client claims, not authenticated identities. Anyone with local API
access can impersonate the verifier. There is no tenant isolation, authorization,
optimistic locking, version check or multi-process coordination. SQLite
transactions provide write atomicity, not application-level conflict resolution.

Also absent: frontend integration, CORS configuration, pagination, task editing
or deletion, unblock/rejection flows, attachments, migrations, backups and
production hardening. SQLite operations are synchronous. Create operations do
not support idempotency keys. The diary unique key prevents duplicate headers,
but there is no diary correction/versioning flow. No deployment is included.
