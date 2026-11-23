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

The site's time zone and cutoff determine which operational day a diary entry belongs to.

| Setting | Default value |
| :-- | :-- |
| Site time zone | `Europe/Rome` for `IT`, `Europe/London` for `UK` |
| Start of the operational day | `06:00` (local time) |

These initial values also apply to sites that existed when the settings were introduced. **Owners** can change both values for the selected site. Each save is recorded in the audit log. Saved diary entries keep the time zone and cutoff recorded when they were created. See [Site settings](../../guida/impostazioni/#site-settings).

## What is not configurable

- Per-site logo, colours or domain.
- Custom task or diary fields.
- Night shift start time, holiday calendar, notifications.
