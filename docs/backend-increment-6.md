# Backend increment 6

Implemented locally: self-service access requests, owner approval/rejection by
email review page with explicit POST confirmation, temporary passwords, authenticated password change, forgotten
password reset and a minimal IT/EN UI. This extends increment 5 authentication;
site roles, verification rules and deployment infrastructure are unchanged.
No service was activated and no production migration was applied.

## Endpoints and flow

| Endpoint | Input and result |
| --- | --- |
| `POST /api/auth/request` | `{email}`; normalized lowercase, syntax checked; `202 {"status":"accepted"}` for valid addresses, including duplicates and existing accounts. |
| `GET /api/auth/request/decide` | `?token=…`; read-only branded HTML confirmation with the applicant email, request timestamp in UTC and Approva/Rifiuta buttons. Any `decision` query parameter is ignored. |
| `POST /api/auth/request/decide` | `application/x-www-form-urlencoded` body with `token` and `decision=approve` or `reject`, at most 4096 bytes; applies the decision and returns branded HTML at the token-free form action URL. |
| `POST /api/auth/password` | Authenticated `{current_password,new_password}`; `200 {"status":"ok"}`; retains the current session and revokes all others. |
| `POST /api/auth/forgot` | `{email}`; identical `202 {"status":"accepted"}` for active, absent and disabled accounts when mail is configured. |
| `GET /api/auth/me` | Existing `user` and `roles`, plus top-level boolean `password_change_required`. |

Invalid email syntax returns `400 VALIDATION_ERROR`. Request and forgot use
separate instances of the existing limiter: ten attempts per socket IP and
normalized email per fifteen minutes. Password change has its own instance,
keyed by socket IP and user ID, shared across that user's sessions. Limits return
`429 RATE_LIMITED` with `Retry-After`. Counters are in memory, per server instance;
restart clears them and forwarded IP headers are not trusted.

A request creates one pending row and emails the owner one **Review request**
link containing only the decision token, with no `decision` parameter. Opening
the link performs only a lookup: no row updates, user creation or email delivery.
The page uses inline CSS, shows the applicant email and the request timestamp
(explicit UTC), and contains a `method="post"` form targeting
`/api/auth/request/decide`. A hidden `token` field and two submit buttons named
`decision` (`approve` / `reject`, labeled Approva / Rifiuta) carry the choice in
the body. The result page contains no token and the form action has no query
string. Tokens contain 32
cryptographically random bytes encoded as base64url. Only the SHA-256 hex digest
is stored; application code additionally compares digests in constant time.
A review or decision requires a pending row requested less than 72 hours ago.
Missing, unknown, malformed, expired and consumed tokens return the same HTML
`410` page and message on GET and POST. An invalid POST decision returns HTML
`400`; a wrong or missing Content-Type or a body exceeding 4096 bytes returns
JSON `400 INVALID_FORM`. POST revalidates the token within the existing decision
transaction; the conditional update elects only one concurrent decision.
After success, subsequent GETs and POSTs return `410`.
The retained digest is unusable after the status changes; it is not an active
credential. Pages use no remote assets, `no-store`, `no-referrer` and a restrictive
CSP (`default-src 'none'; style-src 'unsafe-inline'; form-action 'self';
frame-ancestors 'none'; base-uri 'none'`). These headers apply to both GET and
POST, including HTML and JSON errors. Request URLs, tokens and transport errors
are never logged by the handler.

Approval creates an active user with a scrypt password hash and
`password_change_required=true`, then emails the temporary password. A temporary
password contains 16 random characters from `A-HJ-NP-Za-km-z2-9`, selected with
`crypto.randomInt`. The initial display name is the normalized email, since the
request contains no name. No site memberships or owner privileges are granted.
Existing owner membership management can explicitly assign site access.
Rejection creates no user and sends no applicant email.

