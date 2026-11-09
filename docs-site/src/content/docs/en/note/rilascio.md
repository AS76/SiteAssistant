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
- **Project structure (WBS)** read-only view: tree and flat table.
- Overview, board, list with filters, CSV export, diary printing.
- Italian/English interface and responsive layout.

## Available only via API (not in the interface)

- Managing site members.
- Importing the Time Schedule (WBS) and attendance snapshots.
- Attachments on tasks, diary and sites.
- Resuming a blocked task and rejecting a submission (transitions not yet exposed in the app).

## Not available

- Editing or deleting sites, tasks and diary entries.
- Acceptance criteria, long descriptions, checklists.
- Attachments, photos or signatures in the interface.
- Notifications, calendar, planning and maps.
- Offline operation or deferred synchronisation.
- Connectors to ERP, Primavera P6 or other systems.
- Server-generated PDF reports.

## Limits to know

- The completion evidence is a **text note**, not an attachment.
- The executor and reviewer are entered as **free-text names**, not linked to accounts.
- Site dates are descriptive: they do not prevent entries outside the range.
- Timezone and cutoff time are attributes of the individual diary entry; the interface uses the default values.
- Printing uses the browser: the appearance depends on the browser and the chosen margins.
- The language switch translates the interface, not the entered content.

:::caution[Data]
The current version is an operational demo with test data. Do not enter confidential information, credentials or contractual data.
:::

## How this documentation is updated

The pages live in the repository, under `docs-site/`, and are published automatically on every change to `main`. If a feature changes, the page describing it changes. The translated English pages are kept aligned with the Italian version.
