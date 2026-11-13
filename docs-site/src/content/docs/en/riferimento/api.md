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
| GET | `/api/sites/{id}/members` | owner | Members and roles, with emails |
| POST | `/api/sites/{id}/members` | owner | `{ user_id, role }`; `role: null` removes |
| GET | `/api/sites/{id}/assignable` | owner/editor/verifier | Active members with `user_id`, `name` and `role`, without emails |
| GET | `/api/member-access?site_id=` | member | Effective module access matrix, per member |
| PUT | `/api/member-access` | owner | `{ site_id, member_id, module, allowed }`; updates one access row |

`GET /api/member-access` returns `members`, each with `user_id`, `email`, `name`, `role` and `modules`, the map of modules with the effective value. `PUT` accepts the modules `overview`, `tasks`, `deviations`, `diary`, `progress`, `bookings`, `wbs`, `impacts`, `tools`, `certifications`, `hse` and `sites`; `overview` and `sites` stay always allowed and an owner cannot exclude themselves, otherwise the answer is `400 ACCESS_INVALID`. An excluded module answers `403 MODULE_FORBIDDEN` on reads and writes; the Overview, the report and the assistant do not read excluded modules.

## Tasks

| Method | Path | Access | Notes |
| :-- | :-- | :-- | :-- |
| GET | `/api/tasks?site_id=&status=&kind=` | member | Optional filters; `siteId` is accepted too |
| POST | `/api/tasks` | owner/editor/verifier | Supports `Idempotency-Key`; `kind` is `ordinary` (default) or `corrective` |
| GET | `/api/tasks/{id}` | member | Includes the event history |
| POST | `/api/tasks/{id}/transition` | owner/editor/verifier | `{ to, note?, reason? }` |

`POST /api/tasks` accepts the names `executor` and `verifier` together with the identifiers `executor_id` and `verifier_id`: the names stay on the task as a readable reference, the identifiers link it to accounts and are the ones that count for permissions. With identifiers, review and reopening belong to the designated reviewer or an owner; without identifiers — a task assigned by free name — only owners can do it. Executor and reviewer must remain two different people by identifier too, otherwise the answer is `400 SEPARATE_PEOPLE_REQUIRED`. `GET /api/sites/{id}/assignable` is the list the creation form uses: active members only, without emails, for owners, editors and verifiers; `/members` stays reserved to owners and keeps the emails.

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
| GET | `/api/site-progress/{id}` | member | Item with `booked_hours` (sum of booked hours), `planned_hours` and its steps |
| PATCH | `/api/site-progress/{id}` | owner/editor | `{ planned_hours }`: updates the planned hours only |
| POST | `/api/site-progress/import` | owner | Promotes a progress snapshot |
| GET | `/api/progress-types?site_id=` | member | Site progress types |
| POST | `/api/progress-types` | owner | Creates a type; step weights must total 100 |
| DELETE | `/api/progress-types/{id}` | owner | Deletes an unassigned type |
| PATCH | `/api/site-progress/{id}/progress-type` | owner | Assigns or removes a type (`progress_type_id`) |
| PUT | `/api/site-progress/{id}/steps` | owner/editor | `{ steps: [{ step_id, percent }] }`; appends a history record |

Each item reports description, PLC area, section, progress and planned progress, delta, assignee, planned and actual dates, expected delay, `planned_hours`, `booked_hours` and the `has_files`, `has_notes`, `has_deviations` flags. When the item is linked to a WBS node, the response also includes the node's `wbs_code` and `wbs_description`; without a link both fields are `null`. The item is linked to a WBS node only when PLC area and section identify **a single** node; in every other case the item stays unlinked. `planned_hours` is a number or `null`; when it is `null`, earned value uses the hours of the linked WBS node, when present.

A progress type is a list of steps with a weight. The weights must total **100**, otherwise creation is rejected with `WEIGHTS_NOT_100`. When an item has a type assigned, the returned progress is `computed` (weighted average of the steps); with no recorded step it is `0`, not the imported value. Every `PUT` inserts a row in `progress_entries`: the history is never rewritten and the curves are calculated from it.

