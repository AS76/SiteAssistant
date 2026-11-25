# Architecture — SiteAssistant (current state)

Status: **full application implemented and running** (migrations 001–045 and 047; 046 reserved, does not exist yet). Actual stack verified; no framework, no ORM. Document aligned with the code on 2026-11-22.

## What it is

Webapp for the site manager: connects planning, work performed, verification and the site diary, usable from a phone in the field. Not an ERP: the layer between the plan (SAP/P6/Excel) and the site's daily reality.

**Current scope:** site-manager core (WBS, attendance, progress, deviations, time bookings, cost impacts), plus compliance (tools, certifications, HSE), procurement and materials logistics, versioned diary, granular per-module access, local auth with passkeys, S3 attachments and an optional server-side AI assistant per site (increment 47).

## Actual stack

| Layer | Actual technology | Notes |
| --- | --- | --- |
| Frontend | Static SPA in `app/` (native HTML/CSS/JS, no framework) | views: Overview, Sites, Tasks (board/list), Project structure (tree), Diary; IT/EN |
| Backend | **Node.js 24 + `node:http`** (no framework) | `server/http.mjs`, `repository.mjs`, domain modules |
| Data access | **Plain `pg`** + `Storage` abstraction (SQLite/pg drivers, PGlite in tests, no ORM) | explicit SQL queries, versioned migration pairs, including 050 for invitations on this branch |
| Database | **PostgreSQL (Neon, `eu-central-1`)** in production; **SQLite** in development/tests | same contract via `Storage` |
| Identity | **Local**: email+password (`scrypt`), `HttpOnly` cookie sessions, **WebAuthn passkeys** (035), site roles (owner/editor/verifier/viewer), **per-module access per member** (023), self-service signup with approval | no OIDC provider for now |
| Files | **iDrive e2 S3**, `siteassistant` bucket | hand-rolled SigV4 client (`node:crypto`), SHA-256 readback |
| Checks | Domain + integration tests (SQLite/PGlite and real pg), schema checks, browser regression | `npm test`, `npm run test:pg`, `npm run test:schema`, `npm run test:browser:c03` |

**Runtime dependencies: `pg` and `@simplewebauthn/server` only.** The backend deliberately has no framework/ORM.

## Flow

```mermaid
flowchart LR
    U[Browser: web interface] -->|HTTPS| A[API: node:http + pg]
    U -->|Login| A
    U -->|app shell + read cache| SW[Service Worker]
    U -->|write queue| IDB[(IndexedDB: queue + offline mirror)]
    IDB -->|Background Sync (network up)| A
    A --> P[(PostgreSQL / Neon)]
    A --> O[Object storage S3 iDrive e2]
```

The backend checks identity, site, role and module before every operation; DB and S3 credentials stay only on the server. The binding decision is made in the backend.

**Offline-first (increment 15, spec ready):** without a network the browser loads the app from the Service Worker cache, reads previously opened data and queues writes (tasks, diary, photos) in IndexedDB; when connectivity returns Background Sync replays the queue with idempotency (`Idempotency-Key`) and last-write-wins; transitions remain server-side.

## Invitations and first sign-in

Migration 050 adds `invitations` and `user_permissions` on SQLite and PostgreSQL. The migration starts with zero grants. A partial unique index permits one active grant per user and permission. Site membership continues to live in `site_members`. Invitation management routes check `invitations.manage` on each request. Site assignments require ownership at issuance and current ownership, an enabled account and the invitation permission at acceptance. Acceptance creates the user, any authorized membership, the session and the audit event in one transaction. The PWA shows an explicit no-site state in the profile language when the account has no memberships.

Server operators use `npm run admin -- grant invitations.manage <email>` or `npm run admin -- revoke invitations.manage <email>`. Repeating a command reports the resulting state and audits whether it changed. CLI audit records use `source: "cli"` and a null actor. A null `granted_by` denotes the trusted server operator.

The API commits the invitation before attempting mail. A second transaction claims delivery and increments the attempt counter. The existing mail transport runs outside these transactions. Successful delivery records `sent` and the time the transport accepted the message. A controlled failure records `failed` and a safe error code. Commands under `npm run invitations --` are `list`, `retry <id|email>`, `reissue <id|email>` and `revoke <id|email>`. Mail commands use the configured mail service and HTTPS `PUBLIC_URL`.

Each retry replaces the hash on the same failed invitation and preserves the expiry. A pending invitation may have been interrupted before sending or after provider acceptance. Check its status with `list`. Use `reissue` to atomically revoke the outstanding invitation and replace it with a new link and expiry. This manual recovery leaves at most one valid link even if an earlier email arrives. Configure any reverse proxy and request tracing to omit query strings or redact the token on `/attiva`, and omit activation request bodies. Activation pages set no-store and no-referrer headers.

## Authentication activity

