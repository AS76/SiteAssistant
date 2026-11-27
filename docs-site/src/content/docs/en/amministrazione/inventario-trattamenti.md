---
title: Record of processing activities
description: The processing activities the SiteAssistant project documents for its demo installation, with purposes, data, retention and measures. Includes the demo access log.
---

> **Scope.** This page lists the processing activities that the SiteAssistant project documents for its own demonstration installation. It is **not** the record of processing activities of the organisation that installs the software: that record is drawn up by the controller, who decides the purposes, the legal basis and the retention of its own data. See [Privacy and responsibilities](../privacy-responsabilita/) and the [deployment checklist](../privacy-checklist/).

## Documented activities

| Activity | Purpose | Personal data | Legal basis | Retention | Main measures |
| --- | --- | --- | --- | --- | --- |
| Demo access log | Knowing who enters the demo, when, how often and with which failures; service security | User identifier, date and time, truncated IP address, user agent, failure reason class | Declared by the demo installation's controller as a service security purpose (see below) | 180 days, with no automatic deletion | IP truncated at ingest; no password or token; no browser tracker |

## Demo access log

### Why it exists

To know who enters the demo, when and how often, and to tell normal use apart from abusive access, without introducing an external analytics platform. The data stays in the application database and does not feed browser trackers.

### Events recorded

- `login.success` — successful sign-in, with password or passkey.
- `login.failure` — failed sign-in, with the **reason class** (for example wrong credentials or a lockout after too many attempts). The typed password is never recorded.
- `logout` — explicit sign-out.
- `session.expired` — expired session.
- `activation.used` — completed invitation activation.
- `invitation.sent` — invitation sent.
- `invitation.used` — invitation used.

For each event the log keeps the user where one exists, the date and time, the truncated IP address, the user agent (up to 1000 characters) and a technical detail field with the sign-in method or the reason class. **No password, no invitation token and no secret is ever written to the log.**

### Measure on the IP address

The address is truncated at the time of recording; it is not stored in full and reduced later:

- **IPv4**: the first three blocks are kept, for example `203.0.113.0` (that is, /24).
- **IPv6**: the /48 prefix is kept.

Truncation is a reduction, not anonymisation. An unsalted hash of the address would be reversible by guessing across the IPv4 space and would not make the address unidentifiable: that is why the project declares truncation and does not use a hash.

### Retention and deletion

- **180 days** is the declared retention period for the log.
- **No automatic deletion of real data** without the Product Owner's approval: any deletion remains a manual, approved operation.
- In the documented version the software does not run an automatic purge of the log.

### Legal basis

The declared purpose is service security and measuring use of the demo. The legal characterisation — for example the controller's legitimate interest — must be confirmed by the installation's controller in its own privacy assessment: the software does not assign legal bases automatically and this page is not legal advice.

### Where the data is and how to read it

The log is the `auth_events` table in the application database (SQLite or PostgreSQL). The aggregate report is produced from the command line, read-only:

```bash
npm run stats -- --from 2026-11-01 --to 2026-11-30
```

The report contains the total number of successful accesses, distinct users, accesses per day, the last access per user and the number of failures.

### Technical references

- Migration `052_auth_activity` for SQLite and PostgreSQL: the `sessions.expiry_logged_at` column and the index on login events in `auth_events`.
- `server/auth-events.mjs`: event recording and IP truncation.
- `server/stats.mjs`: read-only aggregate report.
- Commit `5b2727d` (PR #49), which introduced the log.
- Work cards: `165ca0b9` (this inventory entry) and `83653dc9` (access log and CLI report).

How a person signs in to the demo is described in [Sign in and account](../../guida/accesso/).

### Status and date

Entry documented on **26 November 2026** against the version in `main` (commit `1601a2d`). Later inventory entries are added with the same structure: purpose, data, legal basis, retention, measures and verifiable references.
