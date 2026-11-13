# Cost impacts — increment 14

Backend module implemented, without a dedicated UI or activated external services. The
`013_cost_impacts.sql` migrations for PostgreSQL and SQLite add writable internal
claims and their links to deviations. They are not an
export family and do not change imported statuses. No production migration was
applied by this increment.

In PostgreSQL the tables use the schema selected by the connection (`app` by
default), like previous migrations.

## API

All endpoints require an authenticated session and site membership.

| Endpoint | Roles | Behavior |
| --- | --- | --- |
| `GET /api/cost-impacts?site_id=<uuid>&status=open` | All members | `site_id` required; `status` optional; ordered by creation and ID |
| `GET /api/cost-impacts/:id` | All members | Claim with a `deviations` array of linked records |
| `POST /api/cost-impacts` | Editor, verifier, owner | Creates a claim in `open`, returns 201 |
| `POST /api/cost-impacts/:id/transition` | Verifier, owner | Applies a transition, returns 200 |

Creation with synthetic data:

```json
{
  "site_id": "11111111-1111-4111-8111-111111111111",
  "title": "Synthetic claim",
  "deviation_ids": ["22222222-2222-4222-8222-222222222222"],
  "claim_amount": "1234.50"
}
```

The title cannot be empty. At least one existing deviation from the same
site is required; repeated IDs identify a single link. Creation and links
are atomic. Author and creation timestamp come from the server.

Allowed transitions: `open → notification_sent → submitted → closed` and
`open → closed`. `closed` is terminal. Closure requires a `result` from
`settled`, `dropped`, `rejected` and sets `closed_at` on the server. The result is not
allowed on other transitions. Closure example:

```json
{ "to": "closed", "result": "settled", "settlement_amount": "1000.25" }
```

`claim_amount` and `settlement_amount` are optional, both on creation and
in transitions. A transition preserves omitted amounts; `null` sets them
to NULL. Finite numbers and decimal strings are accepted, without currency
conversion, implicit sums or currency inference. PostgreSQL preserves NUMERIC and
returns amounts as strings, avoiding conversion to Number in the module;
SQLite uses its own NUMERIC affinity and may round high-precision values.

Main errors: 400 for invalid input or missing outcome, 401 without a session,
403 for insufficient role/membership, 404 for absent records, 409 for deviations
from another site or disallowed transitions/concurrent conflicts. Direct
module reads are internal; the HTTP layer applies read authorization,
while write functions check the user and role directly.

## Checks

`tests/cost-impacts.test.mjs`, included in `tests/index.js`, verifies creation,
filters, details, all state pairs, closure outcomes, roles, membership,
rollback, concurrent closures, SQL constraints and migration replay. It runs the
same cases on SQLite and PostgreSQL through PGlite; with `DB_DRIVER=pg` it instead uses
the PostgreSQL test database configured according to the existing safeguards.

Commands: `npm test` and `npm run test:schema`.
