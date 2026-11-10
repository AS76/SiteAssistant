---
title: What's new
description: Changes to SiteAssistant that change the product or how you use it.
---

This page collects the changes visible to those who use the application. It is not a technical changelog: for that, see the commit history in the repository.

## 10 November 2026

- **planning import from the Overview.** Owners and editors upload an xlsx file, see a preview with new, updated, unchanged, missing untouched and rejected rows, then confirm. No row is deleted. See [Import a planning export](../../amministrazione/import-pianificazione/).
- **Data assistant.** The **AI** button at the bottom right opens a panel with contextual suggestions and answers that cite records. It reads site data and writes nothing. See [Data assistant](../../guida/assistente-ai/).
- **Overview with counters and charts.** Four indicators (open deviations, booked hours, open claims, settled), a deviations-by-status donut, progress by section with a planned marker, and hours per week. See [Common features](../../guida/funzioni-comuni/).
- **Amount settings.** The gear at the top right sets currency, decimals and separators. See [Settings](../../guida/impostazioni/).
- **Photos and PDFs in tasks and diary.** Entries accept images and PDFs, including drag and drop from the desktop, up to 15 MiB per file. See [Site diary](../../moduli/diario/).
- **Sortable tables.** Module table headers sort the list; column filters are optional and tables become cards on phones. See [Common features](../../guida/funzioni-comuni/).
- **Mobile navigation.** On phones the bottom bar shows Overview, Tasks, Deviations, Hours and More. See [Common features](../../guida/funzioni-comuni/).
- **Step weights and progress history.** Step weights must total 100; every recording stays in the history and feeds the curves. See [Site progress](../../moduli/avanzamento/).
- **Core module views.** Deviations, Site progress, Time bookings and Cost impacts have an interface view; imported data stays read-only, while step completion and hour booking are recorded in the application. See [Site progress](../../moduli/avanzamento/) and [REST API](../../riferimento/api/).
- **Site progress, deviations and cost impacts via API.** The endpoints return imported progress and deviations read-only; cost impacts are created via API and closed with a result also from the interface, linked to deviations of the same site. See [REST API](../../riferimento/api/).
- **Hours booked on attendance.** The hours of an attendance day can be assigned to a progress item; the total appears in the item detail. See [REST API](../../riferimento/api/).
- **Attachments with explicit limits.** Tasks and diary accept attachments from the interface; sites stay API only. Limit **15 MiB**, images or PDF only. See [REST API](../../riferimento/api/).

## 9 November 2026

- **Project structure (WBS).** New read-only view with the tree and the flat table of the imported Time Schedule. See [Project structure](../../moduli/wbs/).
- **Self-service access request.** From the sign-in form you can press **Request access** and **Forgot password**; approval happens by an owner via email. See [Sign in and account](../../guida/accesso/).
- **Change password.** If you are using a temporary password, the application invites you to change it. See [Sign in and account](../../guida/accesso/).
- **Restricted verification and reopening.** Only the designated reviewer or an owner can close or reopen a task. Whoever executed the work can never verify it. See [Tasks and reviews](../../moduli/attivita/).
- **Sign-in with per-site roles.** Sign-in with email and password, sessions lasting 7 days, roles `owner`, `editor`, `verifier`, `viewer`. See [Users and roles](../../amministrazione/utenti-e-ruoli/).
- **Operational day.** The diary is organised by site, operational day and shift. See [Site diary](../../moduli/diario/).
- **Attendance via API.** Personnel attendance is available as a read-only projection via API, not yet in the interface. See [REST API](../../riferimento/api/).
- **Remodelled manual.** The documentation has been reorganised for those who use the application on site, with step-by-step guides per module. See [Product status](../rilascio/).

## How the update works

1. Every change on `main` touching `app/`, `server/` or `database/` is detected.
2. The affected pages are reviewed and updated, in Italian and English.
3. The build checks the internal links; if something is broken, publishing does not pass.
4. The documentation change is a separate commit, labelled `docs(auto)`.

If a change requires screenshots or clarifications that the process cannot produce, a `docs-stale` issue is opened instead of inventing content.
