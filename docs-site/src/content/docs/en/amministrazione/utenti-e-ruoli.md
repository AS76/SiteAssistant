---
title: Users and roles
description: The per-site roles, how accounts are created and how memberships are managed.
---

Permissions in SiteAssistant are **per site**, not global: the same person can be `owner` on one site and `viewer` on another. Without membership, the site does not exist for that user.

## The roles

| Capability | owner | editor | verifier | viewer |
| :-- | :-: | :-: | :-: | :-: |
| View sites, tasks and diary | Yes | Yes | Yes | Yes |
| Create and move tasks | Yes | Yes | Yes | No |
| Record a contribution for today or the previous seven days | Yes | Yes | Yes | No |
| Record a contribution for an older date | With a reason | No | No | No |
| Correct a diary entry | Any entry | Own entries within seven days | Own entries within seven days | Own entries within seven days |
| View diary version history | Yes | Yes | Yes | Yes |
| Verify or reopen | Yes* | No | Yes* | No |
| Manage site members | Yes | No | No | No |
| Create new sites | Yes | No | No | No |
| Import a planning export from the interface | Yes | Yes | No | No |
| Import snapshots through dedicated endpoints — API only | Yes | No | No | No |
| Assign a progress type to an item | Yes | No | No | No |
| Record step completion | Yes | Yes | No | No |
| Create or delete progress types — API only | Yes | No | No | No |
| Book hours on attendance and progress items | Yes | With Time bookings and Worker names and individual hours access | No | No |
| Manage the tools register | Yes | Yes | Yes | No |
| Read the HSE register | Yes | Yes | Yes | No |
| Add, edit or delete HSE events | Yes | Yes | No | No |
| Set up HSE assets or record an inspection | Yes | Yes | No | No |
| Upload attachments on tasks, diary and HSE events | Yes | Yes | No | No |
| Open the attachments of an HSE event | Yes | Yes | Yes | No |
| Delete an attachment — API only | Yes | Yes | No | No |
| Create cost impacts — API only | Yes | Yes | Yes | No |
| Move or close a cost impact | Yes | No | Yes | No |

\* Only if designated reviewer of the task, and never on their own work. An owner can verify tasks they are not the designated reviewer of, but cannot verify what they executed themselves. A task assigned with a free name, with no linked account, can be reviewed by owners only.

Diary actions require access to the **Diary** module. An author can still correct their own entry within the seven-day window if their role changes to `viewer`. An owner needs a reason to correct another author's entry, an entry without a linked author or an entry more than seven days old. See [Site diary](../../moduli/diario/#correcting-an-entry-and-viewing-its-history).

## How an account is created

An account can be created in three ways:

1. **Self-service request.** From the sign-in form anyone can press **Request access** and enter their email; an owner approves it and the user receives a temporary password (see [Sign in and account](../../guida/accesso/)).
2. **Email invitation.** Someone with `invitations.manage` sends a single-use link. The account starts with zero sites by default. A site owner can assign a role later or include it in the invitation if they also have invitation permission.
3. **Administrator creation.** Whoever manages the server can create accounts and immediately assign them to a site with the `create-user` CLI:

```sh
npm run create-user -- \
  --email mario.rossi@example.com \
  --name "Mario Rossi" \
  --password-stdin \
  --site CANTIERE01 \
  --role editor
```

Main rules:

- the password is read from a TTY or from `--password-stdin`, **never** as an argument;
- at least **12 characters**;
- the email is normalised to lowercase;
- `--site` and `--role` must be given together; the site code must exist;
- the allowed roles are `owner`, `editor`, `verifier`, `viewer`.

Capabilities marked **API only** are used by calling the endpoints described in [REST API](../../riferimento/api/).

The import from the interface is described in [Import a planning export](../import-pianificazione/). Cost impact transitions and closure with a result are also available in the impact detail.

## Sending and revoking invitations

Accounts start without `invitations.manage`. It allows invitation administration. Site roles and access come from membership. Server operators grant and revoke the permission through the CLI.

```sh
npm run admin -- grant invitations.manage operator@example.invalid
npm run admin -- revoke invitations.manage operator@example.invalid
```

