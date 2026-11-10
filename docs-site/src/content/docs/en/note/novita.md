---
title: What's new
description: Changes to SiteAssistant that change the product or how you use it.
---

This page collects the changes visible to those who use the application. It is not a technical changelog: for that, see the commit history in the repository.

## 10 November 2026

- **Site progress, deviations and cost impacts via API.** Imported progress and deviations are available read-only; cost impacts are created and closed via API, linked to deviations of the same site. See [REST API](../../riferimento/api/).
- **Hours booked on attendance.** The hours of an attendance day can be assigned to a progress item; the total appears in the item detail. API only. See [REST API](../../riferimento/api/).
- **Attachments with explicit limits.** Attachments on tasks, diary and sites are uploaded and downloaded via API, up to **15 MiB** and only as images or PDF. See [REST API](../../riferimento/api/).

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
