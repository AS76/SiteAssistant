# SiteAssistant — Demo User Guide

This guide walks you step-by-step through the features, authentication flow, and operational processes of the SiteAssistant demonstration release.

> **Important Notice:** This demo uses purely **synthetic and fictional test data**. Do not input real personal names, sensitive credentials, commercial secrets, or real customer site codes. The demo instance is protected at the network edge with Basic Authentication and features application-level authentication with site-specific roles.

---

## 1. Access and Authentication

The application includes a built-in local authentication system based on individual email and password credentials:

1. Open the application URL in any modern mobile or desktop browser.
2. If there is no active session, the application presents the **Sign In** (`login`) screen:
   - Enter your registered **Email** and **Password**.
   - Click **"Sign in"**.
3. **Secure Cookie Session:** Upon valid authentication, the server issues a protected session cookie (`sa_session`, 7-day TTL, HttpOnly, SameSite=Lax, Secure over HTTPS).
4. **Authentication Error States:**
   - **401 (Invalid Credentials):** If email or password do not match, the system indicates an error without revealing which field was incorrect.
   - **429 (Rate Limited):** After 10 failed attempts within 15 minutes (calculated across IP and email address), sign-in is temporarily throttled with a `Retry-After` header and wait notice.
   - **401 (Session Expired / Auth Required):** If the session cookie has expired, been revoked, or is missing, navigation is halted and the user is redirected to the sign-in form.
5. **Sign Out (Logout):** The **"Sign out"** button in the top navigation immediately revokes the active session on the server, clears the cookie, and resets client-side in-memory state.
6. **Language Selection:** Switch the UI language between **EN** and **IT** via the top-right toggle. Translations apply instantly without altering user-submitted texts.
7. **Site Selection:** The *Site* dropdown displays only the sites where the authenticated user holds an active membership. All views (Overview, Tasks, Board, Diary) scope strictly to the selected site.

---

## 2. Per-Site Roles and Permissions

Permissions in SiteAssistant are configured on a per-site basis (`site_members`). An authenticated user can hold different roles across different sites:

| Role | Read Views | Create/Edit Tasks | Site Diary (Logbook) | Submit for Verification | Verify & Reject (`to_verify`) | Manage Members & Sites |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| **Owner** | Yes | Yes | Yes (write) | Yes | Yes (unless self-submitted) | Yes (assign roles & create sites) |
| **Editor** | Yes | Yes | Yes (write) | Yes | No | No |
| **Verifier** | Yes | Yes | Yes (write) | Yes | Yes (unless self-submitted) | No |
| **Viewer** | Yes | No (read-only) | No (read-only) | No | No | No |

- If an authenticated user attempts an operation not granted to their role on that site (for example, a `viewer` attempting to create a task, or an `editor` attempting to approve a verification), the server rejects the request with a **403 (FORBIDDEN)** status code.

---

## 3. User Provisioning (CLI `create-user`)

User registration and initial role assignment is an administrative command-line utility (not exposed in the public web UI):

- **Tool:** Executable Node.js script `server/create-user.mjs` (or via `npm run create-user`).
- **Required parameters:**
  - `--email <address>`: Unique email address (normalized to lowercase).
  - `--name <full_name>`: Operator full name.
- **Site assignment (optional):**
  - `--site <site_code>` and `--role <role>`: Must be supplied together. Accepted roles: `owner`, `editor`, `verifier`, `viewer`.
- **Password policy:**
  - Minimum required length: **12 characters**.
  - Passwords are **never passed as command-line arguments (`argv`)** to prevent leakage in shell history or process tables (`ps`). Passwords are read interactively with a masked prompt on TTY terminals, or via piped standard input using `--password-stdin`.

**Administrative command examples:**

```bash
# Interactive prompt with masked password input:
npm run create-user -- --email supervisor@site.invalid --name "Marco Rossi" --site PRJ-ALPHA-01 --role editor
# System prompts: Password: [masked input]

# Piped securely via stdin:
printf '%s' '********' | npm run create-user -- --email inspector@site.invalid --name "Laura Bianchi" --site PRJ-ALPHA-01 --role verifier --password-stdin
```

---

## 4. Registering a New Site

Creating a new site requires an active **Owner** role on at least one existing site:
1. Click **"New Site"**.
2. Complete the required fields:
   - **Code:** Unique alphanumeric code (e.g., `PRJ-SYNTH-01`). Duplicate codes will be rejected.
   - **Name:** Descriptive plant name (e.g., *Automated Sortation Hub Alpha*).
   - **Location:** City or logistics hub reference (e.g., *Sample Logistics Hub*).
   - **Start Date / End Date:** Planned schedule dates (`YYYY-MM-DD`). End date cannot precede start date.
