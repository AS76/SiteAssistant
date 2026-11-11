---
title: REST API
description: Endpoint reference for those who integrate with or administer SiteAssistant.
---

:::tip[This page is for integrators]
If you only use the web app, you do not need this: it is the technical documentation of the HTTP interface the application uses behind the scenes, useful for those who integrate SiteAssistant or administer it from the server.
:::

The API is an HTTP service that the frontend calls directly. There are no API tokens: authentication uses the `sa_session` session cookie, obtained at sign-in and sent automatically by the browser.

## Authentication and account

| Method | Path | Access | Notes |
| :-- | :-- | :-- | :-- |
| GET | `/api/health` | none | Service status |
| POST | `/api/auth/login` | none | `{ email, password }`; sets the cookie |
| GET | `/api/auth/me` | authenticated | User and per-site roles |
| POST | `/api/auth/logout` | authenticated | Revokes the session |
| POST | `/api/auth/request` | none | Access request `{ email }` |
| GET/POST | `/api/auth/request/decide` | owner (via email link) | Approve or reject a request |
| POST | `/api/auth/password` | authenticated | Change password |
| POST | `/api/auth/forgot` | none | Reset password `{ email }` |

`POST /api/auth/request` and `POST /api/auth/forgot` always answer `202 accepted`, even when the email does not match an account: the response never reveals whether the address exists. The review link emailed to the owner expires after **72 hours** and can be used once. Access requests, resets and password changes are rate-limited per network address and email address. If the email service is not configured, the response is `503` with code `MAIL_NOT_CONFIGURED`.

## Sites

| Method | Path | Access | Notes |
| :-- | :-- | :-- | :-- |
| GET | `/api/sites` | authenticated | Only the sites you belong to |
| POST | `/api/sites` | owner | `code`, `name`, `location`, `start_date`, `end_date` |
| GET | `/api/sites/{id}` | member | Site detail |
| GET | `/api/sites/{id}/members` | owner | Members and roles |
| POST | `/api/sites/{id}/members` | owner | `{ user_id, role }`; `role: null` removes |

## Tasks

| Method | Path | Access | Notes |
| :-- | :-- | :-- | :-- |
| GET | `/api/tasks?site_id=&status=` | member | Optional filters; `siteId` is accepted too |
| POST | `/api/tasks` | owner/editor/verifier | Supports `Idempotency-Key` |
| GET | `/api/tasks/{id}` | member | Includes the event history |
| POST | `/api/tasks/{id}/transition` | owner/editor/verifier | `{ to, note?, reason? }` |

## Diary

| Method | Path | Access | Notes |
| :-- | :-- | :-- | :-- |
| GET | `/api/diary?site_id=` | member | Site entries; `siteId` is accepted too |
| POST | `/api/diary` | owner/editor/verifier | One entry per site/date/shift |

Both lists accept `site_id` and `siteId`, because tasks and diary historically used the second name. An unexpected query parameter is rejected with `400 VALIDATION_ERROR` instead of being ignored: a mistyped filter never returns an unfiltered list.

## Project structure (WBS) and attendance (HR)

