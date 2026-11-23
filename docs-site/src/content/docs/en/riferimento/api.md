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

## Passkeys (WebAuthn)

The backend exposes the routes for **passkey** sign-in and the interface uses them: from the sign-in form you enter with **Sign in with a passkey** or **Use a passkey without email**, and the **Security** window in Settings lists, renames and deletes the account's passkeys. The service is not active until the server receives `WEBAUTHN_RP_ID` and `WEBAUTHN_ORIGIN`. Without those variables the routes answer `503 WEBAUTHN_NOT_CONFIGURED` and the application shows it as a message; the database tables added by the migration activate nothing on their own.

| Method | Path | Access | Notes |
| :-- | :-- | :-- | :-- |
| POST | `/api/auth/webauthn/register/options` | signed-in user | Registration options; the body is an empty JSON object |
| POST | `/api/auth/webauthn/register/verify` | signed-in user | Registers a passkey for the session user; answers `{ id, name }` |
| POST | `/api/auth/webauthn/login/options` | none | `{ email }` or `{ discoverable: true }` |
| POST | `/api/auth/webauthn/login/verify` | none | Verifies the passkey, sets the cookie and answers `{ user, assurance: "passkey" }` |
| GET | `/api/auth/credentials` | signed-in user | The user's passkeys: `id`, `credential_id`, `name`, `transports`, `created_at`, `last_used_at` |
| PATCH | `/api/auth/credentials/{id}` | signed-in user | `{ name }`, from 1 to 100 characters after trimming |
| DELETE | `/api/auth/credentials/{id}` | signed-in user | Deletes the passkey and revokes the sessions opened with it |

Registration and sign-in options return the browser options plus a server-generated `challenge_id`. The client must keep `challenge_id` separately: the credential response does not contain it. Verification is sent in the envelope `{ "challenge_id": "…", "response": { "id": "…", "response": {} } }`, where `response` is the complete browser response; without a UUID-shaped `challenge_id` or without `response.id` the answer is `400 VALIDATION_ERROR`. The challenge expires after **five minutes** and is consumed before cryptographic verification: an expired, already used or failed challenge answers `401 INVALID_CREDENTIALS`, without saying which. Registration excludes passkeys already enrolled by the user and requires user verification; sign-in verification requires the same verification and updates the credential counter, rejecting a counter that does not advance.

`login/options` accepts `{ email }` or `{ discoverable: true }`: the email never distinguishes upper and lower case, and an address without an account receives the same options shape, so the response never reveals whether the account exists. `login/verify` creates a session with `auth_method` `webauthn` and `assurance` `passkey`, lasting like the others: **7 days**. `DELETE` on a user's last remaining passkey answers `409 LAST_CREDENTIAL`, because a deleted passkey cannot be used to sign back in; another user's passkey, or an identifier that is not a UUID, answers `404 NOT_FOUND` or `400 VALIDATION_ERROR`. The routes consume the general request limit; `login/options` and `login/verify` also consume the sign-in attempt limit.

`register/verify` rechecks the session that requested the enrollment: if it has been revoked or has expired, the answer is `401 AUTH_REQUIRED` and the passkey is not registered. `PATCH` and `DELETE` make the same check on the request's session. A `401` on `login/options`, `login/verify` or `register/verify` is not an expired session for the interface: the sign-in form and the **Security** window stay open and show the message, without taking you back to the sign-in screen.

## Sites

| Method | Path | Access | Notes |
| :-- | :-- | :-- | :-- |
| GET | `/api/sites` | authenticated | Only the sites you belong to |
| POST | `/api/sites` | owner | `code`, `name`, `location`, `start_date`, `end_date`, `jurisdiction`, `time_zone`, `day_cutoff_time` |
| GET | `/api/sites/{id}` | member | Site detail |
| PATCH | `/api/sites/{id}` | owner | Updates one or more of `jurisdiction`, `time_zone` and `day_cutoff_time` |
| GET | `/api/sites/{id}/members` | owner | Members and roles, with emails |
| POST | `/api/sites/{id}/members` | owner | `{ user_id, role }`; `role: null` removes |
| GET | `/api/sites/{id}/assignable` | owner/editor/verifier | Active members with `user_id`, `name` and `role`, without emails |
| GET | `/api/member-access?site_id=` | member | Effective module access matrix, per member |
| PUT | `/api/member-access` | owner | `{ site_id, member_id, module, allowed }`; updates one access row |

Every site declares a **jurisdiction**, `IT` or `UK`: it is the law that applies to the site and does not depend on the interface language. If `POST /api/sites` omits it the value is `IT`, which is also the value of rows created before the field existed. `GET /api/sites` and `GET /api/sites/{id}` return `jurisdiction`, `time_zone` and `day_cutoff_time`. Both are optional on creation. The default time zone is `Europe/Rome` for `IT` and `Europe/London` for `UK`. The default cutoff is `06:00`.

`PATCH /api/sites/{id}` is restricted to owners and accepts one or more of `jurisdiction` (`IT` or `UK`), `time_zone` (IANA identifier) and `day_cutoff_time` (local time in `HH:MM` format). Omitted fields keep their current values. An empty body, unknown field or invalid value returns `400 VALIDATION_ERROR`. Saving writes an `update` event with `entity_type` `site` to the audit log. The jurisdiction is set through the API.

