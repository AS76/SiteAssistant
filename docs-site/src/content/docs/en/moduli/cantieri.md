---
title: Sites
description: Create, select and organise the sites you work on.
---

A **site** is the organising unit in SiteAssistant. Every task and every diary entry belongs to a site and is visible only to its members.

## Site list

The **Sites** view shows a card for each site where you have an active role:

- code and name;
- location;
- start and end dates;
- total and open task counts.

The selected site is highlighted. **Open** sets the working context; from then on Overview, Tasks and Diary show that site only.

## Creating a site

Creation is restricted to users with the **owner** role on at least one site. The form requires:

| Field | Required | Notes |
| :-- | :-- | :-- |
| Code | Yes | Unique, max 30 characters; also used by the CLI to assign users |
| Name | Yes | Max 120 characters |
| Location | No | Max 160 characters |
| Start date | No | Defaults to today |
| End date | No | Cannot precede the start date |

Whoever creates the site automatically becomes its **owner**.

An existing code is rejected with `409 DUPLICATE_SITE_CODE`: two sites never share a code.

## Membership and roles

Membership links a user to a site with a role: `owner`, `editor`, `verifier` or `viewer`. Without membership the site is not listed and its API calls return `403`.

Members are managed through the API (`GET`/`POST /api/sites/{id}/members`) because this version has no dedicated screen. See [Users and roles](../../amministrazione/utenti-e-ruoli/).

## Not available

- Deleting or archiving a site from the interface.
- Editing a site after creation (name, dates, location).
- Managing members from the interface.

These operations do not exist in the current version; they are not hidden, simply absent.
