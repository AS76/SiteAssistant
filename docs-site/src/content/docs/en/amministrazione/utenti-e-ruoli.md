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
| Write the diary | Yes | Yes | Yes | No |
| Verify or reopen | Yes* | No | Yes* | No |
| Manage site members | Yes | No | No | No |
| Create new sites | Yes | No | No | No |
| Import a planning export from the interface | Yes | Yes | No | No |
| Import snapshots through dedicated endpoints — API only | Yes | No | No | No |
| Assign a progress type to an item | Yes | No | No | No |
| Record step completion | Yes | Yes | No | No |
| Create or delete progress types — API only | Yes | No | No | No |
| Book hours on attendance and progress items | Yes | Yes | No | No |
| Manage the tools register | Yes | Yes | Yes | No |
| Read the HSE register | Yes | Yes | Yes | No |
| Add, edit or delete HSE events | Yes | Yes | No | No |
| Upload attachments on tasks and diary | Yes | Yes | No | No |
| Delete an attachment — API only | Yes | Yes | No | No |
| Create cost impacts — API only | Yes | Yes | Yes | No |
| Move or close a cost impact | Yes | No | Yes | No |

\* Only if designated reviewer of the task, and never on their own work. An owner can verify tasks they are not the designated reviewer of, but cannot verify what they executed themselves.

## How an account is created

An account can be created in two ways:

1. **Self-service request.** From the sign-in form anyone can press **Request access** and enter their email; an owner approves it and the user receives a temporary password (see [Sign in and account](../../guida/accesso/)).
2. **Administrator creation.** Whoever manages the server can create accounts and immediately assign them to a site with the `create-user` CLI:

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

## Managing members

Listing and editing **roles** is done via API (`GET`/`POST /api/sites/{id}/members`) and is reserved to **owners**. In this version the interface has **no** dedicated roles screen. An owner cannot remove or demote themselves.

**Module access**, on the other hand, is managed from the interface: see the next section.

## Module access

What it is for: limiting what a member sees without changing their role.

In the **Sites** view, below the site cards, an owner finds the **Module access** table for the selected site: one row per member and one column per module. Clear the tick to exclude that member from the module. The change is saved immediately and applies to that site only.

- **No configuration, no change.** Until a row is saved, every module stays allowed: restrictions exist only where an owner clears a tick.
- **Always allowed.** **Overview** and **Sites** stay available to every member. Owner rows are locked, so no owner can lock themselves out of a module.
- **What changes for the member.** The module entry disappears from the navigation and a direct link shows **Module unavailable**. API requests answer `403 MODULE_FORBIDDEN`, on reads and writes alike.
- **Aggregate data.** The Overview reads deviations, progress, hours, project structure and impacts; the report reads deviations, progress, hours and project structure. If you exclude one of these modules from a member, their Overview cannot show the aggregate data.
- **Online only.** The table cannot be edited offline: the boxes are disabled until the application is connected.

Module access adds to the role permissions and never widens them: a `viewer` who keeps a module still cannot write.

## Identity and security

Passwords are stored with `scrypt`; sessions are described in [Sign in and account](../../guida/accesso/). There is no autonomous password recovery beyond the "Forgot password" flow described on the same page.
