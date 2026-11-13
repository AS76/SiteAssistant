# Architecture — SiteAssistant (current state)

Status: **site-manager core implemented and in production** (migrations 001–013). Actual stack verified; no framework, no ORM. Document aligned with the code on 2026-11-10.

## What it is

Webapp for the site manager: connects planning, work performed, verification and the site diary, usable from a phone in the field. Not an ERP: the layer between the plan (SAP/P6/Excel) and the site's daily reality.

**Current scope (site-manager core):** WBS, attendance, progress, deviations, time bookings, cost impacts. **Materials logistics and procurement = next milestone.**

## Actual stack

| Layer | Actual technology | Notes |
| --- | --- | --- |
| Frontend | Static SPA in `app/` (native HTML/CSS/JS, no framework) | views: Overview, Sites, Tasks (board/list), Project structure (tree), Diary; IT/EN |
| Backend | **Node.js 24 + `node:http`** (no framework) | `server/http.mjs`, `repository.mjs`, domain modules |
| Data access | **Plain `pg`** (only runtime dependency, no ORM) + `Storage` abstraction (SQLite/pg drivers) | explicit SQL queries, versioned migrations |
| Database | **PostgreSQL (Neon, `eu-central-1`)** in production; **SQLite** in development/tests | same contract via `Storage` |
| Identity | **Local**: email+password (`scrypt`), `HttpOnly` cookie sessions, site roles (owner/editor/verifier/viewer), self-service signup with approval | no OIDC provider for now |
| Files | **iDrive e2 S3**, `siteassistant` bucket | hand-rolled SigV4 client (`node:crypto`), SHA-256 readback |
| Checks | Domain + integration tests (SQLite and pg) + parity | `npm test`, `npm run test:pg`, `npm run test:schema` |

**No runtime dependency beyond `pg`.** The backend deliberately has no framework/ORM.

## Flow

```mermaid
flowchart LR
    U[Browser: interfaccia web] -->|HTTPS| A[API: node:http + pg]
    U -->|Login| A
    U -->|app shell + cache letture| SW[Service Worker]
    U -->|coda scritture| IDB[(IndexedDB: coda + mirror offline)]
    IDB -->|Background Sync (rete ok)| A
    A --> P[(PostgreSQL / Neon)]
    A --> O[Object storage S3 iDrive e2]
```

The backend checks identity, site, role and module before every operation; DB and S3 credentials stay only on the server. The binding decision is made in the backend.

**Offline-first (increment 15, spec ready):** without a network the browser loads the app from the Service Worker cache, reads previously opened data and queues writes (tasks, diary, photos) in IndexedDB; when connectivity returns Background Sync replays the queue with idempotency (`Idempotency-Key`) and last-write-wins; transitions remain server-side.

## Implemented modules (core)

| Module | App table | Migration | Status |
| --- | --- | --- | --- |
| Sites | `sites` | 001 | ✅ UI |
| Tasks (state machine) | `tasks`, `task_events` | 001, 004 | ✅ UI (board/list) |
| Diary (operational day) | `diary` | 001, 002 | ✅ UI |
| Authentication | `users`, `sessions`, `site_members` | 005 | ✅ UI (login) |
| Self-service signup | `signup_requests` | 006 | ✅ API |
| Attachments | `attachments` | 007 | ✅ API |
| WBS | `project_structure` | 008 | ✅ UI (tree) |
| Attendance | `employees`, `work_days` | 009 | ✅ API |
| Progress | `site_progress_items` | 010 | ✅ UI (bars, weighted steps, planned hours) |
| Deviations | `deviations`, `deviation_links` | 011 | ✅ UI (board, detail, reconciliation) |
| Time bookings | `time_bookings` | 012 | ✅ UI (source and app hours, variance) |
| Cost impacts | `cost_impacts`, `cost_impact_deviations` | 013 | ✅ UI |

**Current UI:** Overview (widgets configurable per user), Sites, Tasks (board, list, lightweight view), Project structure (WBS), Diary, Progress, Deviations (with reconciliation panel), Time bookings, Cost impacts, Equipment, Fitness for work, HSE, Printable report. The frontend also exposes the manual link and works offline for tasks and diary, with a write queue synchronized when the network returns.

## Operational-day rule

`operational_date` with a configurable cutoff (default 06:00, `Europe/Rome` time zone): operational day D runs from 06:00 on D to 05:59 on D+1; the night shift belongs to the day on which it started. Pure `operationalDate` function (Node `Intl`) + DST tests.

## Ingest

The importer accepts six families of planning exports — employees, attendance, work schedule,
progress items, deviations, daily log — mapped into `source_snapshot` and promoted to `app`
**idempotently** through explicit bindings (`wbs_import_sources`, `hr_import_sources`, …).

Identity: `source_uuid ↔ internal_id` via `ingest.entity_keys`; immutable imported rows; internal
annotations tied to persistent identity; reporting on the latest complete bundle.

The repository and the demo run on **synthetic data only**. Real planning exports, when they were
used to design the import contract, were processed outside this repository and are not part of it.

## Hosting and deployment

- **Backend**: systemd `siteassistant-api` on the Hostinger VPS, behind Traefik (`api.siteassistant.asassi.cloud`). Restart = migrations applied to Neon.
- **Database**: **Neon** (`eu-central-1`), TLS; local PostgreSQL 18 only for tests (`test:pg`).
- **Frontend**: nginx (`siteassistant-demo` container), `siteassistant.asassi.cloud` with basic auth.
- **Files**: iDrive e2 S3, `siteassistant` bucket (dedicated `S3_*` env, not the backup bucket).
- **Manual**: `docs-site/` (Astro+Starlight) → GitHub Pages (`as76.github.io/SiteAssistant`), updated automatically by the docs job.

Development/staging/production have separate databases, credentials and buckets. Only synthetic data in the public repo.

## Known limits

- **Verification of a task created with only a name.** A task without `executor_id`/`verifier_id`
  can be verified **only by an owner**: the typed name is not an identity, so it cannot
  authorize anyone. The interface allows members to be selected to avoid this case; for
  subcontractors without an account the name remains the only option, and verification goes through the owner.
- **Deviations without status history.** They are an import projection: there is no
  internal status-change path, so reconciliation compares only the official dates
  (`closed_without_date`, `close_before_approval`).
- **No real ingest.** Import uses manually uploaded exports, not a connection to the
  planning system.

## Next steps

1. **Real ingest** (#5) and, afterwards, reporting views (#6) and area scope (#48).
2. **UX review** of mobile/desktop flows (#7) after the first weeks of use.
3. Logistics/procurement (#30) = next milestone.
4. Corporate access: possible OIDC/SAML SSO, not a second OAuth provider (#1 closed).

Scope decisions remain documented in the vault (blueprint/kanban), not here.
