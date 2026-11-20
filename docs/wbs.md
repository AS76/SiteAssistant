# Project Structure (WBS)

Increment 9 introduces a read-only application projection of Time Schedule, APIs and an expandable/collapsible tree view with an IT/EN flat table. It does not enable editing, writes to the source system or automatic synchronization. Displayed progress is imported progress, neither an internal verification nor a calculated aggregate value.

## Migration and source

`server/migrations/{pg,sqlite}/008_wbs.sql` creates `project_structure`, parent/sort indexes and `wbs_import_sources`. Migrations 001–007 remain unchanged. The migration is discovered by the existing runner; it has not been applied to an operational database and does not activate services.

Ingestion remains a separate prerequisite: the PostgreSQL contract is in `database/import-schema.sql`, not in application migrations. `008` neither creates nor populates ingestion schemas. For SQLite the caller must attach two prepared databases with `ATTACH DATABASE ? AS ingest` and `ATTACH DATABASE ? AS source_snapshot` on the same connection before serving imports. In-memory fixtures reproduce exclusively synthetic data; they do not constitute a file importer.

Trusted configuration `wbs_import_sources(site_id, scope_id, run_id)` explicitly associates the site with the run to promote. It is not inferred from names/codes and cannot be changed by the HTTP body. Provisioning this association and file ingestion are external to this increment. For a new snapshot, update `run_id` while keeping the correct scope, then invoke import. We do not implicitly select a global run or the latest available one.

Import accepts only a `ready` run with `completeness_verified`, its `time_schedule` batch in `typed` status and a row count equal to `expected_rows`. Scope, run, batch and identities are verified together. No snapshot or raw data is changed.

## Identity and hierarchy

- Source node IDs depend deterministically on site, scope and `source_uuid`; `source_entity_key_id` preserves the reference to the ingestion identity. Missing or unreconciled identities prevent promotion.
- The prefix of a dotted code, for example `2.3` for `2.3.1`, identifies the parent in the same `project_plan`. Opaque codes without a reconstructable prefix remain roots, even with a level greater than zero. Order alone does not prove parentage.
- An absent parent becomes a synthetic node with a derived code and the immediately preceding level; ancestors are reconstructed recursively up to level zero. Description, dates, hours, progress, flags, order and source references remain null. No weights are invented.
- Each link requires `parent.level + 1 = child.level`, so it cannot form cycles. Incompatible levels yield `409 WBS_RECONCILIATION_REQUIRED`.
- Duplicate codes remain distinct nodes if they have different UUIDs. If a duplicate makes a parent ambiguous within the same plan, the entire promotion fails with `409 WBS_AMBIGUOUS_PARENT`. Different plans remain separate during reconstruction.
- Lists and siblings are ordered by level, order (nulls last), code and ID. The UI explicitly indicates synthetic parents and absent values.

Promotion is atomic and serialized per site. Repeating the same run/batch returns `unchanged: true` without changing nodes or timestamps. A new run replaces the current projection, preserves IDs and `created_at` of identities still present, removes nodes no longer present and may replace synthetic parents with source ones. Historical snapshots remain in ingestion. Completed runs and batches are treated as immutable: corrections require a new run.

The four source dates without offsets are converted using only explicit `import_runs.source_timezone`. A missing/invalid time zone or an ambiguous/nonexistent local time prevents promotion; neither UTC nor the machine's time zone is assumed. Dates already carrying an offset are normalized to UTC. Null, zero and unknown flags remain distinct. Original values remain in snapshots; PostgreSQL timestamp serialization follows the existing driver contract.

## API and permissions

| Operation | Contract | Permissions |
| --- | --- | --- |
| `GET /api/wbs?site_id=…` | Array of roots, each node with `children` | Site membership, including viewer |
| `GET /api/wbs?site_id=…&flat=1` | Complete array with `parent_id`, `level`, `sort_order` | Site membership |
| `GET /api/wbs/:id` | Node with immediate children in `children` | Membership of the node's site |
| `POST /api/wbs/import` | Body `{ "site_id": "UUID sintetico del cantiere" }`; result `{ imported, synthetic, unchanged, run_id }` | Site owner |

The current model has no distinct `admin` role: the site administrator is `owner`. An owner of another site is not authorized. All routes require a session. The repository checks import permissions independently; as with the other repositories, internal reads are trusted and routes apply membership checks.

Configuration/source-not-ready errors return `409` with a specific code (`WBS_SOURCE_NOT_CONFIGURED`, `WBS_SOURCE_UNAVAILABLE`, `WBS_RUN_NOT_READY`, `WBS_INCOMPLETE_SNAPSHOT`); they do not change the previous projection. The UI is for viewing and exposes no import or editing controls.

## Checks

`npm test` includes `tests/wbs.test.mjs` through `tests/index.js`: in-memory SQLite/PostgreSQL migrations, synthetic snapshots, absence of cycles, null/zero, duplicates, separate plans, idempotency, new runs, rollback and authorization through the real HTTP listener. `npm run test:schema` verifies the PostgreSQL ingestion contract. `node tests/browser.cjs` includes tree, expand/collapse, table, site switching, network errors and mobile viewport; requires Playwright and Chromium already available. Socket tests may require execution outside the sandbox.