Send the invitation with `POST /api/admin/invitations` and choose `locale: "it"` or `"en"`. The link expires after **72 hours**. Use `POST /api/admin/invitations/{id}/revoke` to invalidate it before activation. See the [REST API](../../riferimento/api/#authentication-and-account).

```sh
npm run invitations -- list
npm run invitations -- retry <id|email>
npm run invitations -- reissue <id|email>
npm run invitations -- revoke <id|email>
```

`list` shows unused, unrevoked and unexpired invitations. `retry` retries a failed delivery with a fresh link for the same invitation. `reissue` revokes the outstanding invitation and creates another with a fresh 72-hour window. Use it when sending was interrupted and the status stays `pending`. `revoke` invalidates the link. Configure the mail service and the HTTPS public URL (`PUBLIC_URL`) before sending through the CLI.

## Managing members

Listing and editing **roles** is done via API (`GET`/`POST /api/sites/{id}/members`) and is reserved to **owners**. In this version the interface has **no** dedicated roles screen. An owner cannot remove or demote themselves.

**Module access**, on the other hand, is managed from the interface: see the next section.

## Linking existing tasks to people

What it is for: giving an account to tasks created when the form accepted only a hand-typed name.

The person identifiers existed from the authentication work onwards and permissions already used them, but the creation form never filled them: older tasks carry names only. The following command links them, without touching the names, the history or who submitted the task:

```sh
node server/recognise-responsibles.mjs --site <site_id>
node server/recognise-responsibles.mjs --site <site_id> --apply
```

`--site` wants the site identifier, not the site code.

- **Dry run first.** Without `--apply` the command writes nothing: it prints the `matched`, `unmatched` and `ambiguous` counts and the list of ambiguous cases. The counts are per assignment field, executor and reviewer, so one task can contribute twice.
- **Exact matches only.** A name is linked when, after collapsing spaces and ignoring case, it matches a single active member with a suitable role: `owner`, `editor` or `verifier` for the executor, `owner` or `verifier` for the reviewer.
- **Ambiguous and missing names stay.** Two members with the same name, or no member with that name, leave the task as it is: `--apply` does not guess.
- **Repeatable.** Fields already linked are skipped, so running the command again changes nothing.
- **Existing database.** The command opens the database already in place — `DATA_DIR` for SQLite, `DATABASE_URL` with `DB_DRIVER=pg` — and never runs migrations.

## Module access

What it is for: limiting what a member sees without changing their role.

In the **Sites** view, below the site cards, an owner finds the **Module access** table for the selected site: one row per member and one column per module. Clear the tick to exclude that member from the module. The change is saved immediately and applies to that site only.

- **Default access.** Most modules are on by default. **Procurement**, **Worker names and individual hours** and **Site attendance** require an explicit grant for each member who is not an owner.
- **Always allowed.** **Overview** and **Sites** stay available to every member. Owner rows are locked, so no owner can lock themselves out of a module. **Today**, the first screen on a phone, has no checkbox either: it only shows the modules you are allowed.
- **Procurement (`logistics`).** It is the **Procurement** entry in the **Management** group and it has its own column in the table. It stays off by default: a member sees it only when an owner ticks it, from the table or with `PUT /api/member-access`, while a site owner always sees it. It serves the procurement view, with its orders and packages, and the order, package and shipment endpoints. See [Procurement](../../moduli/logistica/) and [REST API](../../riferimento/api/#purchase-orders).
- **Worker names and individual hours (`workforce_names`).** This checkbox grants access to employee records and individual work days. With **Time bookings** enabled, it opens the booking detail. With the checkbox cleared, **Time bookings** shows imported hours summarised by company, day or period. It also enables employee selection in **Fitness**. See [Time bookings](../../moduli/prenotazioni-ore/) and [Fitness](../../moduli/idoneita/).
- **Site attendance (`workforce_presence`).** This checkbox opens a read-only view of worker names, companies, shifts and scheduled times for the current operational day. Grant it independently of the hours permissions. See [Site attendance](../../moduli/prenotazioni-ore/#site-attendance).
- **Import status (`reporting`).** It is the **Import status** entry in the **Management** group and it has its own column in the table. It is on by default: an owner clears it like the other modules. It serves the view that summarises the latest complete bundle per scope, with counts by family; it is read-only and needs the reporting database connection configured on the server. See [Import status](../../moduli/reporting/) and [REST API](../../riferimento/api/#import-status).
- **What changes for the member.** The module entry disappears from the navigation and a direct link shows **Module unavailable**. API requests answer `403 MODULE_FORBIDDEN`, on reads and writes alike.
- **Aggregate data.** The Overview reads deviations, progress, hours, project structure and impacts; the report reads deviations, progress, hours and project structure. If you exclude one of these modules from a member, their Overview cannot show the aggregate data. Reporting reads a separate database, not the site modules: excluding a module does not change its counts.
- **Online only.** The table cannot be edited offline: the boxes are disabled until the application is connected.

Module access adds to the role permissions and never widens them: a `viewer` who keeps a module still cannot write.

## Identity and security

Passwords are stored with `scrypt`; sessions are described in [Sign in and account](../../guida/accesso/). There is no autonomous password recovery beyond the "Forgot password" flow described on the same page.

**Passkey** sign-in is optional and every user manages their own from the **Security** window in Settings: adding, renaming and deleting apply only to the account of whoever asks. On the server passkeys require `WEBAUTHN_RP_ID` and `WEBAUTHN_ORIGIN`: without those variables the routes answer `503 WEBAUTHN_NOT_CONFIGURED` and the application says passkeys are not configured, leaving the password as the only way in. An account's last passkey cannot be deleted.