`GET /api/member-access` returns `members`, each with `user_id`, `email`, `name`, `role` and `modules`, the map of modules with the effective value. `PUT` accepts the modules `overview`, `tasks`, `deviations`, `diary`, `progress`, `bookings`, `wbs`, `impacts`, `tools`, `certifications`, `hse`, `sites`, `logistics`, `reporting`, `workforce_names` and `workforce_presence`; `overview` and `sites` stay always allowed and an owner cannot exclude themselves, otherwise the answer is `400 ACCESS_INVALID`. An excluded module answers `403 MODULE_FORBIDDEN` on reads and writes; the Overview, the report and the assistant do not read excluded modules.

`logistics`, `workforce_names` and `workforce_presence` require an explicit grant with `allowed: true` for a member who is not an owner. Other modules are allowed by default. Site owners always have access to all modules. An owner can grant access in [Module access](../../amministrazione/utenti-e-ruoli/#module-access) or through the API.

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

`POST /api/diary` uses the site's time zone and cutoff. Omit `operational_date` and `shift` to have the server assign both when it records the entry. If you supply a date and omit the shift, the server assigns the current shift. To record a specific date and shift, send `operational_date` in `YYYY-MM-DD` format and `shift` as `day` or `night`. Any supplied `time_zone` and `day_cutoff_time` must match the site settings, otherwise the response is `400 VALIDATION_ERROR`. The entry records both settings when it is created.

Both lists accept `site_id` and `siteId`, because tasks and diary historically used the second name. An unexpected query parameter is rejected with `400 VALIDATION_ERROR` instead of being ignored: a mistyped filter never returns an unfiltered list.

## Project structure (WBS) and attendance (HR)

These areas are exposed **read-only**. Importing snapshots through dedicated endpoints is reserved to owners; the planning import in the interface also covers Time schedule and work days (see [planning export import](#planning-export-import)).

| Method | Path | Access | Notes |
| :-- | :-- | :-- | :-- |
| GET | `/api/wbs?site_id=` | member | Structure tree |
| GET | `/api/wbs?site_id=&flat=1` | member | Flat table |
| GET | `/api/wbs/{id}` | member | Node with immediate children |
| POST | `/api/wbs/import` | owner | Promotes a Time Schedule snapshot |
| GET | `/api/employees?site_id=` | member with `workforce_names` | Site employees |
| GET | `/api/employees/{id}` | member with `workforce_names` | Employee with their work days |
| GET | `/api/work-days?site_id=&employee_id=&from=&to=` | member with `workforce_names` | Attendance filtered by range |
| POST | `/api/employees/import` | owner | Promotes an attendance snapshot |

The snapshot import through `POST /api/employees/import` classifies the shift using the local start time and the site's cutoff. The operational date and times are kept as supplied by the source.

### Hours summary and site attendance

| Method | Path | Access | Notes |
| :-- | :-- | :-- | :-- |
| GET | `/api/workforce/summary?site_id=&group_by=&from=&to=` | member with `bookings` | Source hours grouped by `company`, `day` or `period` |
| GET | `/api/workforce/presence?site_id=&date=` | member with `workforce_presence` | Scheduled attendance for one operational day |

Both endpoints require `site_id` as a UUID and valid dates in `YYYY-MM-DD` format. The summary requires `group_by`, `from` and `to`. The inclusive range must span 1 to 366 days. Invalid parameters return `400 VALIDATION_ERROR`.

The summary returns an array of `group_key`, `work_time`, `open_hours` and `booked_hours` values. The key is the company (or `null` if unavailable), operational date or `from/to` range. A source total is `null` if any work day in the group lacks that value. An empty range returns an empty array.

Attendance requires `date` and returns `first_name`, `last_name`, `company`, `shift`, `start_time` and `finish_time` for work days linked to employees. The response contains no employee IDs or worked-hour totals.

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
| GET | `/api/progress/curve?site_id=&from=&to=` | member with `progress` | Curve by section and calendar day |

Each item reports description, PLC area, section, progress and planned progress, delta, assignee, planned and actual dates, expected delay, `planned_hours`, `booked_hours` and the `has_files`, `has_notes`, `has_deviations` flags. When the item is linked to a WBS node, the response also includes the node's `wbs_code` and `wbs_description`; without a link both fields are `null`. The item is linked to a WBS node only when PLC area and section identify **a single** node; in every other case the item stays unlinked. `planned_hours` is a number or `null`; when it is `null`, earned value uses the hours of the linked WBS node, when present.

A progress type is a list of steps with a weight. The weights must total **100**, otherwise creation is rejected with `WEIGHTS_NOT_100`. When an item has a type assigned, the returned progress is `computed` (weighted average of the steps); with no recorded step it is `0`, not the imported value. Every `PUT` inserts a row in `progress_entries`: the history is never rewritten and the curves are calculated from it.

`GET /api/progress/curve` groups recordings and timestamped planned dates by calendar day in the site's time zone. A value stored as a date alone keeps its original day. If `to` is omitted, the range ends on the current local date. If `from` is omitted, the range covers 90 days inclusive. The range can cover up to 400 days. Supply date bounds in `YYYY-MM-DD` format.

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

Bookings are also recorded from the **Time bookings** view. All three endpoints require both `bookings` and `workforce_names` in addition to the site roles below.

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

## Purchase orders

**Purchase orders** record what the site ordered from a supplier, with one line per ordered item, and follow its execution. They are managed in the **Procurement** view (see [Procurement](../../moduli/logistica/)) and through the API. The `logistics` module is required and is off by default (see [Sites](#sites)), while site owners always have it. With the module granted, every site role reads, `viewer` included; owners and editors write. The demo sites contain two orders per site, with lines in the four line statuses.

| Method | Path | Access | Notes |
| :-- | :-- | :-- | :-- |
| GET | `/api/purchase-orders?site_id=&status=` | member with the `logistics` module | Site list in creation order; optional status filter |
| POST | `/api/purchase-orders` | owner/editor | `{ siteId, poNo, supplierName, orderedOn, notes? }`; answers `201` |
| GET | `/api/purchase-orders/{id}` | member with the `logistics` module | Order with its lines in `items`, in `lineNo` order |
| PATCH | `/api/purchase-orders/{id}` | owner/editor | `{ supplierName?, orderedOn?, notes? }` |
| POST | `/api/purchase-orders/{id}/status` | owner/editor | `{ status, note? }` |
| POST | `/api/purchase-orders/{id}/items` | owner/editor | `{ lineNo?, materialNo?, description, unit?, quantity, wbsId? }`; answers `201` |
| PATCH | `/api/purchase-orders/{id}/items/{itemId}` | owner/editor | Updates only the fields sent for the line |
| POST | `/api/purchase-orders/{id}/items/{itemId}/status` | owner/editor | `{ status }` |

`site_id` is required and must be a UUID; the list accepts that name only, not `siteId`, and an unknown status answers `400 VALIDATION_ERROR`. `poNo` is required, up to 80 characters and **unique within the site** (`409 PO_DUPLICATE_NUMBER`). `supplierName` is required up to 200 characters, `orderedOn` is a `YYYY-MM-DD` date, `notes` reaches 10000 characters and an empty string means `null`. An order starts `open` and with no lines; `PATCH` changes supplier, date and notes and ignores the other fields: number and status are not changed there.

On lines, `description` is required up to 500 characters, `materialNo` reaches 10000, `unit` 20, and `quantity` is positive, up to **999999999.999**, with at most three decimals. `lineNo` is a positive integer and unique within the order (`409 PO_DUPLICATE_LINE`); when missing it is the last number plus one. `wbsId` is optional and must belong to the order's site.

Order statuses are `open`, `template_generated`, `in_execution`, `completed` and `not_relevant`; line statuses are `open`, `in_execution`, `completed` and `not_relevant`. Line transitions are `open → in_execution`, `in_execution → completed` and the step to `not_relevant` from a non-final status; a final line no longer changes and answers `409 PO_STATUS_CONFLICT`. `executionStartedOn`, `completedOn` and `notRelevantOn` are written by themselves with the day of the step, in UTC.

The order status updates by itself when its lines change: `in_execution` if at least one line is in execution, `not_relevant` if all are not relevant, `completed` if all are final, otherwise it stays `open` — or `template_generated` if the order has already been through that status. From the status route the order moves to `template_generated` only from `open`, to `completed` only when every line is final and to `not_relevant` only when every line is not relevant; `in_execution` is not set by hand. A final order no longer changes status, and `closedAt` is written only by the explicit closure.

Order transitions accept an optional `note`, which ends up in `changes.note` of the audit row. There are no `DELETE` routes: an order and its lines are not deleted. Dedicated codes: `PO_NOT_FOUND` (404), `PO_ITEM_NOT_FOUND` (404), `PO_DUPLICATE_NUMBER` (409), `PO_DUPLICATE_LINE` (409), `PO_STATUS_CONFLICT` (409).

## Packages

A **package** groups the lines of one order into a shipping unit and records how much of each was packed: it is the step between the order and the shipment. It is also read and written from the **Procurement** view, **Packages** tab (see [Procurement](../../moduli/logistica/#packages)); the same data stays available here. The `logistics` module is required, as for orders; every site role reads, `viewer` included, and owners and editors write.

| Method | Path | Access | Notes |
| :-- | :-- | :-- | :-- |
| GET | `/api/packages?site_id=&purchase_order_id=` | member with the `logistics` module | Site packages in creation order; optional filter by order |
| POST | `/api/packages` | owner/editor | `{ siteId, purchaseOrderId, packageNo?, notes?, items }`; answers `201` |
| GET | `/api/packages/{id}` | member with the `logistics` module | Package with its packed lines in `items` |
| POST | `/api/packages/{id}/close` | owner/editor | Closes the package; no body |

`site_id` is required and must be a UUID; `purchase_order_id` narrows the list to one order. `packageNo` is optional, up to 80 characters and **unique within the order**: when missing, the service assigns the first free number in the form `PKG-001`, `PKG-002` and so on, counting only the numbers already in that form. A number already used answers `409 PACKAGE_DUPLICATE_NUMBER`. `notes` reaches 10000 characters.

`items` is required and holds at least one `{ purchaseOrderItemId, quantityPacked }`: each order line appears **once** in the package and `quantityPacked` is positive, up to **999999999.999**, with at most three decimals. The line must belong to the given order, otherwise the answer is `404 PACKAGE_ITEM_NOT_FOUND`. The sum of the packed quantities of a line, across **all** the order's packages, cannot exceed the ordered quantity: a larger total answers `400 PACKAGE_QUANTITY_EXCEEDED` and leaves no partial rows. The package starts `open`.

The first package that packs a still `open` line moves it to `in_execution` with the day of the operation as `executionStartedOn`; lines already started, completed or not relevant do not change, and an existing start date stays as it is. After the insert the order status is recomputed with the same rules as orders. `POST /api/packages/{id}/close` moves the package to `closed` and writes `closedAt`; closing it again answers `409 PACKAGE_STATUS_CONFLICT`. There are no `DELETE` routes: a package is not deleted. Every package, every packed line and the possible line status change leave a row in the [audit register](#audit-register). Dedicated codes: `PACKAGE_NOT_FOUND` (404), `PACKAGE_ITEM_NOT_FOUND` (404), `PACKAGE_DUPLICATE_NUMBER` (409), `PACKAGE_STATUS_CONFLICT` (409), `PACKAGE_QUANTITY_EXCEEDED` (400).

## Shipments

A **shipment** groups one or more packages and follows their journey, with the receipts of what arrives. It is also read and written from the **Procurement** view, **Shipments** tab (see [Procurement](../../moduli/logistica/#shipments)); the same data stays available here. The `logistics` module is required; every site role reads, `viewer` included, and owners and editors write.

| Method | Path | Access | Notes |
| :-- | :-- | :-- | :-- |
| GET | `/api/shipments?site_id=&status=` | member with the `logistics` module | Site shipments in creation order; optional status filter |
| POST | `/api/shipments` | owner/editor | `{ siteId, shipmentNo, carrier?, shippedOn?, expectedOn?, notes?, packageIds }`; answers `201` |
| GET | `/api/shipments/{id}` | member with the `logistics` module | Shipment with `packages` and `receipts` |
| POST | `/api/shipments/{id}/status` | owner/editor | `{ status, note? }` |
| POST | `/api/shipments/{id}/receipts` | owner/editor | `{ purchaseOrderItemId, quantityReceived, note? }`; answers `201` |

`shipmentNo` is required, up to 80 characters and **unique within the site** (`409 SHIPMENT_DUPLICATE_NUMBER`); `carrier` reaches 200 characters, `notes` 10000. `shippedOn` and `expectedOn` are optional `YYYY-MM-DD` dates. `packageIds` is required, with at least one package, each once: the packages must belong to the shipment's site (`400 SHIPMENT_PACKAGE_SITE_MISMATCH`) and a package can be in **one** shipment only (`409 SHIPMENT_PACKAGE_TAKEN`). The shipment starts `planned`.

The statuses are `planned`, `in_transit`, `arrived` and `received`, and they advance **one step at a time**: a jump or a step back answers `409 SHIPMENT_STATUS_CONFLICT`. The step to `arrived` writes `arrivedOn` with the current day; `received` requires at least one receipt already recorded. The transition accepts an optional `note`, which ends up in `changes.note` of the audit row.

**Receipts** record how much of an ordered line arrived: `purchaseOrderItemId` must be a line **contained in one of the shipment's packages** — a `package_items` entry of those packages —, otherwise the answer is `404 SHIPMENT_ITEM_NOT_FOUND`; a shipment already `received` refuses new receipts with `409 SHIPMENT_STATUS_CONFLICT`. In addition `quantityReceived` is **non-negative** — zero is allowed — up to 999999999.999 with at most three decimals, and `note` is optional. A receipt does not change the ordered line's status: it stays a shipment record and is read in `receipts`. There are no `DELETE` routes: a shipment is not deleted and a receipt is not cancelled. Dedicated codes: `SHIPMENT_NOT_FOUND` (404), `SHIPMENT_ITEM_NOT_FOUND` (404), `SHIPMENT_DUPLICATE_NUMBER` (409), `SHIPMENT_PACKAGE_TAKEN` (409), `SHIPMENT_STATUS_CONFLICT` (409), `SHIPMENT_PACKAGE_SITE_MISMATCH` (400).

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

`site_id` is required on the list. `occurred_on` is required on creation and is a `YYYY-MM-DD` date; `type` is `near_miss`, `accident`, `observation`, `inspection` or `external_visit`; `severity` is `low`, `medium` or `high`. The two types `inspection` and `external_visit` are the ones the application writes by itself when an HSE inspection is recorded (see [HSE inspections](#hse-inspections)): on write, with `POST` and `PATCH`, only `near_miss`, `accident` and `observation` are accepted, and any other value returns `400 HSE_INVALID`. The manual entry form offers the same three types, while the **Type** filter of the view offers all five.

The `summary=1` reply counts all five types: `by_type` always carries `inspection` and `external_visit`, at zero when the site has no inspections, together with `by_severity` and `total`. The **Total** counter in the view counts every row, including those born from inspections. `event_no` is optional, up to 120 characters, and **unique within the site** when present. `location` allows up to 200 characters, `measures` and `notes` up to 2000; `persons_involved` is an integer between 0 and 2147483647 and accepts no names. `deviation_id` is optional and must belong to the same site. The register holds no health data and has no relation to employees: it records facts, locations, measures and a count of people. Deletion is **logical**: the row leaves the lists, the counters and the details and stays in the [audit register](#audit-register). An `event_no` already used **stays reserved even after the row is logically deleted**: reusing it on another event returns `400 HSE_INVALID`, because the number identifies one event and must not move to another. Events accept images and PDFs: access, rules and the read trail are in [Attachments](#attachments). Every row of the list also carries `inspection_id` and `asset_id`: they are the inspection and the subject the row was born from, and are `null` for the three manual types. The interface uses them for the **Open the inspection** command; filters, ordering and the summary do not change. Dedicated codes: `HSE_INVALID` (400), `HSE_FORBIDDEN` (403), `HSE_NOT_FOUND` (404).

## HSE assets and the inspection catalogue

**HSE assets** are what the site has to inspect: tools, site works and personal protective equipment. They are created and edited from the **Inspections** view of the HSE section; deletion is API only. Reading is open to every site member, `viewer` included; writing is reserved to **owners** and **editors**. The `hse` module is required, on reads and writes alike: a member excluded from the module receives `403 MODULE_FORBIDDEN`.

| Method | Path | Access | Notes |
| :-- | :-- | :-- | :-- |
| GET | `/api/hse/assets?siteId=` | member | Site list, without the deleted rows |
| POST | `/api/hse/assets` | owner/editor | `{ siteId, templateCode, name, code?, notes?, toolId?, active? }` |
| PATCH | `/api/hse/assets/{id}` | owner/editor | Updates only the fields sent |
| DELETE | `/api/hse/assets/{id}` | owner/editor | Deletes the row |
| GET | `/api/hse/inspection-templates?siteId=` | member | Catalogue of the templates for the site's jurisdiction |

`siteId` is required and must be a UUID. `templateCode` is required and must belong to the catalogue of the **site's jurisdiction**: a template from the other jurisdiction returns `400 TEMPLATE_JURISDICTION_MISMATCH`, an unknown or missing code `400 VALIDATION_ERROR`. `name` is required, between 1 and 200 characters and **unique within the site** after trimming: a name already in use returns `409 DUPLICATE_ASSET_NAME`. `code` allows up to 60 characters, `notes` up to 2000, and an empty string becomes `null`. `active` is a boolean and is `true` when missing. `toolId` is optional and must reference a non-deleted tool of the **same site**.

`kind` and `category` are not sent: if they appear in the body they are ignored, because they are **derived from the template**. `kind` is `tool`, `site_work` or `ppe`; `category` is the template's (`lifting`, `lifting_accessories`, `ppe`, `scaffolding`). The list is ordered by category and name, excludes deleted rows and enriches each row with `templateTitle` and `jurisdiction`.

Every row of the list also states where the inspection stands, with four computed fields: `lastInspectionOn` is the date of the latest inspection, `lastOutcome` its outcome (`pass`, `pass_with_notes` or `fail`), `nextDueOn` its due date; all three are `null` when the asset has never been inspected. `status` sums the situation up in one value, in this order: `never` when there is no inspection, `failed` when the last outcome is `fail`, `overdue` when `nextDueOn` is earlier than today, `due_soon` when it falls within the next **30 days** (today included), `ok` in every other case, a positive outcome without a due date included. The "latest inspection" is the one with the later date, then the later creation time, then the higher identifier; dates are compared on the server calendar. The four fields are on the list only: `GET /api/hse/assets/{id}` returns the row without them. Deletion is **logical**: the row leaves the lists and later reads return `404 HSE_ASSET_NOT_FOUND`, but it stays in the audit register; the name becomes available again for a new asset and, to free the constraint, the deleted row is renamed to `<name> (deleted <id>)`.

The catalogue returns `{ jurisdiction, templates }`, with only the families of the site's jurisdiction. Each template has `code`, `jurisdiction`, `kind`, `category`, `title`, `reference`, `intervalMonths`, `draft` and `items`, where each item has `code` and `label`: they are **visual checks**, not instrumental tests.

| Code | Jurisdiction | Family | Interval | Reference |
| :-- | :-- | :-- | :-- | :-- |
| `it_lifting` | IT | Lifting equipment | 24 months | D.Lgs. 81/2008, Allegato VII |
| `it_ppe` | IT | Personal protective equipment | 12 months | D.Lgs. 81/2008, Titolo III, Capo II |
| `it_scaffolding` | IT | Scaffolding | 3 months | D.Lgs. 81/2008, Titolo IV |
| `uk_lifting` | UK | Lifting equipment | 12 months | LOLER 1998 |
| `uk_lifting_accessories` | UK | Lifting accessories | 6 months | LOLER 1998 |
| `uk_ppe` | UK | Personal protective equipment | 12 months | PPE at Work Regulations 1992 |
| `uk_scaffolding` | UK | Scaffolding | 3 months | Work at Height Regulations 2005 |

Today every template is `draft: true`: they are drafts, not yet enabled. Every site role can read the catalogue; a site that does not exist returns `404 SITE_NOT_FOUND`, and reading leaves no rows in the audit register. Dedicated asset codes: `VALIDATION_ERROR` (400), `TEMPLATE_JURISDICTION_MISMATCH` (400), `DUPLICATE_ASSET_NAME` (409), `HSE_ASSET_NOT_FOUND` (404).

## HSE inspections

An **HSE inspection** records the outcome of the checks on an HSE asset on a given date. One inspection is one row, and every template item is a row of its own: the inspection keeps the label of each check as it was in the template on the day it was filled in, so a later change to the template cannot rewrite a past inspection. They are recorded from the subject page in the interface **Inspections** view (see [HSE](../../moduli/hse/#recording-an-inspection)) and through the API; they are read from the API and from the subject page, which shows state, history and individual checks (see [HSE](../../moduli/hse/#opening-a-subject-state-history-and-checks)). Every site member reads, `viewer` included; **owners** and **editors** write. The `hse` module is required, on reads and writes alike.

| Method | Path | Access | Notes |
| :-- | :-- | :-- | :-- |
| GET | `/api/hse/inspections?siteId=&assetId=` | member | Site list, most recent inspection date first |
| POST | `/api/hse/inspections` | owner/editor | `{ siteId, assetId, performedOn, performedBy, performerRole?, mode, outcome, notes?, nextDueOn?, items }` |
| GET | `/api/hse/inspections/{id}` | member | Inspection with the check items and the asset |

`siteId` is required and must be a UUID. `assetId` is required: the asset must belong to the same site and must not be deleted, otherwise the response is `404 ASSET_NOT_FOUND`. `performedOn` is required and is a `YYYY-MM-DD` date. `performedBy` is required, between 1 and 200 characters after trimming; `performerRole` is optional. `mode` is `internal` or `external`, `outcome` is `pass`, `pass_with_notes` or `fail`: both are required. `notes` is optional.

`items` must contain **every template item exactly once**: a missing or repeated item returns `400 INSPECTION_ITEMS_INCOMPLETE`, a code the template does not have `400 INSPECTION_ITEMS_UNKNOWN`, a `result` other than `ok`, `not_ok` or `na` `400 VALIDATION_ERROR`. `label` and `position` are not sent: the label and the order are the template's. One rejected check cancels the whole inspection: no partial rows and no audit entries are left behind.

`nextDueOn` is optional. When it is missing, the due date is the inspection date plus the template interval, with the day clamped to the last day of the month when it does not exist (31 January plus 24 months is 31 January; 31 August plus 6 months is 28 February, or 29 in a leap year). `nextOn` is accepted as an alias; if both arrive with different values the response is `400 VALIDATION_ERROR`. An explicit `nextDueOn` counts as a choice: to keep the date computed from the template, omit the field.

`GET /api/hse/inspections` requires `siteId`; `assetId` narrows the list to one asset and must belong to the same site. `GET /api/hse/inspections/{id}` returns the row with `items`, in template order, and the asset. An inspection stays readable after the logical deletion of the asset: it is site history, not a property of the asset.

Recording an inspection also writes a **row in the HSE register**: type `inspection` for an internal check, `external_visit` for an external one; severity `high` for a `fail` outcome, `medium` for `pass_with_notes`, `low` for `pass`; `occurred_on` is the inspection date, `location` the asset code (its name when the code is missing) and `notes` the asset name followed by the template title. The row leaves `event_no`, `persons_involved`, `measures` and `deviation_id` at `null`, is created in the same transaction as the inspection, writes its own audit entry, and its identifier comes back on the inspection as `hse_event_id`. An `hseEventId` sent in the body is ignored: the register is not attached to an event chosen by the client. If either write or either audit entry fails, nothing is left behind: no register row, no inspection, no check items.

Inspections are neither edited nor deleted: there are no `PATCH` or `DELETE` routes, and a correction is a new inspection. Dedicated codes: `VALIDATION_ERROR` (400), `INSPECTION_ITEMS_INCOMPLETE` (400), `INSPECTION_ITEMS_UNKNOWN` (400), `ASSET_NOT_FOUND` (404), `INSPECTION_NOT_FOUND` (404).

## Audit register

Every creation, edit and deletion of an HSE event, a certificate, a tool from the register or an HSE asset, every HSE inspection recorded, every write on a purchase order or one of its lines, on a package, on a shipment or on a receipt — and every change of a site's jurisdiction — leaves a row in the audit register, written in the same transaction as the write: if the write fails, no trail is saved. In addition, every download of an attachment on an HSE event or inspection leaves a `read` row: it is written outside the download, so if it fails the file is served anyway and the error stays in the logs.

| Method | Path | Access | Notes |
| :-- | :-- | :-- | :-- |
| GET | `/api/audit-events?site_id=&entity_type=&entity_id=` | owner/verifier | Rows, most recent first, paged with `limit` and `offset` |

`site_id` is required; `entity_type` is `hse_event`, `certification`, `tool`, `hse_asset`, `hse_inspection`, `purchase_order`, `purchase_order_item`, `package`, `package_item`, `shipment`, `shipment_receipt` or `site`, and `entity_id` is the identifier of the row to trace. For `site` the row concerns the site itself: `entity_id` is its identifier and `site_id` coincides with it, and the only change traced today is the jurisdiction change. For `purchase_order_item` the `entity_id` is the line's own and `site_id` is the order's site, because the line has none of its own. Access follows the site role: owners and verifiers read, editors and viewers do not, even when they are the ones writing the traced rows. There are no write routes: the register is append-only and cannot be edited or deleted through the API. An HSE inspection produces two `create` rows: one with `entity_type` `hse_inspection` and one with `entity_type` `hse_event`, for the register row born with the inspection. No route edits or deletes an inspection, so no `update` or `delete` rows appear with `entity_type` `hse_inspection`. Purchase orders, lines, packages, shipments and receipts are not deleted either: no `delete` rows appear for those `entity_type` values.

Each row carries `entity_type`, `entity_id`, `action` (`create`, `update`, `delete`, `read`), `at`, `actor` — the identifier of the user who wrote —, `actor_name` — the user's name, taken from the users table and `null` when the user is no longer present — and `changes`, a JSON object. On `create` it holds the filled fields of the created row; on `delete` the whole row as it was before; on `update` only the fields that changed, as `{ "field": { "from": …, "to": … } }`, without `id`, `site_id`, `created_at`, `updated_at` and `deleted_at`. On `read` it holds `{ "attachment": { "id": …, "filename": … } }`, with `entity_type` `hse_event` or `hse_inspection` and the `entity_id` of the event or inspection: it describes only the object opened, with no copy of the row and no data about people. The metadata list (`GET /api/attachments`) does not write a read. An edit that changes no field is still recorded, with empty `changes`. Purchase order transitions also write the `note` sent into `changes`, when there is one.

The interface uses the same endpoint in the **Latest changes** panel of the HSE, Fitness and Tools views, with `limit=20` and no `entity_id`; further pages are read with `offset`. Reads of HSE event attachments appear in the panel as the `read` action, with the file name; reads of inspection attachments do not, because the panel filters events, and are read with `entity_type=hse_inspection`.

Deletion is therefore **logical** for the four deletable types — HSE events, certificates, tools from the register and HSE assets: the row disappears from the lists, the counters and the details and later reads return the module's “not found” code, but it stays readable in the audit register. Dedicated codes of the register: `AUDIT_INVALID` (400) for a non-UUID identifier, an unknown `entity_type` or invalid filters.

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

The dashboard includes `workDays` (only `operationalDate` and `workTime`, preserving `null`) and `hoursCoverage`: full-period app bookings (`appBookedHours`), booking operational date bounds (`bookedFrom`, `bookedTo`), workday count (`workDays`) and days with source hours (`sourceWorkDays`). `sourceWorkTime` is a total only when every workday has source hours; otherwise it is `null`. `knownSourceWorkTime` sums known days only, or is `null` when none are known. Each week in `hours` exposes `hours` for display and `hoursExact` for calculations: the window total is the sum of `hoursExact` over the displayed weeks. These facts cover all site workdays, including days without bookings. Missing hours are never replaced with zero. The KPI keeps the last six available weeks; the full-period total and hours outside the window are shown separately. `earnedValue` calculations are unchanged and use all app bookings. Source hours do not prove that all hours have been booked.

## Import status

**Import status** is a read-only summary of the latest complete bundle per project scope: it is the same content as the **Import status** view (see [Import status](../../moduli/reporting/)). It does not depend on a site: the route does not accept `site_id` and answers with the scopes present in the reporting database.

| Method | Path | Access | Notes |
| :-- | :-- | :-- | :-- |
| GET | `/api/reporting/overview` | member with the `reporting` module in at least one site | `{ configured, scopes }`; no parameters |

`configured` is `false` when the server has no reporting database connection (`REPORTING_DATABASE_URL` missing or blank): the answer is still `200`, with `scopes` empty, and no query runs. With the connection configured, `scopes` lists one item per scope: `scopeId`, `projectReference` (`null` when absent), `exportDate` (`YYYY-MM-DD` or `null`), `loadedAt` (ISO 8601 or `null`), `counts` with the six families `employees`, `work_days`, `time_schedule`, `site_progress_items`, `daily_logs` and `deviations`, `totalRows` and `qualityIssues`.

The counts are non-negative integers and `totalRows` is their sum. The answer contains no detail rows, source payloads or load identifiers. Scopes are sorted by project reference and identifier, and the read runs in a single `REPEATABLE READ READ ONLY` transaction, so metadata and counts describe the same load.

The route accepts `GET` only: other methods answer `404`. Without a valid session the answer is `401`; if the module is not allowed in any of the member's sites it is `403 MODULE_FORBIDDEN`; if the reporting database does not answer it is `503 REPORTING_UNAVAILABLE`, with a generic message and no error details. There are no write routes, and a `site_id` in the query is ignored.

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

Attachments on **tasks, diary, HSE events and HSE inspections** can also be uploaded from the interface; for sites they stay API only. Removal is API only. `entity_type` is `task`, `diary`, `site`, `hse_event` or `hse_inspection`; an HSE event must exist and not be deleted, an HSE inspection must exist.

| Method | Path | Access | Notes |
| :-- | :-- | :-- | :-- |
| POST | `/api/attachments` | owner/editor | Upload a file (base64) |
| GET | `/api/attachments?site_id=&entity_type=&entity_id=` | member; for `hse_event` owner/editor/verifier | Attachment metadata |
| GET | `/api/attachments/{id}` | member; for `hse_event` owner/editor/verifier | Download the bytes |
| DELETE | `/api/attachments/{id}` | owner/editor | Delete |

Attachments on an HSE event follow the register's rules: the HSE module is required and reading is open to owners, editors and verifiers; upload and deletion stay with owners and editors. A deleted event hides its attachments: the list does not return them and the download answers `404 HSE_NOT_FOUND`. Attachments on an HSE inspection require the HSE module but are read by every site role, viewers included; upload and deletion also stay with owners and editors, and the list returns them only when the inspection exists in the same site. Every download of an HSE attachment — on an event or an inspection — writes a `read` row in the audit register, with the file id and name; if the write fails the download still works. The optional description in the upload form only feeds the warning in the interface: it is neither sent nor saved.

Files up to **15 MiB** are accepted, images or PDF only (`UNSUPPORTED_MEDIA_TYPE`, `ATTACHMENT_TOO_LARGE`). Upload and deletion are reserved to owners and editors; reading to all members, with the HSE exception above. Before registering the attachment the application reads the stored bytes back and compares the checksum: if it does not match, the file is removed and the response is `502`.

## Request limits and pagination

Every request to `/api/` consumes a one-minute sliding-window limit: **600 requests per minute per authenticated session** and **60 per minute per network address** for anonymous requests. The four authentication routes (`/api/auth/login`, `/api/auth/forgot`, `/api/auth/password`, `/api/auth/request`) have their own limiter and do not consume the general one. Past the limit the response is `429 RATE_LIMITED` with a `Retry-After` header in seconds; `X-RateLimit-Remaining` says how many requests are left in the window. The values are changed with the `RATE_LIMIT_USER_PER_MIN` and `RATE_LIMIT_ANON_PER_MIN` variables.

The **tasks**, **diary**, **deviations**, **site progress**, **time bookings** and **audit register** lists accept `limit` (default **50**, maximum **200**) and `offset` (default 0). Non-integer or out-of-range values are rejected with `400 VALIDATION_ERROR`. The response stays an array; the total, the applied limit and the offset arrive in the `X-Total-Count`, `X-Limit` and `X-Offset` headers. The application asks for 200 rows on the views that load the whole list, so no view loses records.

## Errors

Error responses have the shape `{ "error": "message", "code": "CODE" }`. The most common codes: `VALIDATION_ERROR` (400), `INVALID_CREDENTIALS` (401), `FORBIDDEN` (403), `NOT_FOUND` (404), `DUPLICATE_SITE_CODE` and `DUPLICATE_DIARY` (409), `INVALID_TRANSITION` (409), `SEPARATE_PEOPLE_REQUIRED` (400), `NOTE_REQUIRED`/`REASON_REQUIRED` (400), `TIME_BOOKING_DUPLICATE` (409), `WEIGHTS_NOT_100` (400), `TOOL_INVALID` (400), `TOOL_FORBIDDEN` (403), `TOOL_NOT_FOUND` (404), `CERT_INVALID` (400), `CERT_FORBIDDEN` (403), `CERT_NOT_FOUND` (404), `HSE_INVALID` (400), `HSE_FORBIDDEN` (403), `HSE_NOT_FOUND` (404), `PO_NOT_FOUND`/`PO_ITEM_NOT_FOUND` (404), `PO_DUPLICATE_NUMBER`/`PO_DUPLICATE_LINE`/`PO_STATUS_CONFLICT` (409), `AUDIT_INVALID` (400), `FILE_TOO_LARGE` (413), `LINK_EXPIRED` (410), `MAP_INVALID` (400), `AMBIGUOUS_COLUMNS` (400), `PREVIEW_MISMATCH`/`PREVIEW_EXPIRED` (409), `ATTACHMENT_TOO_LARGE` (413), `UNSUPPORTED_MEDIA_TYPE` (415), `RATE_LIMITED` (429), `MAIL_NOT_CONFIGURED`/`MAIL_UNAVAILABLE` (503), `ASSISTANT_NOT_CONFIGURED` (503), `WEBAUTHN_NOT_CONFIGURED` (503), `LAST_CREDENTIAL` (409), `AUTH_REQUIRED` (401).

:::note
The API does not expose an OpenAPI schema: the tables above are the current contract. For the full data schema see `database/README.md` in the repository.
:::
