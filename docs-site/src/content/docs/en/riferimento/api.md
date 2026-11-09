---
title: REST API
description: Endpoints, authentication, errors and idempotency of the SiteAssistant API.
---

The API is a plain Node.js HTTP service. The static frontend calls it directly.

## Base URL and CORS

- Default client base: `https://api.siteassistant.asassi.cloud`.
- With `<meta name="siteassistant-api-base" content="/">` the client uses the same origin that serves the static files.
- CORS allows only `https://siteassistant.asassi.cloud`, with credentials.
- Responses are always `Cache-Control: no-store`.

## Authentication

There are no API tokens. Authentication uses the `sa_session` cookie obtained from `POST /api/auth/login` and sent by the browser with `credentials: 'include'`.

## Endpoints

| Method | Path | Role | Notes |
| :-- | :-- | :-- | :-- |
| GET | `/api/health` | none | `{ "status": "ok" }` |
| POST | `/api/auth/login` | none | `{ email, password }`; sets the cookie |
| GET | `/api/auth/me` | authenticated | User and per-site roles |
| POST | `/api/auth/logout` | authenticated | Revokes the session |
| GET | `/api/sites` | authenticated | Only sites you are a member of |
| POST | `/api/sites` | owner | `code`, `name`, `location`, `start_date`, `end_date` |
| GET | `/api/sites/{id}` | member | Site detail |
| GET | `/api/sites/{id}/members` | owner | Members and roles |
| POST | `/api/sites/{id}/members` | owner | `{ user_id, role }`; `role: null` removes |
| GET | `/api/tasks?siteId=&status=` | member | Optional filters |
| POST | `/api/tasks` | owner/editor/verifier | Supports `Idempotency-Key` |
| GET | `/api/tasks/{id}` | member | Includes event history |
| POST | `/api/tasks/{id}/transition` | owner/editor/verifier | `{ to, note?, reason? }` |
| GET | `/api/diary?siteId=` | member | Site entries |
| POST | `/api/diary` | owner/editor/verifier | One entry per site/date/shift |

## Request bodies

`Content-Type: application/json` is mandatory. The maximum body is **65,536 characters**; beyond that the request fails with `400 INVALID_JSON`.

Dates use `YYYY-MM-DD`. Diary dates are operational days, not midnight-to-midnight dates.

## Idempotency

`POST /api/tasks` accepts an `Idempotency-Key` header. Two requests with the same key and body return the same response without creating a second task; the same key with a different body is rejected. The key is bound to the user who sent it.

## Errors

```json
{ "error": "Human readable message.", "code": "ERROR_CODE" }
```

| Code | HTTP | Meaning |
| :-- | :-- | :-- |
| `VALIDATION_ERROR` | 400 | Missing or invalid field |
| `INVALID_JSON` | 400 | Invalid content type or body |
| `INVALID_CREDENTIALS` | 401 | Login failed |
| `FORBIDDEN` | 403 | Insufficient site role, or transition reserved to the designated verifier or a site owner |
| `NOT_FOUND` | 404 | Unknown resource or route |
| `DUPLICATE_SITE_CODE` | 409 | Site code already used |
| `DUPLICATE_DIARY` | 409 | Entry already exists for site/date/shift |
| `INVALID_TRANSITION` | 409 | Transition not allowed |
| `SEPARATE_PEOPLE_REQUIRED` | 400 | Executor and verifier are the same person |
| `NOTE_REQUIRED` / `REASON_REQUIRED` | 400 | Note or reason missing |
| `RATE_LIMITED` | 429 | Too many sign-in attempts |
| `INTERNAL_ERROR` | 500 | Unhandled error |

## Example

```sh
curl -s -X POST https://api.siteassistant.asassi.cloud/api/auth/login \
  -H 'Content-Type: application/json' \
  -c cookies.txt \
  -d '{"email":"mario.rossi@example.com","password":"..."}'

curl -s https://api.siteassistant.asassi.cloud/api/tasks?siteId=UUID \
  -b cookies.txt
```

The API exposes no OpenAPI document: this table is the current contract. For the data schema see `database/README.md` in the repository.
