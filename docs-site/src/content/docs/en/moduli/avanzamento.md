---
title: Site progress
description: Consult the imported progress items, assign a type and record step completion.
---

The **Site progress** view shows the progress items of the selected site. The base data comes from the planning export; step completion is recorded in the application.

## The list

Each row shows the description, section, PLC area, progress percentage and booked hours. The filter at the top limits the list to the items linked to a work structure node.

Open a row to see the details.

## The detail

The detail shows:

- description, section and PLC area;
- the linked WBS item, when it exists;
- the assignee;
- progress and planned progress;
- the delta calculated by the source;
- booked hours;
- planned start and finish, actual start and expected delay;
- the **Has files**, **Has notes** and **Has deviations** flags.

Imported fields are read-only. The only data you write is step completion.

## Progress types and weights

A **progress type** describes how the work of an item is measured: a list of steps, each with a weight. Weights are percentages of the item and must add up to **100**.

Example: four steps with weights 30, 30, 20 and 20. If the total is 99 or 101, the type is rejected.

A type is created via API and reserved to owners. In the interface an owner can assign or remove the type on an item; an owner or editor can record step completion.

## Recording completion

1. Open the item detail.
2. Under **Record step completion**, enter a percentage from 0 to 100 for each step.
3. Press **Save steps**.

The item's progress is recalculated as the weighted average. If an item has a type assigned but no recorded step, the computed progress is **0**: the imported value is not used.

Every save appends a record to the **history**. The history is never rewritten, and progress curves are calculated from it, not from imports.

## Who can do what

| Action | Role |
| :-- | :-- |
| View items and details | Every site member |
| Assign or remove a progress type | owner |
| Record step completion | owner, editor |
| Create or delete a progress type | owner, API only |

## What is not available yet

- Creating or editing a progress type from the interface.
- Editing the imported fields of an item.
- Creating or deleting progress items from the interface: they come from the import.

For the link between progress and the work structure see [Project structure (WBS)](../wbs/). For the raw data see [REST API](../../riferimento/api/).
