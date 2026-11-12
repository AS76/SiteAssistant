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
- Tasks with separate executor and reviewer, priority, due date, area, company and ordinary or corrective type; the **Light tasks** view closes and reopens ordinary ones with a single command.
- Status transitions with notes and reasons, full history.
- Separate review: whoever executes cannot close their own work.
- Diary per operational day and shift, with plan, actual results, blockers and next step.
- Photos and PDFs attached to tasks and diary entries, including drag and drop from the desktop, up to 15 MiB per file.
- **Project structure (WBS)** read-only view: tree and flat table.
- **Deviations**, **Site progress**, **Time bookings** and **Cost impacts** views.
- **Tools** view: a register by contractor, status and location, with create, edit and delete in the interface.
- **Fitness** view: employee qualifications, medical checks and training, with expiry, days left and a computed status; owners, editors and verifiers read it, owners and editors write.
- **HSE** view: a separate register of near misses, accidents and observations, with date, type, severity, location, a count of people involved and measures; no health data. Owners, editors and verifiers read it, owners and editors write.
- Site progress with weighted step types: weights must total 100; completion is recorded in the application. Each item has **planned hours** of its own or from the linked WBS node.
- **Earned value** on the Overview and in the report: EV, PV and AC in hours, with CPI and SPI, calculated from planned hours and booked hours.
- Overview with four indicators, a deviations donut, progress by section, hours per week and an earned value panel.
- planning export import from the interface, with preview and confirmation, for six data families and with per-site column mapping.
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
- Editing or deleting imported data: progress, deviations and attendance stay read-only, except the planned hours of progress items.
- Acceptance criteria, long descriptions, checklists.
- Signatures in the interface.
- Notifications, calendar, planning and maps.
- Offline operation of the core module views (Deviations, Site progress, Time bookings, Cost impacts, Tools, Fitness, HSE): they require a connection.
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
- The column mapping is per site and family: it is not inherited across sites and does not add fields to the model.
- The currency in Settings changes the symbol and format, it does not convert amounts.
- The import preview is valid for 15 minutes: after that, it must be repeated. Changing the file or the mapping invalidates it immediately.
- The data assistant reads the selected site's data and writes nothing; it requires a connection.
- The link between progress and WBS exists only with a unique match of PLC area and section: without a match the item stays unlinked.
- Deleting tools, certificates and HSE events is **logical**: the row disappears from the views, the counters and the details but stays in the audit register with author and date, readable through the API by owners and verifiers. Certifications stay restricted to owners, editors and verifiers: the `viewer` role does not read them. People involved in HSE events are **a number only**: the register holds no names and no health data and is not linked to the employee record.
- Deviation statuses come from the source system; an unrecognised status stays empty instead of being interpreted.

:::caution[Data]
The current version is an operational demo with test data. Do not enter confidential information, credentials or contractual data.
:::

## How this documentation is updated

The pages live in the repository, under `docs-site/`, and are published automatically on every change to `main`. If a feature changes, the page describing it changes. The translated English pages are kept aligned with the Italian version.
