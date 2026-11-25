---
title: Demo version
description: Which application is deployed, which documentation describes it, and how to verify both values.
---

# Demo version

This page makes the documentation you are reading comparable with the application available on the demo.

As of **24 November 2026**:

| Item | Value |
|---|---|
| Application commit | `7c4a851` |
| Static assets | `siteassistant-v15-54` |
| Database schema | `048` |
| Documentation updated to commit | `7c4a851` |

## How to verify

- Open `<DEMO_URL>/sw.js` and look for `siteassistant-v15-54`, where `<DEMO_URL>` is the demo address supplied by the operator.
- Open `<API_URL>/api/health`, where `<API_URL>` is the API base URL supplied by the operator along with the demo address: it should return `200` with `"status":"ok"` and `"auth_bypass":false`.
- Open the [REST API](../../riferimento/api/) page for the public contract.

If the values do not match, the demo was updated after this page: the newer release prevails. The page is updated at release time, without a new versioning system.

## Why it matters

The documentation describes behaviour, not a date. This panel lets people trying the demo see immediately whether they are using the documented version or a later one, without opening the repository.
