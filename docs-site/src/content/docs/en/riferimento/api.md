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

## Attachments

Attachments on tasks, diary and sites are available **only via API**; the interface does not expose them yet.

| Method | Path | Access | Notes |
| :-- | :-- | :-- | :-- |
| POST | `/api/attachments` | owner/editor | Upload a file (base64) |
| GET | `/api/attachments?site_id=&entity_type=&entity_id=` | member | Attachment metadata |
| GET | `/api/attachments/{id}` | member | Download the bytes |
| DELETE | `/api/attachments/{id}` | owner/editor | Delete |

## Errors

Error responses have the shape `{ "error": "message", "code": "CODE" }`. The most common codes: `VALIDATION_ERROR` (400), `INVALID_CREDENTIALS` (401), `FORBIDDEN` (403), `NOT_FOUND` (404), `DUPLICATE_SITE_CODE` and `DUPLICATE_DIARY` (409), `INVALID_TRANSITION` (409), `SEPARATE_PEOPLE_REQUIRED` (400), `NOTE_REQUIRED`/`REASON_REQUIRED` (400), `RATE_LIMITED` (429).

:::note
The API does not expose an OpenAPI schema: the tables above are the current contract. For the full data schema see `database/README.md` in the repository.
:::