These areas are exposed **read-only**. Importing snapshots through dedicated endpoints is reserved to owners; the planning import in the interface also covers Time schedule and work days (see [planning export import](#planning-export-import)).

| Method | Path | Access | Notes |
| :-- | :-- | :-- | :-- |
| GET | `/api/wbs?site_id=` | member | Structure tree |
| GET | `/api/wbs?site_id=&flat=1` | member | Flat table |
| GET | `/api/wbs/{id}` | member | Node with immediate children |
| POST | `/api/wbs/import` | owner | Promotes a Time Schedule snapshot |
| GET | `/api/employees?site_id=` | member | Site employees |
| GET | `/api/employees/{id}` | member | Employee with their work days |
| GET | `/api/work-days?site_id=&employee_id=&from=&to=` | member | Attendance filtered by range |
| POST | `/api/employees/import` | owner | Promotes an attendance snapshot |

## Site progress

Progress items imported from the site system are visible in the **Site progress** view. Imported fields stay read-only; step completion is recorded in the application or via API.

| Method | Path | Access | Notes |
| :-- | :-- | :-- | :-- |
| GET | `/api/site-progress?site_id=&wbs_id=` | member | Site items; optional filter by WBS item |
| GET | `/api/site-progress/{id}` | member | Item with `booked_hours` (sum of booked hours) and its steps |
| POST | `/api/site-progress/import` | owner | Promotes a progress snapshot |
| GET | `/api/progress-types?site_id=` | member | Site progress types |
| POST | `/api/progress-types` | owner | Creates a type; step weights must total 100 |
| DELETE | `/api/progress-types/{id}` | owner | Deletes an unassigned type |
| PATCH | `/api/site-progress/{id}/progress-type` | owner | Assigns or removes a type (`progress_type_id`) |
| PUT | `/api/site-progress/{id}/steps` | owner/editor | `{ steps: [{ step_id, percent }] }`; appends a history record |

Each item reports description, PLC area, section, progress and planned progress, delta, assignee, planned and actual dates, expected delay and the `has_files`, `has_notes`, `has_deviations` flags. When the item is linked to a WBS node, the response also includes the node's `wbs_code` and `wbs_description`; without a link both fields are `null`. The item is linked to a WBS node only when PLC area and section identify **a single** node; in every other case the item stays unlinked.

A progress type is a list of steps with a weight. The weights must total **100**, otherwise creation is rejected with `WEIGHTS_NOT_100`. When an item has a type assigned, the returned progress is `computed` (weighted average of the steps); with no recorded step it is `0`, not the imported value. Every `PUT` inserts a row in `progress_entries`: the history is never rewritten and the curves are calculated from it.

## Deviations

Deviations are imported and available read-only in the interface; the endpoints return the same data.

| Method | Path | Access | Notes |
| :-- | :-- | :-- | :-- |
| GET | `/api/deviations?site_id=&status=&priority=` | member | Site list, with optional filters |
| GET | `/api/deviations/{id}` | member | Detail with the explicit links (`links`) |
| POST | `/api/deviations/import` | owner | Promotes a deviations snapshot |

The allowed statuses are `open`, `approved`, `in_progress`, `work_completed`, `closed`, `rejected`. An unknown or missing source status stays empty (`null`) and is counted during the import: it is never interpreted as `open`. Links point to `site_progress_item`, `work_day`, `task` or `diary`; the import neither creates nor deletes them on its own.

## Time bookings

Bookings are also recorded from the **Time bookings** view.

| Method | Path | Access | Notes |
| :-- | :-- | :-- | :-- |
| GET | `/api/time-bookings?site_id=&site_progress_item_id=&work_day_id=` | member | Site list, with optional filters |
| POST | `/api/time-bookings` | owner/editor | `{ work_day_id, site_progress_item_id, hours }` |
| DELETE | `/api/time-bookings/{id}` | owner/editor | Deletes a booking |

Hours are a finite, non-negative number. Attendance and progress item must belong to the **same site** (`TIME_BOOKING_SITE_MISMATCH`), and the same pair has a single booking (`TIME_BOOKING_DUPLICATE`).

## Cost impacts

| Method | Path | Access | Notes |
| :-- | :-- | :-- | :-- |
| GET | `/api/cost-impacts?site_id=&status=` | member | Site list, with status filter |
| GET | `/api/cost-impacts/{id}` | member | Detail with the linked deviations |
| POST | `/api/cost-impacts` | owner/editor/verifier | `{ site_id, title, deviation_ids, claim_amount?, settlement_amount? }` |
| POST | `/api/cost-impacts/{id}/transition` | owner/verifier | `{ to, result?, claim_amount?, settlement_amount? }` |

An impact always starts `open`, requires a title and **at least one deviation** of the same site. The statuses are `open`, `notification_sent`, `submitted`, `closed`; the allowed moves are `open → notification_sent`, `notification_sent → submitted`, `submitted → closed` and `open → closed`. Closing requires a result among `settled`, `dropped` and `rejected` and records the closing date; amounts can be updated during the transition.

## Tools

The tools register is the same one managed from the **Tools** view. Reading is open to every member of the site; writing to owners, editors and verifiers.

| Method | Path | Access | Notes |
| :-- | :-- | :-- | :-- |
| GET | `/api/tools?site_id=&company=` | member | Site register; optional, exact contractor filter |
| POST | `/api/tools` | owner/editor/verifier | `{ site_id, name, code?, company?, status?, location?, notes? }` |
| PATCH | `/api/tools/{id}` | owner/editor/verifier | Updates only the fields sent |
| DELETE | `/api/tools/{id}` | owner/editor/verifier | Deletes the row |

`name` is required, 1 to 120 characters. `code`, `company`, `location` and `notes` are free text, up to 10000 characters, and may be `null`. The status is `available`, `in_use`, `maintenance` or `retired`; when omitted on creation it is `available`. The list is sorted by contractor, with rows without a contractor last, then by name. There is no history: `DELETE` removes the row and leaves no copy.

## Overview and assistant

| Method | Path | Access | Notes |
| :-- | :-- | :-- | :-- |
| GET | `/api/dashboard?site_id=` | member | Four indicators, deviations by status, progress by section, hours per week |
| GET | `/api/report?site_id=` | member | Two tables: progress and deviations by macro-area |
| POST | `/api/assistant/chat` | member | `{ site_id, messages, view, language }`; read-only answer with citations |

The dashboard computes values from the site tables: deviations by status, average effective progress by section (with planned), hours per week and claim amounts. The per-section average also includes items without a progress type, using their imported value. The assistant answers in the requested language (`it` or `en`) and cites records with `family`, `id` and `label`; if the provider is not configured it returns `503 ASSISTANT_NOT_CONFIGURED`.

`/api/report` returns the data of the printable report: `site` with `code` and `name`, `generated_at` in UTC, `progress` and `deviations`. Each `progress` row has `area`, `items`, `actual`, `planned` and `source` (`computed`, `imported` or `mixed`); each `deviations` row has `area`, `total`, `open`, `closed` and `by_status` with `{ status, count }`. Deviations are grouped by PLC area (`plc_area`, otherwise `Senza sezione`) and sorted by total descending; `closed` adds `closed` and `rejected`, while a missing status stays open.

## planning export import

| Method | Path | Access | Notes |
| :-- | :-- | :-- | :-- |
| POST | `/api/import/preview` | owner/editor | `{ site_id, family, filename, data_base64 }`; writes nothing |
| POST | `/api/import/apply` | owner/editor | Same as above, plus `preview_token` |

`family` is `employees`, `work_days`, `time_schedule`, `site_progress_items`, `deviations` or `daily_log`. The file is an xlsx up to **20 MiB**, sent in base64. The preview returns the `added`, `updated`, `unchanged`, `removed`, `rejected` counts, samples of rejected rows and a `preview_token` valid for **15 minutes**. The application checks that the file and family match the preview; missing rows are never deleted and the applied `removed` count is always zero.

## Attachments

Attachments on **tasks and diary** can also be uploaded from the interface; for sites they stay API only. Removal is API only.

| Method | Path | Access | Notes |
| :-- | :-- | :-- | :-- |
| POST | `/api/attachments` | owner/editor | Upload a file (base64) |
| GET | `/api/attachments?site_id=&entity_type=&entity_id=` | member | Attachment metadata |
| GET | `/api/attachments/{id}` | member | Download the bytes |
| DELETE | `/api/attachments/{id}` | owner/editor | Delete |

Files up to **15 MiB** are accepted, images or PDF only (`UNSUPPORTED_MEDIA_TYPE`, `ATTACHMENT_TOO_LARGE`). Upload and deletion are reserved to owners and editors; reading to all members. Before registering the attachment the application reads the stored bytes back and compares the checksum: if it does not match, the file is removed and the response is `502`.

## Errors

Error responses have the shape `{ "error": "message", "code": "CODE" }`. The most common codes: `VALIDATION_ERROR` (400), `INVALID_CREDENTIALS` (401), `FORBIDDEN` (403), `NOT_FOUND` (404), `DUPLICATE_SITE_CODE` and `DUPLICATE_DIARY` (409), `INVALID_TRANSITION` (409), `SEPARATE_PEOPLE_REQUIRED` (400), `NOTE_REQUIRED`/`REASON_REQUIRED` (400), `TIME_BOOKING_DUPLICATE` (409), `WEIGHTS_NOT_100` (400), `TOOL_INVALID` (400), `TOOL_FORBIDDEN` (403), `TOOL_NOT_FOUND` (404), `FILE_TOO_LARGE` (413), `LINK_EXPIRED` (410), `ATTACHMENT_TOO_LARGE` (413), `UNSUPPORTED_MEDIA_TYPE` (415), `RATE_LIMITED` (429), `MAIL_NOT_CONFIGURED`/`MAIL_UNAVAILABLE` (503), `ASSISTANT_NOT_CONFIGURED` (503).

:::note
The API does not expose an OpenAPI schema: the tables above are the current contract. For the full data schema see `database/README.md` in the repository.
:::