3. Click **"Save Site"**. The creator is automatically granted the **Owner** role for the newly created site.

---

## 5. Creating a Task

To record a task within the active site (requires **Owner**, **Editor**, or **Verifier** role):
1. Click **"New Task"**.
2. Complete the form:
   - **Title:** Concise summary of the installation work (e.g., *Mount cable trays along Line 3*).
   - **Area:** Plant quadrant or floor level (e.g., *Mezzanine Level B2*).
   - **Company:** Assigned subcontractor (e.g., *ElectroInstallations Ltd*).
   - **Executor:** Name or reference of the assigned execution lead.
   - **Verifier:** Name of the designated verification inspector.
     > **Separation Rule:** Executor and Verifier **must be distinct entities**. If identical, the creation is rejected.
   - **Priority:** Select `Normal`, `High`, or `Urgent`.
   - **Due Date:** Target completion date (`YYYY-MM-DD`).
3. Click **"Create Task"**. The task is saved in the **Todo** (`todo`) status.

---

## 6. Executing Task State Transitions

Task progress and quality verification follow a server-enforced state machine:

```text
[todo] ──(Start)──> [in_progress] ──(Submit to verify)──> [to_verify] ──(Verify & Close)──> [closed]
  │                       │                                    │                                  │
  └──(Block)──────────────┴────────────(Block)─────────────────┘                                  │
                                                                                                  │
                                     [in_progress] <────────(Reopen with reason)──────────────────┘
```

> **Core Rule on Actor Identity (`actor`):** The actor performing any transition **is no longer a client-claimed free-text parameter**. It is derived authoritatively from the authenticated user session. Forgery or client-side impersonation is impossible.

### 6.1 Starting Work (`todo` $\rightarrow$ `in_progress`)
- On the task card or row, click **"Start"**.
- The recorded actor automatically corresponds to the authenticated session user.
- Status changes to **In Progress** (`in_progress`).

### 6.2 Logging a Blocker (`blocked`)
- From any active state (`todo`, `in_progress`, or `to_verify`), click **"Block"**.
- A descriptive **reason is mandatory** (e.g., *Missing bracket hardware shipment from vendor*).
- The task is flagged as Blocked, recording the previous state to support clean resumption.

### 6.3 Submitting for Verification (`in_progress` $\rightarrow$ `to_verify`)
- When physical execution is complete, click **"Submit for Verification"**.
- An **evidence note is mandatory** (e.g., *Cable trays secured, torque checks complete as per diagram*).
- The server captures the submitter's identity (`submitted_by_id`).
- Status changes to **To Verify** (`to_verify`).

### 6.4 Verification and Formal Closure (`to_verify` $\rightarrow$ `closed`)
- **Anti-Self-Review Rule:** The user performing verification or rejection **cannot be the same user who submitted the task for review** (`submitted_by_id`). If the submitter attempts self-approval, the request is rejected with a **409 (INVALID_TRANSITION)** conflict error.
- The action requires an active **Verifier** or **Owner** role on the site.
- Click **"Verify & Close"**, providing the mandatory verification note.
- Status transitions to **Closed** (`closed`).

### 6.5 Rejecting a Verification (`to_verify` $\rightarrow$ `in_progress`)
- If inspection reveals deviations or snags, an authorized verifier (distinct from the submitter) can reject the submission, sending it back to `in_progress` with mandatory explanatory notes.

### 6.6 Reopening a Closed Task (`closed` $\rightarrow$ `in_progress`)
- If rework is required after closure, authorized members can reopen the task by providing a mandatory technical justification.

---

## 7. Compiling the Site Diary (Logbook)

The Diary records daily shift activity and handover information (writable by **Owner**, **Editor**, and **Verifier** roles):
1. Switch to the **"Diary"** tab.
2. Select reporting parameters:
   - **Operational Date:** Working day date in `YYYY-MM-DD` format (if omitted via API, derived automatically using the 06:00 local cutoff rule).
   - **Shift:** Choose between **Day** (`day`) or **Night** (`night`).
3. Fill in the four structured reporting sections:
   - **Plan:** Planned targets for the shift.
   - **Actual:** Summary of work actually performed.
   - **Impediments:** Delays, safety holds, missing equipment, or interferences.
   - **Next Steps:** Critical handover tasks for the subsequent shift.
4. Click **"Save Diary"**.
   > **Uniqueness Constraint:** Only one diary entry is permitted per Site + Operational Date + Shift. Re-submitting the same combination will be rejected.
5. **Print & Export:** Use the **"Print"** button to trigger the browser's clean print layout for physical logbooks or PDF export.
