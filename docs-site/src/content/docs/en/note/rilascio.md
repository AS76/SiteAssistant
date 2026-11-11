---
title: Product status
description: What is available today, what is missing and which limits to know before using it.
---

This page describes the currently published version. It is deliberately explicit about what does not exist, to avoid wrong expectations on site.

## Available in the interface

- Sign-in with email and password, sessions lasting 7 days.
- Self-service access request and password reset, with approval by an owner.
- Per-site roles: `owner`, `editor`, `verifier`, `viewer`.
- Site creation reserved to owners; unique code.
- Tasks with separate executor and reviewer, priority, due date, area and company.
- Status transitions with notes and reasons, full history.
- Separate review: whoever executes cannot close their own work.
- Diary per operational day and shift, with plan, actual results, blockers and next step.
- Photos and PDFs attached to tasks and diary entries, including drag and drop from the desktop, up to 15 MiB per file.
- **Project structure (WBS)** read-only view: tree and flat table.
- **Deviations**, **Site progress**, **Time bookings** and **Cost impacts** views.
- **Tools** view: a register by contractor, status and location, with create, edit and delete in the interface.
- Site progress with weighted step types: weights must total 100; completion is recorded in the application.
- Overview with four indicators, a deviations donut, progress by section and hours per week.
- planning export import from the interface, with preview and confirmation, for six data families.
- Read-only data assistant, with record citations.
- Settings for currency, decimals and separators on amounts.
- Sortable tables, optional column filters and cards on phones.
- Mobile navigation with a bottom bar.
- Desktop navigation grouped in **Operations**, **Site** and **Management**.
- Tasks and diary available offline; changes stay queued and are synchronised when the network returns.
- Overview, board, list with filters, CSV export, diary printing.
- Italian/English interface and responsive layout.

## Available only via API (not in the interface)

- Managing site members.
- Importing snapshots through dedicated endpoints (in addition to the planning import in the interface): WBS, attendance, progress and deviations.
- Creating and deleting progress types and their weights.
- **Cost impacts**: viewing and closing with a result are also available in the interface; creating an impact and updating amounts stay API only.
- **Site attachments** and **attachment deletion**: upload and removal stay API only.
- Resuming a blocked task and rejecting a submission (transitions not yet exposed in the app).

## Not available

- Editing or deleting sites, tasks and diary entries.
- Editing or deleting imported data: progress, deviations and attendance stay read-only.
- Acceptance criteria, long descriptions, checklists.
- Signatures in the interface.
- Notifications, calendar, planning and maps.
- Offline operation of the core module views (Deviations, Site progress, Time bookings, Cost impacts, Tools): they require a connection.
- Connectors to ERP, Primavera P6 or other systems.
- Server-generated PDF reports.

## Limits to know

- The completion evidence is a **text note**, not an attachment.
- The executor and reviewer are entered as **free-text names**, not linked to accounts.
- Site dates are descriptive: they do not prevent entries outside the range.
- Timezone and cutoff time are attributes of the individual diary entry; the interface uses the default values.
- Printing uses the browser: the appearance depends on the browser and the chosen margins.
- The language switch translates the interface, not the entered content.
- Attachments in the interface and via API are limited to **15 MiB** and to images and PDF only.
- The planning import does not delete rows missing from the file and cannot be undone from the interface.
- The currency in Settings changes the symbol and format, it does not convert amounts.
- The import preview is valid for 15 minutes: after that, it must be repeated.
- The data assistant reads the selected site's data and writes nothing; it requires a connection.
- The link between progress and WBS exists only with a unique match of PLC area and section: without a match the item stays unlinked.
- Tools have no history: edits and deletions are immediate, and a deletion leaves no copy of the row.
- Deviation statuses come from the source system; an unrecognised status stays empty instead of being interpreted.

:::caution[Data]
The current version is an operational demo with test data. Do not enter confidential information, credentials or contractual data.
:::

## How this documentation is updated

The pages live in the repository, under `docs-site/`, and are published automatically on every change to `main`. If a feature changes, the page describing it changes. The translated English pages are kept aligned with the Italian version.
