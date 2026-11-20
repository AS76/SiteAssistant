# SiteAssistant — first version

## Goal

Connect planning, work performed, verification and the site diary in a single experience usable from phone and desktop. Italian/English interface; user content in its original language.

## Flows implemented in the demo

| Area | Behavior | Verifiable criterion |
| --- | --- | --- |
| Sites | Creation with code, name, location and dates | Unique code, required name, end not before start |
| Context | Site selection and task filters | Dashboard, board, list and diary referring to the same site |
| Tasks | Title, area/asset, company, executor, verifier, priority and due date | Distinct executor and verifier; validated dates and fields |
| Statuses | To do → in progress → to verify → closed; blocking and reopening | Verification allowed only for the designated person, different from whoever declares execution; reason required for blocking, rejection and reopening |
| Evidence | Text note on completion and verification | No completion proposal or closure without a note |
| History | Author, date and reason for transitions | Reopening does not delete previous events |
| Diary | Operational date, day/night shift, optional task, plan, actuals, impediments and next step | One header per site/day; night-shift contributions explicitly refer to the selected day |
| Counts | To execute, to verify, closed and overdue | A completion proposal does not count as closure; a card to verify may be overdue |
| Portability | Filtered CSV, diary printing, JSON backup and restore | CSV formulas neutralized; restore with validation and confirmation; errors without deleting current data |
| Persistence | Server API + PostgreSQL (Neon); offline-first planned (increment 15) | Warning if saving fails; form text preserved after an error |

## Interface

Four sections: overview, sites, tasks and diary. Task detail shows acceptance criteria and timeline; the diary connects shift, task and result. Status expressed through text as well as color. Modals with labels, initial focus and keyboard dismissal. Filters do not change data and remain clear even without results.

## Boundaries

This version is a local demo, not a distributed enterprise system. All examples are synthetic. Selectable identities simulate roles, without providing authentication. Browser transition rules serve to discuss the process; they do not protect data from a user who controls the device.

## Next operational version

- Authentication, server authorization and organization/site isolation.
- Database, migrations, controlled concurrency, verified backups and restore.
- Private photos and attachments with limits and authorization.
- Submitted/closed diary and versioned corrections, server PDF export.
- Import with preview, mapping, source/revision and immutable snapshots; no reconstruction of history from current statuses alone.
- Authoritative milestone sources distinct from progress trackers.
- Offline and synchronization only after defining conflicts and cache protection.

Before operational release, agree on roles, diary model, volumes, hosting, data retention and integration needs.

## Direction of the multi-user version

Internal use complementary to a source system: importing exports, viewing authorized S3 files and local enrichment. Original snapshots and statuses remain separate from notes, actuals and internal verifications. No write synchronization with the source system is planned. API/MCP connectors and real profiles are to be verified; see [Import and document archive](import-storage.md).

First phase: tasks and coordination, quality/deviations, planning/progress and diary; documents, history and dashboards as shared services. Modules will be enabled per site, with logistics and engineering in later increments.

The **Planning, layouts and maps** area will receive Excel schedules and graphical documents: PDFs, high-resolution images and CAD originals. Gantt and other views share items updatable by percentage, installed quantity or yes/no action. Baseline, current plan, declared progress and verification remain distinct. CAD viewing/conversion is subject to compatibility and engine choice. See [Functional specification](planning-layouts.md); these features are not yet implemented.

The technical proposal uses relational PostgreSQL and server APIs; **Neon** is the managed database (`eu-central-1`) and the app runs on the Hostinger VPS behind Traefik. Files integrate through S3 compatibility (iDrive e2, `siteassistant` bucket). Authentication is local (email+password). Actual state and stack in [Architecture](architecture.md).
