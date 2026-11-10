---
title: Import a planning export
description: Upload an xlsx file, preview what would change and confirm the import.
---

The import brings data exported from planning into SiteAssistant. It always starts with a **preview**: until you confirm, the application writes nothing.

## Who can import

The import is reserved to site **owners** and **editors**. The **Import planning export** button appears in the **Overview**, next to **New task**.

## The file

- **xlsx** format, exported from planning.
- Maximum size **20 MiB**.
- One data family per file.

## The six families

| Export type | What it updates |
| :-- | :-- |
| Employees | Personnel records: number, name, company, qualification, team, dates |
| Work days | Worked days, times, hours and source status |
| Time schedule | Work structure items, with code, dates and planned progress |
| Site progress | Progress items, with section, PLC area and percentages |
| Deviations | Deviations with status, priority, dates and amounts |
| Daily log | Diary entries imported from the planning log |

## The two steps

1. Press **Import planning export**.
2. Pick the **Export type** and the **xlsx file**, then press **Preview**.
3. Read the **What would change** summary.
4. If the numbers look right, press **Confirm import**.

The preview shows five counts:

| Item | Meaning |
| :-- | :-- |
| new | Rows not present in the site: they will be created |
| updated | Existing rows with different values: they will be overwritten |
| unchanged | Rows identical to the existing ones: no write |
| missing (untouched) | Rows present in the site but not in the file: **they are not deleted** |
| rejected | Rows that cannot be imported, listed with source row and reason |

Example: a work-day row with an employee number that does not exist in the site ends up among the **rejected** rows; an item already present with the same values ends up among the **unchanged** rows.

## How rows are matched

Each family uses a stable key from the export:

- employees: employee number;
- work days: date and employee number;
- time schedule: WBS code;
- site progress: description, planned dates, PLC area and section;
- deviations: deviation number;
- daily log: date.

A row with the same key and different values is updated. An identical row stays unchanged.

## Rejected rows

A row is rejected, and not applied, when:

- an employee on a work day does not exist in the site's personnel records;
- the identity of a progress item is ambiguous;
- a deviation status is not recognised;
- a required cell is empty.

Rejected rows stay listed in the preview. Fix the export and repeat the import.

## After confirmation

The application reloads the site data and refreshes the views. The Overview recalculates its counters and charts.

The preview is valid for **15 minutes**: if it expires, repeat the preview before confirming.

## What it does not do

- **It does not delete rows.** Missing rows stay in the site, and the applied removed count is always zero.
- **It does not undo an import** from the interface.
- **It does not import attachments**: files stay outside the export.
- **It does not create employees**: a work day with an unknown employee number is rejected.

For the data format and endpoints see [REST API](../../riferimento/api/). For roles see [Users and roles](../utenti-e-ruoli/).
