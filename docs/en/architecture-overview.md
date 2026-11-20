# SiteAssistant — Architectural Overview

## 1. System Topology

SiteAssistant follows a decoupled multi-tier architecture composed of:
1. **Static Frontend (`app/`):** A lightweight, responsive single-page client built with modern semantic HTML5, pure CSS, and native ES Modules (ESM). It requires no Node.js runtime to serve static assets.
2. **REST API Backend (`server/`):** A lightweight Node.js (Node 24) HTTP service avoiding heavy framework overhead, utilizing native URL routing, transactional validation, and asynchronous database adapters.
3. **Relational Database (`database/` & `server/storage/`):** A dual-driver persistence layer supporting:
   - **PostgreSQL (Primary & Production Target):** Self-hosted PostgreSQL instance (PostgreSQL 18 cluster) utilizing a dedicated application schema (`app`), rigorous foreign keys, check constraints, and transactional consistency.
   - **SQLite (Local Development & Fast Testing):** Driver powered by Node's built-in `node:sqlite` (`DatabaseSync`), requiring zero third-party dependencies for development.

---

## 2. Repository Module Structure

Source tree organization reflects clear domain boundaries:

```text
SiteAssistant/
├── app/                  # Static web application (UI)
│   ├── index.html        # HTML shell and API base URL configuration
│   ├── app.mjs           # UI controller, state coordination, and DOM rendering
│   ├── domain.mjs        # Pure domain logic, validation rules, and transitions
│   ├── api.mjs           # HTTP API client communicating with the backend
│   ├── i18n.mjs          # Dynamic bilingual dictionary (EN / IT)
│   └── styles.css        # Responsive styling, board layout, and print media rules
├── server/               # REST API Backend
│   ├── index.mjs         # HTTP server entrypoint and pool lifecycle management
│   ├── http.mjs          # Router, JSON body parsing, CORS policies, error handling
│   ├── repository.mjs    # Business validations, SQL execution, and transactions
│   ├── db.mjs            # Storage factory and idempotent schema DDL
│   ├── seed.mjs          # Atomic initial seed inserting synthetic test data
│   └── storage/          # Storage abstraction layer
│       ├── index.mjs     # Abstract Storage interface definition
│       ├── pg.mjs        # PostgreSQL asynchronous driver (pg.Pool)
│       └── sqlite.mjs    # Native SQLite driver (node:sqlite DatabaseSync)
├── database/             # Ingestion schemas and data contract specs
│   ├── import-schema.sql # DDL for ingest, source_snapshot, internal_work, reporting
│   └── README.md         # Documentation for the ingestion data model
└── tests/                # Automated testing test suite
    ├── api.test.mjs      # API client contract and round-trip integration tests
    ├── browser.cjs       # End-to-end browser workflow testing (Playwright)
    ├── domain.test.mjs   # Pure client domain and validation unit tests
    ├── helpers/          # Test helpers and database test fixtures
    ├── index.js          # Test runner entrypoint (`node --test tests/`)
    ├── parity.test.mjs   # Cross-driver parity tests (SQLite vs PostgreSQL)
    ├── pg-storage.test.mjs # PostgreSQL driver and connection pool tests
    ├── repository.test.mjs # Repository isolation, concurrency, and rollback tests
    ├── schema.test.mjs   # Ingestion schema verification using in-memory PGlite WASM
    └── server.test.mjs   # HTTP API integration and route testing
```

---

## 3. Core Architectural Decisions

All architectural choices in SiteAssistant follow verified code structures and operational requirements:

### 3.1 Storage Abstraction and Cross-Driver Parity
- All database operations route through the unified `Storage` base class (`server/storage/index.mjs`), which enforces uniform behavior for `get`, `all`, `run`, `exec`, `transaction`, and `isUniqueViolation`.
- **JSON Type Parity:** To ensure JSON payload serialization is 100% identical between SQLite and PostgreSQL, `task_events.id` is defined as `INTEGER GENERATED ALWAYS AS IDENTITY` (an `int4`). This ensures `node-postgres` parses the identifier as a JavaScript integer rather than converting it to a string (which occurs with `BIGINT`/`int8`).
- Unique violations are captured across engines by checking PostgreSQL `23505` and SQLite `2067`.

### 3.2 Immutability of Ingestion Records (Raw & Snapshot)
- As specified in `database/import-schema.sql`, all incoming third-party schedule and attendance files are treated as append-only data.
- The raw source row is preserved intact in `ingest.raw_rows` as a `JSONB` document alongside a cryptographic row fingerprint (`content_sha256`).
- Tables in `source_snapshot` never undergo `UPDATE` or `DELETE` operations; subsequent extractions create new batches.
- Operational annotations and links live in `internal_work` linked by stable keys (`entity_keys`), guaranteeing internal records survive repeated external imports without key breakage.

### 3.3 Operational Day Convention (06:00 Cutoff)
- On construction sites, daily operations span across midnight shifts; calendar days do not represent physical work boundaries.
- **Formal Definition:** An operational day $D$ begins at `06:00:00` local time and ends at `05:59:59` on calendar day $D+1$.
- **Shift Attribution:**
  - Events logged between `00:00:00` and `05:59:59` belong to operational day $D-1$.
  - Night shifts (e.g., 22:00–06:00) are fully attributed to the operational day in which the shift commenced.
- The site diary stores records indexed by `(site_id, operational_date, shift)`, establishing unambiguous reporting keys.
- The architecture allows `day_cutoff_time` to be configured per site (defaulting to `06:00` Europe/Rome).

### 3.4 Decoupling Official External Statuses from Internal Site State
- SiteAssistant functions strictly as a **non-intrusive companion tool**: it does not attempt blind bidirectional sync back to primary corporate ERP or scheduling engines.
- External statuses from ERP or contractor schedules remain preserved within raw snapshots.
- Internal workflow states (`todo`, `in_progress`, `to_verify`, `closed`, `blocked`) reflect real, field-level inspection and execution progress on site.

### 3.5 Enforced Separation Between Executor and Verifier
- Both client validation (`app/domain.mjs`) and backend business logic (`server/repository.mjs`) require that `executor` and `verifier` be distinct individuals.
- Task closure (`to_verify` $\rightarrow$ `closed`) is rejected with a `409` conflict (`VERIFIER_REQUIRED`) unless executed by the designated verifier.
