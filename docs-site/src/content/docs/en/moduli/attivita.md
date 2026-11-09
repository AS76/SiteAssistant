---
title: Tasks and verification
description: Statuses, transitions, evidence and the separation between executor and verifier.
---

A **task** is the unit of work performed on site. Each task belongs to a site, has distinct executor and verifier, and moves only through allowed transitions.

## Creating a task

From **New task**:

| Field | Required | Notes |
| :-- | :-- | :-- |
| Title | Yes | Max 180 characters |
| Area | No | Max 100 characters |
| Company | No | Max 100 characters |
| Executor | Yes | Site member with a write role |
| Verifier | Yes | Site member with role `owner` or `verifier` |
| Priority | Yes | `normal`, `high`, `urgent` |
| Due date | No | Defaults to today |

A task starts in `todo`. **Executor and verifier must be different people**: the server rejects the assignment with `400 SEPARATE_PEOPLE_REQUIRED`.

## Statuses

| Status | Meaning |
| :-- | :-- |
| `todo` | Planned, not started |
| `in_progress` | Being executed |
| `to_verify` | Declared complete, awaiting verification |
| `closed` | Verified and closed |
| `blocked` | Stopped by an impediment |

## Transitions

| From | To | Action | Requires |
| :-- | :-- | :-- | :-- |
| `todo` | `in_progress` | start | — |
| `todo` | `blocked` | block | Reason |
| `in_progress` | `to_verify` | submit | Evidence note |
| `in_progress` | `blocked` | block | Reason |
| `to_verify` | `closed` | verify | Note; designated verifier or owner only |
| `to_verify` | `in_progress` | reject | Note; designated verifier or owner only |
| `to_verify` | `blocked` | block | Reason |
| `closed` | `in_progress` | reopen | Reason; designated verifier or owner only |

Rules the server always enforces:

- whoever submitted the work **cannot** verify or reject it (`409 INVALID_TRANSITION`);
- `blocked` has no outgoing transitions in the interface; the API allows `resume` back to the status it was blocked from;
- every transition records actor, timestamp, from/to status, note and reason in the task history.

## Verification and closure

Closing requires two separate acts: the executor declares completion with an evidence note, the verifier confirms. The note is mandatory in both steps. If the verifier rejects, the task returns to `in_progress` and the rejection note stays in the history.

Evidence is **text only**: no attachments, signatures or photos.

## Board and list

The board groups tasks by status; the list orders them by due date and priority. Both open the detail view with fields and the full transition history.

## Not available

- Editing a task after creation.
- Acceptance criteria, long descriptions, checklists.
- Deleting a task.
- Restoring from a JSON file.
