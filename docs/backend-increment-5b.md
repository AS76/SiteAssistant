# Backend increment 5b

Implemented in the existing application: password login, database sessions, site
roles, nullable task identity references, synthetic identity seed and a minimal
IT/EN login/logout interface. No service, deployment, proxy configuration or
production migration was activated. Traefik Basic authentication remains the
independent edge layer and must remain enabled when this code is deployed.

## Schema and upgrade

Only migration 005 is new. Migrations 001–004, the migration runner, action
derivation, atomic creation events and INVALID_TRANSITION remain intact.
PostgreSQL uses UUID references and timestamptz authentication timestamps. SQLite
uses TEXT UUIDs and UTC ISO timestamps. Email uses TEXT with a unique lower(email)
index, without extensions. Sessions store only the SHA-256 hex digest of a random
32-byte base64url token. Existing tasks retain all labels and history, with NULL
executor_id, verifier_id and submitted_by_id; identities are never inferred from
names. The new assignment IDs are optional in task creation and must reference
active users with suitable roles in that site when provided.

The normal migration runner applies 005 atomically and records it in
schema_migrations. Reopening or calling migrate again is safe on both drivers.
The existing applyMigration helper also applies 005 to a database at 004, inside
a transaction. PostgreSQL permits direct replay of 005. SQLite ADD COLUMN is not
conditionally idempotent: **do not directly replay SQLite 005 or remove its ledger
entry**. Its existing helper only guards additive replay for 004; it is unchanged.
Use the normal versioned runner for SQLite retries. A failed transaction rolls
back all 005 statements before retrying.

## Authentication contract

- POST /api/auth/login accepts email and password; email is trimmed and lowercased.
  Scrypt uses N=16384, r=8, p=1, a random 16-byte salt per password and a 64-byte
  hash. The stored versioned format is scrypt$N$r$p$salt$hash; password_algo is
  scrypt. Passwords are not trimmed. Unsupported hash formats fail closed.
- The sa_session cookie is HttpOnly, SameSite=Lax, host-only and scoped to /api,
  with a seven-day Max-Age. NODE_ENV=production adds Secure. A new login creates
  a new token. Tokens and hashes are never included in JSON responses.
- GET /api/auth/me returns { user: { id, email, name }, roles: [{ site_id, role }] }.
- POST /api/auth/logout sets revoked_at on the current session and expires its
  cookie. Other sessions remain independent. Expired, revoked or disabled-user
  sessions receive 401 AUTH_REQUIRED. No expiry cleanup job is introduced.
