---
title: Site diary
description: How the shift plan and actuals are recorded, and how the operational day works.
---

The **diary** records, per shift, what was planned, what was done, which impediments came up and what carries over to the next shift.

## Where it is

The **Diary** view lists entries for the selected site on the current reporting date. **New entry** opens the form.

## Entry fields

| Field | Required | Notes |
| :-- | :-- | :-- |
| Shift | Yes | `day` or `night` |
| Plan | No | What was planned for the shift |
| Actuals | No | What was actually done |
| Impediments | No | Blocks, interference, non-conformities |
| Next step | No | What carries over to the next shift |
| Date | Yes | Operational day computed by the application |

There is exactly **one entry per site, operational day and shift**. A second insert on the same combination is rejected with `409 DUPLICATE_DIARY`.

## Operational day

The operational day does not start at midnight:

- it begins at the configured cutoff time, **06:00** by default in the **Europe/Rome** time zone;
- it ends at 05:59:59 the following day;
- a night shift belongs to the operational day in which it started.

Example: a night shift starting on 12 November at 22:00 and ending on 13 November at 06:00 is recorded on **12 November**.

Time zone and cutoff belong to the individual diary entry. The interface uses the defaults; to set them differently you must go through the API (`time_zone`, `day_cutoff_time`), as described in [REST API](../../riferimento/api/).

## Printing

The diary is printed with the browser print dialog. There is no server-side PDF preview and no archive of printouts.

## Not available

- Editing or deleting an entry after saving.
- An author other than the authenticated user.
- Linking a diary entry to tasks.
- Attachments or photos.
