---
title: Product status
description: What is implemented today, what is missing and which limits matter before use.
---

This page describes the currently published version. It is deliberately explicit about what does not exist, to avoid wrong expectations on site.

## Implemented

- Email/password sign-in, server-side sessions with the `sa_session` cookie.
- Per-site roles: `owner`, `editor`, `verifier`, `viewer`.
- Site creation restricted to owners; unique code.
- Tasks with distinct executor and verifier, priority, due date, areas and companies.
- Status transitions with notes and reasons, full event history.
- Separate verification: whoever executes cannot close their own work.
- Diary per operational day and shift, with plan, actuals, impediments and next step.
- Overview, board, filtered list, CSV export, diary printing.
- Italian/English interface and responsive layout.
- Documented REST API with idempotency on task creation.

## Not implemented

- Self-registration, password recovery, transactional email.
- Editing or deleting sites, tasks and diary entries.
- Attachments, photos, signatures or documents.
- Notifications, calendar, planning and maps.
- Offline operation or deferred sync.
- Connectors to ERP, Primavera P6 or other systems.
- Member management from the interface (API only).
- Server-generated PDF reports.

## Limits to know

- Completion evidence is a **text note**, not an attachment.
- Site dates are descriptive: they do not prevent entries outside the range.
- Time zone and cutoff belong to each diary entry; the interface uses the defaults.
- Printing uses the browser: appearance depends on browser and margins.
- Language translates the interface, not user-entered content.
- Two sites never share a code.

:::caution[Data]
The current version is an operational demo with test data. Do not enter confidential information, credentials or contractual data. Access is protected by application authentication and, on the demo instance, by network Basic Auth.
:::

## How this documentation is updated

Pages live in the repository under `docs-site/` and are published automatically on every change to `main`. Content review follows releases: when a feature changes, the page describing it changes. English pages are kept aligned with the Italian version.
