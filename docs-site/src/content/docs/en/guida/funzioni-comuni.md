---
title: Common features
description: Navigation, site selection, language, filters and exports shared by every view.
---

## Interface layout

The header contains, from left to right:

- the **site picker**, listing only sites where you have an active role;
- **navigation** across **Overview**, **Sites**, **Tasks**, **Diary**;
- the **language picker** (IT / EN);
- your name and the **Sign out** button.

The active view is highlighted. Views are also reachable by URL hash: `#overview`, `#sites`, `#tasks`, `#diary`.

## Overview

A snapshot of the selected site:

- open tasks ordered by urgency and due date;
- verification progress: closed over total, with blocked and awaiting-verification counts;
- the latest diary entry for the current operational day.

## Tasks: board and list

The **Tasks** view has two representations:

- **Board**: columns per status (`todo`, `in_progress`, `to_verify`, `closed`, `blocked`);
- **List**: rows with priority, due date and people.

Filters cover free text, status, person and priority. The person filter lists **executors** present in the loaded tasks, not verifiers. On narrow screens the board becomes a horizontal carousel with column snapping.

## Exports and printing

- **CSV** of the tasks currently loaded and filtered, not the whole database.
- **Print** of the diary through the browser print dialog: there is no server-generated PDF.

## Language

The IT/EN picker translates interface labels immediately. User-entered content — titles, notes, reasons, diary entries — stays in the language it was written in.

The selected language and site live in memory until the page is reloaded.

## Devices and accessibility

The interface is responsive and keyboard navigable. Input forms are modal dialogs with focus management; validation errors are announced in the form message area.