`PATCH /api/site-progress/{id}` accepts only `{ planned_hours }`, with a number between **0** and **1000000** or `null` to fall back to the WBS node hours. Any other field is rejected with `VALIDATION_ERROR`; access is reserved to site owners and editors.

## Deviations

Deviations are imported and available read-only in the interface; the endpoints return the same data.

| Method | Path | Access | Notes |
| :-- | :-- | :-- | :-- |
| GET | `/api/deviations?site_id=&status=&priority=` | member | Site list, with optional filters |
| GET | `/api/deviations/{id}` | member | Detail with the explicit links (`links`) |
| POST | `/api/deviations/import` | owner | Promotes a deviations snapshot |
| GET | `/api/deviations/reconciliation?site_id=` | member | Checks on the site's dates |

The allowed statuses are `open`, `approved`, `in_progress`, `work_completed`, `closed`, `rejected`. An unknown or missing source status stays empty (`null`) and is counted during the import: it is never interpreted as `open`. Links point to `site_progress_item`, `work_day`, `task` or `diary`; the import neither creates nor deletes them on its own.

`GET /api/deviations/reconciliation` returns `counts` and `items`. `counts` holds the two checks — `closed_without_date` and `close_before_approval` — and `items` one row per finding, with `kind`, `id`, `deviation_no`, `title`, `official_status` and `disagreement_days`. Access to the `deviations` module is required and `site_id` is mandatory: if it is missing or not a UUID the response is `400 VALIDATION_ERROR`. Deviations are imported only and have no internal status and no status history: there is therefore no comparison between official and internal status, and `disagreement_days` stays `null` when the distance cannot be calculated.

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