Repeated requests for existing identities (including disabled ones) or a pending
request do nothing: no row and no mail. A partial unique index also protects
pending-email deduplication across concurrent requests. An expired pending request
remains pending and is still deduplicated; no automatic renewal, cleanup or
reactivation workflow is introduced. A rejected request may be requested again.
Approval refuses to overwrite an identity provisioned after the request.

Password change verifies the current scrypt password, requires a different new
password of at least 12 Unicode characters (maximum 1024 UTF-16 code units, as in
the login input limit), clears the flag and revokes other sessions atomically.
A wrong current password returns `401 INVALID_CREDENTIALS`; policy errors return
400. The browser keeps the current session on this credential error, but clears
it on `AUTH_REQUIRED`. A reset replaces the password, sets the flag and revokes
all sessions before mailing the new temporary password. Disabled accounts are
never modified or emailed. Password writers lock the user row and password
change rechecks session validity. Login rechecks the password hash under the
same lock before inserting a session, preventing a concurrent reset from being
undone by a login already verifying an older password.

The banner is non-blocking and appears even for users without site memberships.
Its existing modal form asks for current/new/confirmed password. The login page
also offers minimal request-access and forgot-password forms. All strings are
IT/EN; existing classes, CSS and logo are reused without a redesign.

## Schema and migration

Only `006_signup.sql` is added, in both dialects; migrations 001–005 and their
runner are unchanged. It adds `users.password_change_required BOOLEAN NOT NULL
DEFAULT false` and `signup_requests(id,email,decision_token_hash,
completion_token_hash,status,requested_at,decided_at)`, plus indexes for decision
hash lookup and email/status deduplication. PostgreSQL uses UUID and TIMESTAMPTZ;
SQLite uses TEXT IDs and UTC ISO timestamps. Existing users default to false;
existing passwords, sessions, memberships and task history are retained.

`completion_token_hash` is reserved and always NULL. The chosen flow delivers a
temporary password by email, so no completion token is generated and no endpoint
consumes one. The review link authorizes one request; only an explicit POST can
consume its decision token. Increment 6.1 changes no migration (001–006).

PostgreSQL 006 supports direct replay with `IF NOT EXISTS` guards. SQLite additive
DDL is replayed only via the migration ledger: call the existing runner again,
never execute its `ALTER TABLE` twice or remove a recorded ledger entry. Tests
upgrade populated databases, check the full 001–006 chain, replay twice and verify
constraints using SQLite and in-memory PGlite. PGlite is not a real PgStorage
integration test.

## Transactional mail and deployment configuration

All mail configuration comes from environment variables. The application reads
no secret files. Set these privately at deployment:

| Variable | Meaning |
| --- | --- |
| `SMTP_HOST` | Required SMTP hostname with a trusted TLS certificate. |
| `SMTP_PORT` | `587` (default, mandatory STARTTLS) or `465` (implicit TLS). Other ports are rejected. |
| `EMAIL` | Required SMTP login mailbox. |
| `EMAIL_PASSWORD` | Required SMTP credential. |
| `SMTP_FROM` | Envelope/header mailbox; defaults to `EMAIL`. Plain mailbox syntax, no display-name headers. |
| `OWNER_EMAIL` | Required in production: approval recipient, with no default. Keep the real address only in private environment configuration, never in the repository. |
| `PUBLIC_URL` | Public API base URL for decision links; defaults to the existing public API origin. Use the externally reachable HTTPS origin. |

Keep the existing production runtime/cookie/database settings. No new package
or secret-management mechanism is introduced. `sendMail({to,subject,html,text})`
uses `node:net`/`node:tls`, certificate verification, EHLO, AUTH PLAIN or LOGIN,
MIME multipart alternatives, a 15-second deadline, QUIT and socket cleanup.
Authentication is never attempted before TLS. SMTP replies and credentials are
not surfaced in errors or logs. Templates always include readable text and inline
HTML, with the local SVG embedded as base64 from an in-memory cache; missing logo
falls back to a text wordmark. No external stylesheet or image is loaded.

