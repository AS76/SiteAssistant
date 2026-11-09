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

## Managing members

Listing and editing members is done via API (`GET`/`POST /api/sites/{id}/members`) and is reserved to **owners**. In this version the interface has **no** members screen. An owner cannot remove or demote themselves.

## Identity and security

Passwords are stored with `scrypt`; sessions are described in [Sign in and account](../../guida/accesso/). There is no autonomous password recovery beyond the "Forgot password" flow described on the same page.