The append-only `auth_events` table records `login.success`, `login.failure`, `logout`, `session.expired`, `activation.used`, `invitation.sent` and `invitation.used`. Password and passkey failures carry a reason class. An unidentified account has a null `user_id`. Rate-limited password attempts can reuse an account ID from a recent failure without querying the account. For invitation delivery the user is the sending administrator, when applicable. Sending from the server CLI has no HTTP metadata or authenticated actor. Invitation delivery is recorded when the mail transport accepts the message.

The server stores only the IPv4 `/24` network address or the IPv6 `/48` prefix in new authentication events and sessions. Each event stores a UTC timestamp and the User-Agent when available. Migration 052 adds the report index and the marker that lets the server record one expiry event when an expired session is presented. It leaves historical data intact. Authentication activity has a documented retention period of **180 days** and no automatic purge.

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

**Beyond the core (later increments):** tools (018), certifications (019), dashboard layouts (022), **granular per-module access per member (023)** — `logistics`, `workforce_names` and `workforce_presence` are *strict* modules, visible only when explicitly granted — HSE events/assets/inspections (024–031), audit trail (025–026), procurement and logistics: purchase orders, packages, shipments (032–034), WebAuthn passkeys (035), operational WBS (036–037), identity evidence (038), site time zone (040), **versioned diary (045)**, and the **optional server-side AI assistant per site** (increment 47, migration 047): read-only proxy to the model, site-scoped, key never reaches the browser.

**Current UI:** Overview (widgets configurable per user), Sites, Tasks (board, list, lightweight view), Project structure (WBS), Diary, Progress, Deviations (with reconciliation panel), Time bookings, Cost impacts, Equipment, Fitness for work, HSE, Printable report. The frontend also exposes the manual link and works offline for tasks and diary, with a write queue synchronized when the network returns.

## Operational-day rule

`operational_date` with a configurable cutoff (default 06:00, `Europe/Rome` time zone): operational day D runs from 06:00 on D to 05:59 on D+1; the night shift belongs to the day on which it started. Pure `operationalDate` function (Node `Intl`) + DST tests.

## Ingest

The importer accepts six families of planning exports — employees, attendance, work schedule,
progress items, deviations, daily log — mapped into `source_snapshot` and promoted to `app`
**idempotently** through explicit bindings (`wbs_import_sources`, `hr_import_sources`, …).

Identity: `source_uuid ↔ internal_id` via `ingest.entity_keys`; immutable imported rows; internal
annotations tied to persistent identity; reporting on the latest complete bundle.

The repository and the demo run on **synthetic data only**. The public import contract is described
in `planning-import.md`; site-specific mapping profiles are runtime configuration and are not part
of the repository.

## Hosting and deployment

- **Demo**: **Railway** (app + PostgreSQL in the same project), served on the provider's own hostname. DNS for the custom domain is not switched yet: it still points to the VPS.
- **Backend (historical production)**: systemd `siteassistant-api` on the VPS, behind Traefik on a `api.<domain>` host. Restart = migrations applied to Neon.
- **Database**: **Neon** (`eu-central-1`), TLS, for the VPS production; the Railway demo uses its own PostgreSQL; local PostgreSQL only for tests (`test:pg`).
- **Frontend**: nginx container, `<domain>` host with basic auth.
- **Files**: iDrive e2 S3, `siteassistant` bucket (dedicated `S3_*` env, not the backup bucket).
- **Manual**: `docs-site/` (Astro+Starlight) → GitHub Pages (`as76.github.io/SiteAssistant`), rebuilt and published by the docs workflow on every change to `main`; the content itself is edited by hand.
- **CI**: four workflows — `ci.yml` (jobs: SQLite/PGlite, real PostgreSQL, browser C03), `content-scan.yml`, `docs-freshness.yml` (weekly), `docs.yml`. All three `ci.yml` jobs must be green; the C03 fixture grants `workforce_names` explicitly to the roles that need named hours, and the viewer asserts the 403 denial.

Development/staging/production have separate databases, credentials and buckets. Only synthetic data in the public repo.

## Known limits

- **Verification of a task created with only a name.** A task without `executor_id`/`verifier_id`
  can be verified **only by an owner**: the typed name is not an identity, so it cannot
  authorize anyone. The interface allows members to be selected to avoid this case; for
  subcontractors without an account the name remains the only option, and verification goes through the owner.
- **Deviations reconciliation is read-only.** It compares the official dates
  (`closed_without_date`, `close_before_approval`); status changes keep an append-only
  history with provenance, they do not rewrite imported state.
- **No real ingest.** Import uses manually uploaded exports, not a connection to the
  planning system.

## Next steps

1. **Real ingest** (#5) and, afterwards, reporting views (#6) and area scope (#48).
2. **UX review** of mobile/desktop flows (#7) after the first weeks of use.
3. Logistics/procurement (#30): implemented (032–034); mobile UX review and real ingest remain open.
4. Corporate access: possible OIDC/SAML SSO, not a second OAuth provider (#1 closed).

Scope decisions remain documented in the vault (blueprint/kanban), not here.
