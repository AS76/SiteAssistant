---
title: Sign in and account
description: How to sign in to SiteAssistant, request an account and manage your password.
---

You sign in to SiteAssistant with your **email** and **password**. There is no public registration: accounts are created in two ways, both designed for people working on site.

## Sign in

1. Open the application address in your browser, on desktop or mobile.
2. If there is no active session, the **Sign in** form appears.
3. Enter your **email** and **password**, then press **Sign in**.
4. After signing in you only see the sites you belong to, and you can choose your working context from the menu at the top.

The email is case-insensitive: `Mario.Rossi@example.com` and `mario.rossi@example.com` are the same account.

## If you do not have an account yet

From the sign-in form you can press **Request access**:

1. Enter your email.
2. The request reaches whoever administers the application, who can **approve** or **reject** it.
3. If approved, you receive a **temporary password** by email.
4. On first sign-in the application asks you to **change the password**.

A request does not create the account on its own: it needs an administrator's approval.

## Forgotten or temporary password

- **Forgot password:** from the sign-in form press **Forgot password** and enter your email. If the account exists, you receive a new temporary password by email.
- **Change password:** if you are using a temporary password, a notice appears with the **Change password** button. It requires your current password and a new one, different and at least **12 characters** long. Other sessions are closed.

If the email service is not active, these operations are unavailable: the application tells you and asks you to try again later.

## When sign-in fails

The error message never reveals whether the email or the password is wrong. After **10 failed attempts** in the same **15-minute** window (for the same email and network address), sign-in is suspended for a while: wait a few minutes and try again.

## How long the session lasts

- The session lasts **7 days** and is remembered by the browser with a secure cookie.
- The **Sign out** button closes the session on the server immediately.
- Closing the browser without signing out does **not** close the session: it stays valid until it expires or you sign out.

:::note[Expired session]
If the session expires or is revoked, the application takes you back to the sign-in form.
:::
