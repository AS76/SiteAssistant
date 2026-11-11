---
title: What's new
description: Changes to SiteAssistant that change the product or how you use it.
---

This page collects the changes visible to those who use the application. It is not a technical changelog: for that, see the commit history in the repository.

## 11 November 2026

- **Tools register.** New **Tools** view, in the **Management** group of the navigation: name, code or serial number, contractor, status — available, in use, maintenance, retired — location and notes, with contractor and status filters. Owners, editors and verifiers add, edit and delete rows; viewers only read. See [Tools](../../moduli/attrezzature/).
- **Grouped desktop navigation.** On desktop the views are collected in **Operations**, **Site** and **Management**; the entries and the phone bottom bar do not change. See [Common features](../../guida/funzioni-comuni/#the-navigation-groups).
- **Buttons that match the roles.** The `viewer` role no longer sees **New task** on the Overview and in Tasks; **New site** appears only to owners. The server checks do not change. See [Users and roles](../../amministrazione/utenti-e-ruoli/).
- **Printable site report.** The **Print PDF** button on the Overview and in Site progress opens a report with two tables — progress by macro-area with actual, planned and the source of the value, and deviations by macro-area with total, open, closed or rejected and the count by status. Printing uses the browser, A4 and without buttons. See [Site progress](../../moduli/avanzamento/#site-report).
- **CSV export of the report.** Both report tables download as CSV files, with raw numbers and empty cells when a value is missing. See [Site progress](../../moduli/avanzamento/#site-report).
- **Saved views in Tasks.** Filters, board or list, sorting and visible columns are saved under a name; a view can be personal or shared with the site, and can be updated, renamed or deleted from the menu. See [Tasks and reviews](../../moduli/attivita/#saved-views).
- **WBS code and description in the progress detail.** The detail of a progress item shows the linked node as the code followed by the description, instead of the code alone. See [Site progress](../../moduli/avanzamento/#the-detail).

## 10 November 2026

- **planning import from the Overview.** Owners and editors upload an xlsx file, see a preview with new, updated, unchanged, missing untouched and rejected rows, then confirm. No row is deleted. See [Import a planning export](../../amministrazione/import-pianificazione/).
- **Data assistant.** The **AI** button at the bottom right opens a panel with contextual suggestions and answers that cite records. It reads site data and writes nothing. See [Data assistant](../../guida/assistente-ai/).
- **Overview with counters and charts.** Four indicators (open deviations, booked hours, open claims, settled), a deviations-by-status donut, progress by section with a planned marker, and hours per week. See [Common features](../../guida/funzioni-comuni/).
- **Amount settings.** The gear at the top right sets currency, decimals and separators. See [Settings](../../guida/impostazioni/).
- **Photos and PDFs in tasks and diary.** Entries accept images and PDFs, including drag and drop from the desktop, up to 15 MiB per file. See [Site diary](../../moduli/diario/).
- **Sortable tables.** Module table headers sort the list; column filters are optional and tables become cards on phones. See [Common features](../../guida/funzioni-comuni/).
- **Mobile navigation.** On phones the bottom bar shows Overview, Tasks, Deviations, Hours and More. See [Mobile quick guide](../../guida/mobile/).
- **Claim status labels.** Cost impacts use their own labels — Open, Notification sent, Submitted, Closed — instead of the task ones. See [Cost impacts](../../moduli/impatti-economici/).
- **Diary writing for owners, editors and verifiers.** Users with the `viewer` role read the diary but do not see the button to add a contribution. See [Site diary](../../moduli/diario/).
- **Illustrated manual.** Procedures now have numbered steps, captioned images and what to do when something fails; the new [Mobile quick guide](../../guida/mobile/) covers the bottom bar, cards and touch targets.
- **Accordion boards on phones.** Tasks and Deviations show one status group at a time, opened with a tap, with no horizontal scrolling. See [Mobile quick guide](../../guida/mobile/).
- **Deviation detail tabs.** The detail separates **Data** and **References**; the project structure tree shows the progress percentage next to each item. See [Deviations](../../moduli/deviazioni/) and [Project structure](../../moduli/wbs/).
- **Clearer passwords.** The sign-in form has a button to show the password; the temporary-password notice can be dismissed with × for the browser session. See [Sign in and account](../../guida/accesso/).
- **Completion bar on sites.** Every site card shows the share of closed tasks. See [Sites](../../moduli/cantieri/).
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
