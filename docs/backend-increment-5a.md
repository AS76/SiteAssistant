# Backend increment 5a

Implemented locally: physical application types and task workflow extensions.
No authentication, users, cookies, identity seed, external service or deployment
is introduced. Actors remain caller-supplied, untrusted demonstration labels.
This document supersedes the workflow/event details of increment 1.

## Migration 004

Both drivers follow 001 → 002 → 003 → 004. Earlier migrations are unchanged.
PostgreSQL converts application IDs and their foreign keys to UUID and application
timestamps to timestamptz using explicit casts. Foreign key names and definitions
are captured, dropped and restored within the same atomic migration. Existing
status checks, integer generated-always event IDs and the entire idempotency table
remain unchanged. Type/column guards permit direct replay of the PostgreSQL SQL.
The pg pool normalizes timestamptz to UTC ISO strings, including transaction reads.
Unknown/malformed UUID resource lookups retain the previous 404/empty-list behavior.

SQLite retains TEXT types and only adds the three nullable columns; no tables are
rebuilt. SQLite does not support conditional ADD COLUMN in standalone SQL. Manual
replay must therefore use the exported helper, which checks PRAGMA table_info,
inside a transaction (the runner uses the same helper):

```js
import { applyMigration } from './server/migrations/index.mjs';
await db.transaction(tx => applyMigration(tx, '004_physical_types.sql', { driver: 'sqlite' }));
```

Replaying the raw SQLite file directly in a SQL shell is not idempotent. The helper
does not consult schema_migrations, so it also supports a partial additive replay.
Existing rows and historical events are preserved; new metadata is NULL and is
not inferred retrospectively. Legacy blocked tasks without blocked_from cannot
resume until their origin is explicitly reconciled. Invalid pre-existing UUID or
timestamp values abort the PostgreSQL migration rather than being rewritten.
No production migration has been applied by this increment.

## Workflow and HTTP compatibility

The endpoint and required payload remain `{to, actor, note?, reason?}`. The server
derives event action from the current/target states:

| From | To | Action | Conditions |
| --- | --- | --- | --- |
| todo | in_progress | start | Explicit actor |
| in_progress | to_verify | submit | Nonempty note; stores submitted_by = actor |
| to_verify | closed | verify | Nonempty note; designated verifier |
| to_verify | in_progress | reject | Nonempty note; actor differs from submitted_by |
| todo / in_progress / to_verify | blocked | block | Nonempty reason; saves origin |
| blocked | saved origin | resume | Valid open origin; clears blocked_from |
| closed | in_progress | reopen | Nonempty reason; designated verifier or literal actor `owner` |

`owner` is a simulated label, not an authenticated role. Resume preserves the
original submitted_by, including when returning to to_verify; a new submission
replaces it. It otherwise remains as historical metadata after reject/reopen.
Closure is only allowed from to_verify; its action is always `verify`. The SQL
action check also admits `close`, but the existing target-state API does not
distinguish a separate close command. No action field is required in requests.
Disallowed edges, self-rejection and unauthorized reopening return 409
INVALID_TRANSITION. Existing NOTE_REQUIRED, REASON_REQUIRED and VERIFIER_REQUIRED
responses retain their previous status codes.

Creation writes one `create` event, todo → todo, in the same transaction as the
task. Its timestamp equals created_at; note/reason are empty strings. The actor
is optional on creation and defaults to executor for existing clients. Existing
transactions used by seed/idempotent POST are reused. Old events are not backfilled.
Clients now receive the creation event in addition to transition history.

Tests cover upgrade of populated SQLite/PGlite databases, independent migration
replay, FK and CHECK preservation, workflow rollback and HTTP listeners without
sockets. The pg-only suite additionally checks physical types and string values
through PgStorage. PostgreSQL server verification remains a separate reviewer run
with `npm run test:pg`; PGlite does not substitute for that driver verification.
