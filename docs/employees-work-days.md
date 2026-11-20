# Employees and Work Days

Increment 10 adds two read-only application projections and their APIs. Employees are site records, distinct from `users` accounts. No manual attendance changes or writes to the source are planned.

## Schema and configuration

`server/migrations/{pg,sqlite}/009_employees_workdays.sql` creates `employees`, `work_days`, the `(site_id, employee_id, operational_date)` index and `hr_import_sources`. Like the other migrations, it uses the application schema selected by the PostgreSQL connection and the main tables in SQLite. It does not change previous migrations and has not been applied to an operational database.

Trusted configuration `hr_import_sources(site_id, scope_id, run_id)` explicitly associates a site with the run to promote. It is independent of WBS configuration; it is neither inferred from names nor accepted from the HTTP body. Ingestion and provisioning of this association remain external prerequisites. PostgreSQL requires the schemas defined by `database/import-schema.sql`; SQLite requires prepared ingestion databases attached as `ingest` and `source_snapshot` on the same connection, as for WBS.

Import accepts a `ready` run with `completeness_verified`, both `employees` and `work_days` batches in `typed` status, consistent scopes and counts equal to `expected_rows`. Missing, duplicate or unreconciled identities block the entire promotion. Raw tables and snapshots are not changed.

## Identity and source values

- `employee_no` is unique per site. The application ID depends on the site and employee number; `source_entity_key_id` keeps the reference to the ingestion identity.
- Work days have deterministic IDs based on site, scope and `source_uuid`. `employee_no` is resolved exclusively in the selected Employees snapshot. A number absent from the snapshot requires reconciliation; a null source number leaves `employee_id` null.
- `operational_date`, `hire_date`, `expire_date`, `start_time` and `finish_time` preserve the source calendar values. APIs return dates and times without time-zone conversion; times retain available seconds and fractions. A missing operational date prevents import.
- `shift` uses `shiftOf` with day start 06:00 and night start 18:00, on the source time alone. The technical UTC anchor serves to classify the time without converting it and does not determine the operational date. A null `start_time` produces a null `shift`. A pair crossing midnight remains unchanged.
- `work_time_source`, `open_hours_source` and `booked_hours_source` feed `work_time`, `open_hours` and `booked_hours` respectively. Semantics TBD: no duration calculation, total, normalization or additional interpretation. Null, zero and source status remain distinct.

Promotion is transactional and serialized per site. Repeating the same run and batches returns `unchanged: true` with zero counts, retaining IDs and timestamps. A new run replaces the current projection, retaining IDs and `created_at` for identities still present. History remains in the ingestion snapshots; completed runs are treated as immutable and corrections require a new run.

## API

| Route | Result | Access |
| --- | --- | --- |
| `GET /api/employees?site_id=…` | Array ordered by `employee_no` | Site membership, including viewer |
| `GET /api/employees/:id` | Employee with `work_days` array | Membership of the employee's site |
| `GET /api/work-days?site_id=…&employee_id=…&from=…&to=…` | Array ordered by date and ID; optional filters, inclusive `YYYY-MM-DD` bounds | Site membership |
| `POST /api/employees/import` | Body `{ "site_id": "UUID sintetico del cantiere" }`; result `{ employees, work_days, unchanged, run_id }` | Site owner |

The current administrative role is `owner`: there is no distinct `admin` role. Import also checks permissions in the repository. Internal repository reads are trusted; routes require a session and membership. No editing endpoints are exposed.

Configuration or source errors return `409` with code `HR_SOURCE_NOT_CONFIGURED`, `HR_SOURCE_UNAVAILABLE`, `HR_RUN_NOT_READY`, `HR_INCOMPLETE_SNAPSHOT` or `HR_RECONCILIATION_REQUIRED`, without changing the previous projection. Invalid filters return `400`.

## Checks and activation

`tests/hr.test.mjs`, registered in `tests/index.js`, verifies migrations and promotion on SQLite and in-memory PostgreSQL with synthetic fixtures, including filters, permissions through an HTTP listener, rollback, new runs and idempotency. `npm run test:schema` separately verifies the ingestion contract. Existing HTTP tests with sockets remain in the runner and may require the host outside the sandbox.

This increment adds no UI, remote services, deployment or file import. No service was activated.
