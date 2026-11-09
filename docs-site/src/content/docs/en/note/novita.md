---
title: What's new
description: Changes to SiteAssistant that affect the product or the way it is used.
---

This page is maintained by the automated documentation process: when the application's behaviour changes, an entry appears here with the date and the pages that were updated. It is not a technical changelog — the repository commit history is the source for that.

## 9 November 2026

- **Verification and reopening restricted.** Only the designated verifier or an owner may close, reject or reopen a task. Whoever submitted the work can never verify it. See [Tasks and verification](../../moduli/attivita/).
- **Local identity with per-site roles.** Email/password sign-in, server-side sessions, `owner`, `editor`, `verifier`, `viewer` roles. See [Sign in and sessions](../../guida/accesso/) and [Users and roles](../../amministrazione/utenti-e-ruoli/).
- **`create-user` CLI.** Account provisioning from the command line, passwords never in argv, initial site assignment. See [Users and roles](../../amministrazione/utenti-e-ruoli/).
- **Operational day and idempotency.** The diary is indexed by site, operational day and shift; task creation accepts `Idempotency-Key`. See [Site diary](../../moduli/diario/) and [REST API](../../riferimento/api/).
- **Manual published.** Italian/English documentation generated from the repository and published on every change. See [Product status](../rilascio/).

## How updates work

1. Every change on `main` touching `app/`, `server/` or `database/` is detected.
2. The affected pages are reviewed and updated, in Italian and English.
3. The build checks internal links; if something is broken, publishing does not go through.
4. The documentation change is a separate commit, labelled `docs(auto)`.

If a change needs screenshots or clarification the process cannot produce, a `docs-stale` issue is opened instead of inventing content.
