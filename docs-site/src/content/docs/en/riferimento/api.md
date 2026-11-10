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
| GET | `/api/tasks?siteId=&status=` | member | Optional filters |
| POST | `/api/tasks` | owner/editor/verifier | Supports `Idempotency-Key` |
| GET | `/api/tasks/{id}` | member | Includes the event history |
| POST | `/api/tasks/{id}/transition` | owner/editor/verifier | `{ to, note?, reason? }` |

## Diary

| Method | Path | Access | Notes |
| :-- | :-- | :-- | :-- |
| GET | `/api/diary?siteId=` | member | Site entries |
| POST | `/api/diary` | owner/editor/verifier | One entry per site/date/shift |

## Project structure (WBS) and attendance (HR)

These areas are exposed **read-only**; importing snapshots is reserved to owners and only happens via API.

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

Progress items imported from the site system are a **read-only** projection and do not have an interface view yet.

| Method | Path | Access | Notes |
| :-- | :-- | :-- | :-- |
| GET | `/api/site-progress?site_id=&wbs_id=` | member | Site items; optional filter by WBS item |
| GET | `/api/site-progress/{id}` | member | Item with `booked_hours` (sum of booked hours) |
| POST | `/api/site-progress/import` | owner | Promotes a progress snapshot |

Each item reports description, PLC area, section, progress and planned progress, delta, assignee, planned and actual dates, expected delay and the `has_files`, `has_notes`, `has_deviations` flags. The item is linked to a WBS node only when PLC area and section identify **a single** node; in every other case the item stays unlinked.

## Deviations

Deviations are imported too and stay **read-only** via API.

| Method | Path | Access | Notes |
| :-- | :-- | :-- | :-- |
| GET | `/api/deviations?site_id=&status=&priority=` | member | Site list, with optional filters |
| GET | `/api/deviations/{id}` | member | Detail with the explicit links (`links`) |
| POST | `/api/deviations/import` | owner | Promotes a deviations snapshot |

The allowed statuses are `open`, `approved`, `in_progress`, `work_completed`, `closed`, `rejected`. An unknown or missing source status stays empty (`null`) and is counted during the import: it is never interpreted as `open`. Links point to `site_progress_item`, `work_day`, `task` or `diary`; the import neither creates nor deletes them on its own.

## Time bookings

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

## Attachments

Attachments on tasks, diary and sites are available **only via API**; the interface does not expose them yet.

| Method | Path | Access | Notes |
| :-- | :-- | :-- | :-- |
| POST | `/api/attachments` | owner/editor | Upload a file (base64) |
| GET | `/api/attachments?site_id=&entity_type=&entity_id=` | member | Attachment metadata |
| GET | `/api/attachments/{id}` | member | Download the bytes |
| DELETE | `/api/attachments/{id}` | owner/editor | Delete |

Files up to **15 MiB** are accepted, images or PDF only (`UNSUPPORTED_MEDIA_TYPE`, `ATTACHMENT_TOO_LARGE`). Upload and deletion are reserved to owners and editors; reading to all members. Before registering the attachment the application reads the stored bytes back and compares the checksum: if it does not match, the file is removed and the response is `502`.

## Errors

Error responses have the shape `{ "error": "message", "code": "CODE" }`. The most common codes: `VALIDATION_ERROR` (400), `INVALID_CREDENTIALS` (401), `FORBIDDEN` (403), `NOT_FOUND` (404), `DUPLICATE_SITE_CODE` and `DUPLICATE_DIARY` (409), `INVALID_TRANSITION` (409), `SEPARATE_PEOPLE_REQUIRED` (400), `NOTE_REQUIRED`/`REASON_REQUIRED` (400), `TIME_BOOKING_DUPLICATE` (409), `LINK_EXPIRED` (410), `ATTACHMENT_TOO_LARGE` (413), `UNSUPPORTED_MEDIA_TYPE` (415), `RATE_LIMITED` (429), `MAIL_NOT_CONFIGURED`/`MAIL_UNAVAILABLE` (503).

:::note
The API does not expose an OpenAPI schema: the tables above are the current contract. For the full data schema see `database/README.md` in the repository.
:::
