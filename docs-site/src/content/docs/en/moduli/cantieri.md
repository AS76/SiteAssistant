---
title: Sites
description: Create and select the sites you work on.
---

The **site** is the container for all the work: tasks and diary always belong to a site and are only visible to its members.

## The site list

The **Sites** view shows a card for every site you belong to, with:

- code and name;
- location;
- start and end dates;
- number of total tasks and still-open tasks.

The selected site is highlighted. The **Open** button sets it as the working context: from then on Overview, Tasks, Project structure and Diary show only that site.

## Create a site

Creating a site is reserved to users with the **owner** role on at least one site. From the **New site** button:

| Field | Required | Notes |
| :-- | :-- | :-- |
| Code | Yes | Unique, at most 30 characters; also used to assign users |
| Name | Yes | At most 120 characters |
| Location | No | At most 160 characters |
| Start date | No | Pre-filled with today |
| End date | No | Cannot be before the start date |

Whoever creates the site automatically becomes its **owner**. An already-used code is rejected: no two sites share the same code.

## Roles and visibility

Membership in a site associates each person with a role: `owner`, `editor`, `verifier` or `viewer`. Without membership the site does not appear in your list. The roles are described in [Users and roles](../../amministrazione/utenti-e-ruoli/).

## What is not available yet

- Deleting or archiving a site from the interface.
- Editing a site after creation (name, dates, location).
- Managing members from a dedicated screen: in this version it is done via API.

These operations are not "hidden": they simply do not exist yet in this version.
