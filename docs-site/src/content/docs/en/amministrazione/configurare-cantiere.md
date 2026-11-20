---
title: Configure a site
description: Code, dates, memberships and the operational-day rules.
---

This page collects the settings that concern a site and their practical effects, for those who administer it.

## Site code

- short, unique identifier, at most 30 characters;
- used by the `create-user` CLI to assign a user (`--site`);
- not editable after creation;
- a duplicate code is rejected.

It is worth using a stable code over time — for example the order code — because it is what administrators type when they create accounts.

## Dates

The start and end dates are **descriptive**: they do not block entering tasks or diary entries outside the range. The end date cannot be before the start date.

## Jurisdiction

Every site declares the law that applies to it: `IT` or `UK`. The jurisdiction belongs to the site, not to the person and not to the interface language.

- The default is `IT`, including for sites created before the field existed.
- It is given at creation with `POST /api/sites` and changed with `PATCH /api/sites/{id}`.
- The change is reserved to **owners** and leaves a row in the audit register.
- It cannot be set from the interface yet.

## Memberships and roles

Only **owners** can add or remove members and change roles. A user only sees the sites they belong to.

Recommended roles on site:

- `owner` for the Site Manager and a second responsible person;
- `editor` for foremen and erection supervisors;
- `verifier` for quality/testing, separate from those who execute;
- `viewer` for those who only need to consult.

## The operational day

Timezone and cutoff time determine which operational day a diary entry belongs to.

| Setting | Default value | Where it is set |
| :-- | :-- | :-- |
| Timezone | `Europe/Rome` | Diary-entry attribute (via API) |
| Cutoff time | `06:00` | Diary-entry attribute (via API) |

They are not site settings and are not editable from the interface. Entries already saved keep the values they were recorded with.

## What is not configurable

- Per-site logo, colours or domain.
- Custom task or diary fields.
- Shift times, holiday calendar, notifications.
