---
title: Users and roles
description: Per-site roles, account creation and membership management.
---

## Roles

A role is **per site**, not global. The same person can be `owner` on one site and `viewer` on another. Without membership, that site does not exist for the user.

| Capability | owner | editor | verifier | viewer |
| :-- | :-: | :-: | :-: | :-: |
| View sites, tasks and diary | Yes | Yes | Yes | Yes |
| Create and advance tasks | Yes | Yes | Yes | No |
| Write the diary | Yes | Yes | Yes | No |
| Verify or reject | Yes* | No | Yes* | No |
| Reopen a closed task | Yes* | No | Yes* | No |
| Manage site members | Yes | No | No | No |
| Create new sites | Yes | No | No | No |

\* Only when designated verifier of that task, and never on their own submission. An owner may verify tasks where they are not the designated verifier, but can never self-verify.

## Creating an account

Accounts are created from the command line on the server:

```sh
npm run create-user -- \
  --email mario.rossi@example.com \
  --name "Mario Rossi" \
  --password-stdin \
  --site SITE01 \
  --role editor
```

Rules:

- the password is read from a TTY or `--password-stdin`, **never** as an argument (it would end up in shell history);
- minimum **12 characters**;
- email is normalised to lowercase;
- `--site` and `--role` go together; the site code must exist;
- allowed roles: `owner`, `editor`, `verifier`, `viewer`;
- without `--site` the user is created but linked to no site.

To create a user without assigning a site:

```sh
npm run create-user -- --email mario.rossi@example.com --name "Mario Rossi" --password-stdin
```

## Managing members

The API exposes membership management:

- `GET /api/sites/{id}/members` — members and roles (owner only);
- `POST /api/sites/{id}/members` — set or remove a role.

Request body:

```json
{ "user_id": "user-uuid", "role": "verifier" }
```

With `"role": null` the user is removed from the site. An owner cannot downgrade themselves: the server responds `400 VALIDATION_ERROR`.

This version has **no** members screen in the interface: management goes through the API.

## Authentication and identity

There is no self-registration, password recovery or email sending from the application. Passwords are stored with `scrypt`; sessions are described in [Sign in and sessions](../../guida/accesso/).