`createServer(db, {mailer})` accepts an async function receiving the full mail
object. Tests use an in-memory spy or scripted sockets; no test sends email.
The default SMTP function exposes `assertConfigured()` so even no-op request and
forgot calls return the same configuration error when mail is unavailable.
Missing/incomplete config yields `503 MAIL_NOT_CONFIGURED`.
Without `OWNER_EMAIL` (or with an empty/whitespace-only value), access requests
return `503 MAIL_NOT_CONFIGURED` before any database write or email delivery.
Delivery failures produce sanitized `503 MAIL_UNAVAILABLE`. Request, approval and
reset transactions roll back on mail errors, including user/password/session changes. Approval mail
errors use JSON 503 so the configuration code remains machine-readable; decision
successes and invalid/expired links use HTML.

SMTP and SQL cannot form one distributed transaction. Mail is sent before SQL
commit: a crash or failed commit after SMTP acceptance can deliver an unusable
password/link; a lost SMTP acknowledgement can also make delivery ambiguous.
No durable outbox/retry service is introduced. Do not claim exactly-once delivery.
A failed QUIT after a successful DATA acknowledgement does not roll back delivery.

## Security and acceptance

GET is deliberately read-only so email scanners and link prefetchers cannot
approve or reject requests merely by opening a URL, including legacy URLs with
`decision=approve`. The choice requires submitting the confirmation form via
POST. This prevents GET prefetch side effects; it is not proof of human presence
against automation that also submits forms. Treat the bearer links as secrets.
The edge proxy must allow the public decision route without a session
and redact its query string from access logs/traces. Application no-referrer and
no-store headers do not control proxy logs. Review existing edge authentication
for accessibility of the public signup/reset routes without altering site roles.

Temporary passwords travel through the recipient's mailbox. The password-change
flag is deliberately advisory; it does not block login or API access. Password
reset is unauthenticated and immediately revokes sessions, so the specified
per-IP/email rate limit is the current abuse bound. Accepted responses do not
enumerate accounts; SMTP delivery latency/failures are not a guarantee of
constant-time account concealment.

Before acceptance on real PostgreSQL, run the guarded `npm run test:pg` against
an isolated test database, verify populated upgrade and direct 006 replay,
UUID/TIMESTAMPTZ/BOOLEAN decoding, partial unique index enforcement, rollback and
concurrent requests/approve-vs-reject/password/reset/login across connections.
Also verify both SMTP TLS modes/auth mechanisms against a controlled mail sink,
real HTTPS cookies/CORS, proxy token redaction and the browser desktop/mobile
flow. No remote connection or deployment was performed in this increment.

## Workspace verification

- `npm test` was executed after increment 6.1 and failed. This Node runner reports
  the directory entry as one aggregate test; a direct `node tests/index.js` run
  exposed the detailed SQLite results: 176 tests, 157 passed, four
  PostgreSQL-only skips and 15 sandbox failures. Twelve failures are `listen
  EPERM` (two client HTTP tests and ten server tests); three are `spawnSync EPERM`
  in existing CLI tests. No other failures occurred.
- All fourteen signup/password/reset tests and six template/SMTP tests passed.
  The transport-spy prefetch test performs three consecutive GETs, including
  `decision=approve`, and checks unchanged request rows, `pending` status, no
  users, no additional mail and an unchanged SQLite `total_changes()` counter.
  Approval/rejection via POST, repeated decisions, identical HTML 410 responses,
  security headers, Content-Type validation and the 4096-byte limit also passed.
- `npm run test:schema`: nine passed, zero failed.
- `npm run test:pg` was not run: real PostgreSQL/socket integration is unavailable
  in this sandbox (`listen EPERM`), as specified for this task. No remote database
  configuration or connection was used.
- `node tests/browser.cjs` was attempted but could not start because Playwright
  is unavailable. Chromium is present. The updated review/form POST flow still needs
  execution in an environment supporting Playwright and local listening sockets.
- `git diff --check` passed. No commit, push, deployment or dependency change.
