# Proposed Ingestion Schema

`import-schema.sql` contains a generic SQL base, without real data, private header mappings, or account configurations. It is separate from the browser demo and is not applied automatically.

| Schema | Responsibility |
| --- | --- |
| `ingest` | Contexts, batches, files, raw rows, identity, and checks |
| `source_snapshot` | Typed tables for supported import families |
| `internal_work` | Annotations linked to record identity, separate from snapshots |
| `reporting` | Views of the latest import set declared complete |

The families are operational master data, planning, progress, daily logs, attendance, and deviations. Original rows are preserved even when identical to each other. Missing data remains distinct from a boolean false or a zero. Source dates without time zones remain local timestamps until explicitly converted.

For an empty development database, after reviewing the script:

```sh
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f database/import-schema.sql
```

`DATABASE_URL` must be provided privately by the environment. Do not run the command on a shared or production database without a reviewed migration. The script creates the schemas; it is not idempotent and does not modify the existing application schema.

## SQL Base Boundaries

This is an ingestion model, not a complete backend. Versioned migrations, authorizations, RLS if adopted, links to application organizations/users, loader, mapping profiles, conflict handling, enforcement of immutability, and server-side completeness checks remain to be implemented. Views use a completeness indicator that must be certified by the loader after checks; the flag does not perform these checks on its own.

Field names are canonical and generic. A versioned private profile must map source columns to canonical fields. Do not copy proprietary headers, organization labels, real reports, or manifests to reconstruct the public mapping. Some optional fields are contract extensions: their actual use depends on the confirmed profile.

## Local Verification

With Node.js 24:

```sh
npm ci
npm run test:schema
```

The test uses in-memory PostgreSQL WASM via PGlite and entirely synthetic fixtures. It verifies schema creation, relationships, uniqueness, context isolation, and preservation of multiple rows per day or duplicate rows. It does not require a remote service. The deployment PostgreSQL version must be verified separately, along with backup and restore.
