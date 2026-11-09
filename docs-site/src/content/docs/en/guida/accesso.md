---
title: Sign in and sessions
description: How to sign in to SiteAssistant, how long a session lasts and how failed attempts are handled.
---

SiteAssistant has no self-service sign-up: accounts are created by an administrator with the `create-user` CLI (see [Users and roles](../../amministrazione/utenti-e-ruoli/)).

## Signing in

1. Open the application URL in a browser, on desktop or mobile.
2. Without an active session, the **sign-in** form appears.
3. Enter **email** and **password**, then press **Sign in**.
4. You only see the sites you are a member of; the picker at the top sets the working context.

Email matching is case-insensitive: `Mario.Rossi@example.com` and `mario.rossi@example.com` are the same account.

## Failed sign-in

| Response | Meaning | Action |
| :-- | :-- | :-- |
| **400** | Missing or malformed email/password | Check the fields |
| **401** `INVALID_CREDENTIALS` | Wrong credentials, unknown or disabled account | Retry; ask your administrator if it persists |
| **429** `RATE_LIMITED` | Too many failed attempts | Wait for the time in `Retry-After` |

The error never reveals whether the email or the password was wrong.

## Attempt limit

After **10 attempts** within **15 minutes** for the same IP address and email pair, sign-in is blocked with **429** and a `Retry-After` header in seconds. The limit is per IP + email pair, so one blocked user does not block others.

## Session lifetime and security

- The server sets the **`sa_session`** cookie, valid for **7 days**.
- The cookie is `HttpOnly`, `SameSite=Lax` and `Secure` over HTTPS.
- Only a SHA-256 hash of the token is stored server-side, in the `sessions` table.
- Every operation records the authenticated user as actor, not a hand-typed name.

## Signing out

**Sign out** revokes the session server-side, invalidates the cookie and clears the data loaded in the page. Closing the browser without signing out does not revoke the session: it stays valid until expiry or logout.

:::note[Expired session]
If the cookie has expired or was revoked, the application returns to the sign-in form and the previous navigation state is lost.
:::
