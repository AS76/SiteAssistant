---
title: Configure a site
description: Code, dates, membership and operational-day rules.
---

This page collects the settings that concern a site and their practical effects.

## Site code

- short, unique identifier, max 30 characters;
- used by the `create-user` CLI to assign a user (`--site`);
- cannot be changed after creation;
- a duplicate code is rejected with `409 DUPLICATE_SITE_CODE`.

Use a code that stays stable over time — the job number, for example — because administrators type it when creating accounts.

## Dates

Start and end dates are descriptive: they do not block tasks or diary entries outside the range. The end date cannot precede the start date.

## Membership

Only **owners** can add or remove members and change roles. A user only sees sites where they are a member.

Suggested roles on site:

- `owner` for the site manager and a second responsible person;
- `editor` for foremen and assembly supervisors;
- `verifier` for quality/commissioning, separate from those executing;
- `viewer` for read-only access.

## Operational day

Time zone and cutoff decide which operational day a diary entry belongs to.

| Setting | Default | Where it is set |
| :-- | :-- | :-- |
| Time zone | `Europe/Rome` | `time_zone` field of the diary entry (API) |
| Cutoff time | `06:00` | `day_cutoff_time` field of the diary entry (API) |

These are not site settings and cannot be changed from the interface. If a site works in a different time zone, create the diary entry through the API with the correct values; existing entries keep the values they were saved with.

## Not configurable

- Per-site logo, colours or domain.
- Custom fields for tasks or diary.
- Shift times, holiday calendars, notifications.