- GET /api/health is public and returns only { status: 'ok' }. All other /api/*
  requests require a session, except login and browser OPTIONS preflights.
- Invalid credentials return 401 INVALID_CREDENTIALS. Each server instance has
  a sliding in-memory window of ten attempts per IP and normalized email per
  fifteen minutes, including successful attempts. Further attempts return 429
  RATE_LIMITED and Retry-After in seconds. Instances have independent counters;
  restart resets them. The exported limiter is independently instantiable/resettable.
- IP comes from the socket, not caller-controlled forwarded headers. Behind
  Traefik it can be the proxy address, conservatively sharing the limit for a
  given email. Any future real-client-IP policy needs explicit proxy trust.
- CORS retains the existing exact permitted origin and now permits credentials,
  Content-Type, Idempotency-Key, Authorization and Cookie. Browser clients use
  credentials: include. Auth uses the cookie, not Authorization. API responses
  carry Cache-Control: no-store.

## Authorization and compatibility

All lists are restricted to memberships; explicit site/task/diary reads and writes
check the site's role. Missing memberships and insufficient roles return 403
FORBIDDEN. Viewers can read only. Editors, verifiers and owners can create tasks,
write diary entries and start/submit/block/resume/reopen tasks. Verify and reject
require verifier or owner. The session supplies both the acting user ID and the
historical event name; a body actor is ignored, including during creation.

Verification and rejection compare submitted_by_id with the acting user ID. Only
when that ID is NULL is submitted_by used as a compatibility fallback. Self-review
returns 409 INVALID_TRANSITION; missing submitter metadata returns 400
SUBMITTER_REQUIRED for both operations. Assignment labels do not grant privileges.
A verifier/owner role permits review, regardless of the historical verifier label,
provided the actor did not submit the work. Submission updates both submitter
fields; block/resume preserve them. The trusted internal repository API retains
its legacy label-based call form for 5a tests; HTTP always passes an authenticated
principal. Future external entry points must do the same.

Owners manage existing users through GET/POST /api/sites/:id/members. POST accepts
{ user_id, role }; role null removes membership. An owner cannot downgrade or
remove themselves. User registration, password reset and a member-management UI
are outside this increment. Creating a site requires ownership of an existing
site and grants the creator ownership atomically; initial access comes from seed
or controlled administrative provisioning. Diary writes use the task-write roles.

Task idempotency still hashes the exact request bytes, then binds that hash to
the authenticated user ID. Authorization is checked before replay. Reusing a key
as another user returns 409 instead of exposing a previous response. Pre-5b saved
keys cannot be replayed by authenticated requests with the old hash.

The UI calls me before loading data, shows the existing-style login form on 401,
provides logout and clears loaded data when a session is rejected. Actor display
is read-only; the obsolete client-side verifier-name gate was removed. Existing
free-text assignment fields remain supported with nullable IDs. No framework,
dependency, redesign or additional workflow UI was introduced.

## Synthetic local/staging seed

Use an isolated SQLite file whose parent directory already exists:

```sh
DB_DRIVER=sqlite DATA_DIR=/tmp/siteassistant-demo.db npm run seed
DB_DRIVER=sqlite DATA_DIR=/tmp/siteassistant-demo.db npm run seed -- --reset
```

The seed is atomic. It creates four users, two fictional sites, four tasks with
editor/verifier IDs, eight memberships and one diary entry. Repeated runs skip an
existing populated database without adding duplicates or replacing passwords.
For an existing pre-auth demo, explicitly use --reset on the disposable demo DB:
it deletes only application data (including sessions and idempotency entries),
never schema_migrations. This is destructive to that application's records.
The seed refuses environments other than development, test or staging; the CLI
also rejects production before opening storage.

These published passwords are exclusively synthetic local/staging credentials:

| Email | Password | Role on both sites |
| --- | --- | --- |
| owner@example.invalid | Local-owner-5b! | owner |
| editor@example.invalid | Local-editor-5b! | editor |
| verifier@example.invalid | Local-verifier-5b! | verifier |
| viewer@example.invalid | Local-viewer-5b! | viewer |

For production, provision independent users and credentials; never promote a
seeded demo database containing these known passwords. Serve frontend and API
same-origin locally, or use an explicitly configured development proxy. The
existing CORS allowlist and same-site cookie policy are unchanged in scope.

## Verification and reviewer handoff

New listener tests exercise the real HTTP handler without opening sockets. They
cover login success/failure, HttpOnly/Secure attributes, safe JSON, session expiry,
revocation, disabled accounts, rate limiting, membership isolation, forged actors,
self-review by ID after renaming, legacy fallback, member management, UUID/FK and
case-insensitive email constraints, idempotency isolation and seed reset.
SQLite and in-memory PGlite cover migration 005 upgrades and synthetic login.
PGlite is not verification of the pg driver against a PostgreSQL server.

Existing HTTP fixtures now provision real users/sessions and independent reviewer
sessions. Idempotency expectations include the authenticated user; old label-only
repository tests still exercise unchanged 5a behavior. Browser coverage now signs
in, switches sessions to verify, checks HttpOnly and logs out. Existing socket
suites remain socket suites: sandbox listen EPERM must be reported, not hidden.

Before acceptance on a real PostgreSQL test database, run the existing guarded
pg suite and check UUID/timestamptz values through PgStorage, FKs, lower(email)
uniqueness, populated upgrades, transaction rollback and concurrent writes.
Also run the browser flow with Chromium and verify actual HTTPS cookie behavior,
credentialed CORS and both authentication layers through Traefik. No remote DB
or deployment was used for this implementation.

Workspace validation: npm test was executed with DB_DRIVER=sqlite. The detailed
suite run reported 82 passing tests, four PostgreSQL-only skips and twelve failures,
all listen EPERM from the sandbox (two client HTTP tests and ten server tests).
A separate run importing only suites without sockets passed 80 tests with four
PostgreSQL-only skips; the two client unit tests also passed in the full run.
npm run test:schema passed all nine tests. The SQLite seed CLI was run twice,
then with --reset: insert, no-op and explicit rebuild all succeeded. git diff
--check passed. The PostgreSQL command was not run; Playwright and Chromium were
unavailable, so browser acceptance remains unverified.