`name` is required, 1 to 120 characters. `code`, `company`, `location` and `notes` are free text, up to 10000 characters, and may be `null`. The status is `available`, `in_use`, `maintenance` or `retired`; when omitted on creation it is `available`. The list is sorted by contractor, with rows without a contractor last, then by name. Deletion is **logical**: `DELETE` removes the row from the list, from the filters and from later reads, but keeps it in the [audit register](#audit-register).

## Fitness

Employee certifications are managed from the **Fitness** view. Reading is open to owners, editors and verifiers; writing to owners and editors. The `viewer` role has no access: certifications are personal records and the response is `403 CERT_FORBIDDEN`.

| Method | Path | Access | Notes |
| :-- | :-- | :-- | :-- |
| GET | `/api/certifications?site_id=&employee_id=&category=&status=&within=` | owner/editor/verifier | List with the computed status and days left |
| GET | `/api/certifications?site_id=&summary=1` | owner/editor/verifier | Only the counts by status and the total |
| POST | `/api/certifications` | owner/editor | `{ siteId, employeeId, name, category?, issuer?, issuedOn?, expiresOn?, outcome?, notes? }` |
| PATCH | `/api/certifications/{id}` | owner/editor | Updates only the fields sent |
| DELETE | `/api/certifications/{id}` | owner/editor | Deletes the row |

`site_id` is required on the list. The category is `qualification`, `medical`, `training` or `other`; when omitted on creation it is `other`. The status is `expired`, `expiring`, `valid` or `no_expiry` and is **computed**, not stored: `within` is the threshold in days for “expiring” (default **30**, from 0 to 365) and `days_left` is the difference in days between expiry and today, negative for expired certificates and `null` for certificates without an expiry date.

`name` is required, 1 to 120 characters; `issuer` allows up to 200 characters, `outcome` up to 500 and `notes` up to 2000. `issued_on` and `expires_on` are `YYYY-MM-DD` dates and the expiry cannot precede the issue date. The `employee_id` must belong to the site. Deletion is **logical**: the row leaves the lists, the counters and the details and stays in the [audit register](#audit-register). Dedicated codes: `CERT_INVALID` (400), `CERT_FORBIDDEN` (403), `CERT_NOT_FOUND` (404).

## HSE

The HSE register is managed from the **HSE** view. Reading is open to owners, editors and verifiers; writing to owners and editors. The `viewer` role has no access: the response is `403 HSE_FORBIDDEN`. The register is separate from the other modules and feeds neither the Overview nor the report.

| Method | Path | Access | Notes |
| :-- | :-- | :-- | :-- |
| GET | `/api/hse-events?site_id=&type=&severity=&from=&to=` | owner/editor/verifier | Site events, most recent first; optional filters |
| GET | `/api/hse-events?site_id=&summary=1` | owner/editor/verifier | Only the counts by type, by severity and the total |
| POST | `/api/hse-events` | owner/editor | `{ siteId, occurredOn, type, severity, eventNo?, location?, personsInvolved?, measures?, notes?, deviationId? }` |
| PATCH | `/api/hse-events/{id}` | owner/editor | Updates only the fields sent |
| DELETE | `/api/hse-events/{id}` | owner/editor | Deletes the row |

`site_id` is required on the list. `occurred_on` is required on creation and is a `YYYY-MM-DD` date; `type` is `near_miss`, `accident` or `observation`; `severity` is `low`, `medium` or `high`. `event_no` is optional, up to 120 characters, and **unique within the site** when present. `location` allows up to 200 characters, `measures` and `notes` up to 2000; `persons_involved` is an integer between 0 and 2147483647 and accepts no names. `deviation_id` is optional and must belong to the same site. The register holds no health data and has no relation to employees: it records facts, locations, measures and a count of people. Deletion is **logical**: the row leaves the lists, the counters and the details and stays in the [audit register](#audit-register). An `event_no` already used **stays reserved even after the row is logically deleted**: reusing it on another event returns `400 HSE_INVALID`, because the number identifies one event and must not move to another. Dedicated codes: `HSE_INVALID` (400), `HSE_FORBIDDEN` (403), `HSE_NOT_FOUND` (404).

## Audit register

Every creation, edit and deletion of an HSE event, a certificate or a tool leaves a row in the audit register, written in the same transaction as the write: if the write fails, no trail is saved.

| Method | Path | Access | Notes |
| :-- | :-- | :-- | :-- |
| GET | `/api/audit-events?site_id=&entity_type=&entity_id=` | owner/verifier | Rows, most recent first, paged with `limit` and `offset` |

`site_id` is required; `entity_type` is `hse_event`, `certification` or `tool`, and `entity_id` is the identifier of the row to trace. Access follows the site role: owners and verifiers read, editors and viewers do not, even when they are the ones writing the traced rows. There are no write routes: the register is append-only and cannot be edited or deleted through the API.

Each row carries `entity_type`, `entity_id`, `action` (`create`, `update`, `delete`), `at`, `actor` — the identifier of the user who wrote —, `actor_name` — the user's name, taken from the users table and `null` when the user is no longer present — and `changes`, a JSON object. On `create` it holds the filled fields of the created row; on `delete` the whole row as it was before; on `update` only the fields that changed, as `{ "field": { "from": …, "to": … } }`, without `id`, `site_id`, `created_at`, `updated_at` and `deleted_at`. An edit that changes no field is still recorded, with empty `changes`.

The interface uses the same endpoint in the **Latest changes** panel of the HSE, Fitness and Tools views, with `limit=20` and no `entity_id`; further pages are read with `offset`.

Deletion is therefore **logical** for all three types: the row disappears from the lists, the counters and the details and later reads return the module's “not found” code, but it stays readable in the audit register. Dedicated codes of the register: `AUDIT_INVALID` (400) for a non-UUID identifier, an unknown `entity_type` or invalid filters.

## Overview and assistant

| Method | Path | Access | Notes |
| :-- | :-- | :-- | :-- |
| GET | `/api/dashboard?site_id=` | member | Four indicators, earned value, deviations by status, progress by section, hours per week |
| GET | `/api/dashboard/layout?site_id=` | member | Personal layout: `widgets` and `custom` |
| PUT | `/api/dashboard/layout` | member | `{ site_id, widgets }`; saves the personal layout |
| DELETE | `/api/dashboard/layout?site_id=` | member | Restores the default layout |
| GET | `/api/report?site_id=` | member | Two tables and an earned value block: progress and deviations by macro-area |
| POST | `/api/assistant/chat` | member | `{ site_id, messages, view, language }`; read-only answer with citations |

The dashboard computes values from the site tables: deviations by status, average effective progress by section (with planned), hours per week, claim amounts and the `earnedValue` block. The per-section average also includes items without a progress type, using their imported value. The assistant answers in the requested language (`it` or `en`) and cites records with `family`, `id` and `label`; if the provider is not configured it returns `503 ASSISTANT_NOT_CONFIGURED`.

The Overview layout is personal per user and per site. `widgets` is a list of 1 to 11 distinct identifiers from the fixed catalogue: four indicators (`kpi_open_deviations`, `kpi_booked_hours`, `kpi_open_claims`, `kpi_settled_claims`) and seven panels (`deviations_by_status`, `progress_by_section`, `hours_by_week`, `earned_value`, `priority_work`, `daily_pulse`, `journal_today`). Without a saved layout the answer is the default with `custom: false`; an empty list, duplicates or unknown identifiers are rejected with `400 LAYOUT_INVALID`.

`/api/report` returns the data of the printable report: `site` with `code` and `name`, `generated_at` in UTC, `progress`, `deviations` and `earnedValue`. Each `progress` row has `area`, `items`, `actual`, `planned` and `source` (`computed`, `imported` or `mixed`); each `deviations` row has `area`, `total`, `open`, `closed` and `by_status` with `{ status, count }`. Deviations are grouped by PLC area (`plc_area`, otherwise `Senza sezione`) and sorted by total descending; `closed` adds `closed` and `rejected`, while a missing status stays open.

`earnedValue` has `available` (false when planned hours are missing, with `reason: "NO_PLANNED_HOURS"`), `bac_hours`, `ev_hours`, `pv_hours`, `ac_hours`, `cpi`, `spi`, `items_total`, `items_without_hours` and `by_section` (with `section`, `ev_hours`, `pv_hours`, `bac_hours` and `cpi`). BAC is the sum of the planned hours of the items or linked WBS nodes; `EV = BAC × actual progress / 100`, `PV = BAC × planned progress / 100`, `AC` is the sum of booked hours; `CPI = EV / AC` and `SPI = EV / PV`, `null` when the denominator is zero or missing.

## Planning export import

| Method | Path | Access | Notes |
| :-- | :-- | :-- | :-- |
| POST | `/api/import/preview` | owner/editor | `{ site_id, family, filename, data_base64 }`; writes nothing |
| POST | `/api/import/apply` | owner/editor | Same as above, plus `preview_token` |
| GET | `/api/import-mappings?site_id=` | owner/editor | One entry per family: `family`, `aliases`, `identity`, `custom`, `columns`, `required`, `fields` |
| PUT | `/api/import-mappings` | owner/editor | `{ site_id, family, aliases, identity }`; saves or replaces the mapping |
| DELETE | `/api/import-mappings/{family}?site_id=` | owner/editor | Removes the saved mapping and returns to the defaults |
| GET | `/api/import/template?family=` | authenticated user | xlsx template for the family: canonical headers and one example row |

`family` is `employees`, `work_days`, `time_schedule`, `site_progress_items`, `deviations` or `daily_log`. The file is an xlsx up to **20 MiB**, sent in base64. The preview returns the `added`, `updated`, `unchanged`, `removed`, `rejected` counts, samples of rejected rows and a `preview_token` valid for **15 minutes**. The application checks that file, family, rows and mapping match the preview; missing rows are never deleted and the applied `removed` count is always zero.

`GET /api/import/template` returns an xlsx file (`application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`, downloaded as `SiteAssistant-<family>-modello.xlsx`) with a single sheet: the first row holds the canonical headers of the family, the second an example row with made-up values. It needs no `site_id` and neither reads nor writes site data: any authenticated session is enough, whatever the role. A missing or unknown family is rejected with `400 UNKNOWN_FAMILY`. The response is `Cache-Control: private, no-store`.

The mapping is per site and family and also applies to API calls: `aliases` maps each field to a list of alternative headers, `identity` lists in order the fields that identify the row. Aliases must be unique, non-empty and at most **80 characters**; `identity` must contain at least one field, without duplicates. An invalid mapping is rejected with `MAP_INVALID`; an alias and a canonical column disagreeing on the same field with `AMBIGUOUS_COLUMNS`. If the mapping changes after the preview, confirmation is rejected with `PREVIEW_MISMATCH` (409).

## Attachments

Attachments on **tasks and diary** can also be uploaded from the interface; for sites they stay API only. Removal is API only.

| Method | Path | Access | Notes |
| :-- | :-- | :-- | :-- |
| POST | `/api/attachments` | owner/editor | Upload a file (base64) |
| GET | `/api/attachments?site_id=&entity_type=&entity_id=` | member | Attachment metadata |
| GET | `/api/attachments/{id}` | member | Download the bytes |
| DELETE | `/api/attachments/{id}` | owner/editor | Delete |

Files up to **15 MiB** are accepted, images or PDF only (`UNSUPPORTED_MEDIA_TYPE`, `ATTACHMENT_TOO_LARGE`). Upload and deletion are reserved to owners and editors; reading to all members. Before registering the attachment the application reads the stored bytes back and compares the checksum: if it does not match, the file is removed and the response is `502`.

## Request limits and pagination

Every request to `/api/` consumes a one-minute sliding-window limit: **600 requests per minute per authenticated session** and **60 per minute per network address** for anonymous requests. The four authentication routes (`/api/auth/login`, `/api/auth/forgot`, `/api/auth/password`, `/api/auth/request`) have their own limiter and do not consume the general one. Past the limit the response is `429 RATE_LIMITED` with a `Retry-After` header in seconds; `X-RateLimit-Remaining` says how many requests are left in the window. The values are changed with the `RATE_LIMIT_USER_PER_MIN` and `RATE_LIMIT_ANON_PER_MIN` variables.

The **tasks**, **diary**, **deviations**, **site progress**, **time bookings** and **audit register** lists accept `limit` (default **50**, maximum **200**) and `offset` (default 0). Non-integer or out-of-range values are rejected with `400 VALIDATION_ERROR`. The response stays an array; the total, the applied limit and the offset arrive in the `X-Total-Count`, `X-Limit` and `X-Offset` headers. The application asks for 200 rows on the views that load the whole list, so no view loses records.

## Errors

Error responses have the shape `{ "error": "message", "code": "CODE" }`. The most common codes: `VALIDATION_ERROR` (400), `INVALID_CREDENTIALS` (401), `FORBIDDEN` (403), `NOT_FOUND` (404), `DUPLICATE_SITE_CODE` and `DUPLICATE_DIARY` (409), `INVALID_TRANSITION` (409), `SEPARATE_PEOPLE_REQUIRED` (400), `NOTE_REQUIRED`/`REASON_REQUIRED` (400), `TIME_BOOKING_DUPLICATE` (409), `WEIGHTS_NOT_100` (400), `TOOL_INVALID` (400), `TOOL_FORBIDDEN` (403), `TOOL_NOT_FOUND` (404), `CERT_INVALID` (400), `CERT_FORBIDDEN` (403), `CERT_NOT_FOUND` (404), `HSE_INVALID` (400), `HSE_FORBIDDEN` (403), `HSE_NOT_FOUND` (404), `AUDIT_INVALID` (400), `FILE_TOO_LARGE` (413), `LINK_EXPIRED` (410), `MAP_INVALID` (400), `AMBIGUOUS_COLUMNS` (400), `PREVIEW_MISMATCH`/`PREVIEW_EXPIRED` (409), `ATTACHMENT_TOO_LARGE` (413), `UNSUPPORTED_MEDIA_TYPE` (415), `RATE_LIMITED` (429), `MAIL_NOT_CONFIGURED`/`MAIL_UNAVAILABLE` (503), `ASSISTANT_NOT_CONFIGURED` (503).

:::note
The API does not expose an OpenAPI schema: the tables above are the current contract. For the full data schema see `database/README.md` in the repository.
:::
