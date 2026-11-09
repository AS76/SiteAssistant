# SiteAssistant — Product Overview

## 1. What is SiteAssistant

SiteAssistant is an operational web application built for **Site Managers** and **Installation Managers** supervising intralogistics, industrial automation, robotics, and Material Handling Equipment (MHE) installation projects.

SiteAssistant acts as the **missing operational link** between high-level planning systems (such as ERPs, Primavera P6 schedules, or project spreadsheets) and the daily execution on the construction floor. It does not replace enterprise ERPs or accounting software; rather, it provides a lightweight, responsive tool designed for field use on smartphones or tablets to:
- track actual work execution and task progress;
- record operational blockers and formal verification evidence;
- compile the daily site logbook segmented by working shifts.

---

## 2. Target Audience

The primary target roles are:
- **Site Managers / Installation Managers:** responsible for day-to-day subcontractor coordination, safety alignment, and overall mechanical/electrical erection milestones.
- **Team Leads / Executors:** installation supervisors responsible for task execution and reporting impediments or material shortages.
- **Verifiers / Quality Inspectors:** technical inspectors designated to formally review work quality and approve task completion.

*Out of current scope:* purchasing departments, financial controllers, and end-client customer portals.

---

## 3. Current Capabilities (Implemented Features)

The current live demonstration release (static frontend communicating with a REST API backed by PostgreSQL or SQLite) delivers five core functional areas:

### 3.1 Authentication & Per-Site Access Control
- **Application Sign-In:** authentication via local credentials (email and scrypt-hashed password), secure sessions stored in `sessions` and accessed via the `sa_session` cookie (7-day TTL, HttpOnly, SameSite=Lax, Secure over HTTPS), with brute-force rate limiting (max 10 attempts per 15 minutes with HTTP 429 status handling).
- **Per-Site Roles (`site_members`):** granular authorization configured on each site:
  - `owner`: full control over tasks and logbook, membership management, and site creation;
  - `editor`: task creation/updates, submission for verification, and diary contributions;
  - `verifier`: task updates, diary contributions, and verification acceptance or rejection;
  - `viewer`: read-only inspection.
- **Authoritative Actor Identity:** the acting identity for every transition and audit event is derived authoritatively from the active session and cannot be forged or overridden by the client.

### 3.2 Site Management
- Registration of construction sites featuring a unique site code, descriptive name, location, and planned start/end dates (restricted to users holding an `owner` role).
- Active site selector establishing the working context (scoped strictly to sites where the authenticated user holds an active membership).

### 3.3 Task Tracking
- Creation of tasks assigned to a specific site, containing: title, plant area, assigned subcontractor company, executor, designated verifier, priority level (`normal`, `high`, `urgent`), and due date.
- **Role separation rule:** the application strictly requires the executor and verifier to be distinct persons upon creation.
- List view and board view; on mobile the board scrolls horizontally with snap between columns. Filterable by status and site.
- CSV export of loaded tasks with built-in formula-injection sanitization.

### 3.4 State Machine and Verification Workflow
Task lifecycle is strictly governed by a server-validated finite state machine with immutable audit trail logging (`task_events`):
- `todo` $\rightarrow$ can transition to `in_progress` or `blocked` (mandatory blocking reason).
- `in_progress` $\rightarrow$ can transition to `to_verify` (mandatory execution note) or `blocked` (mandatory blocking reason).
- `to_verify` $\rightarrow$ can transition to `closed` or be rejected back to `in_progress`.
- **Anti-Self-Review Enforcement:** review (approval or rejection) can only be performed by a `verifier` or `owner` who **did not submit the task for verification** (`submitted_by_id`).
- `closed` $\rightarrow$ can be reopened to `in_progress` (mandatory reopening reason).
- `blocked` $\rightarrow$ records the blocking reason and origin status, allowing clean resumption.

### 3.5 Operational Daily Logbook (Site Diary)
- Recording of daily site activities structured by **site**, **operational date** (format `YYYY-MM-DD`), and **shift** (`day` / `night`).
- Automatic operational day calculation based on the local cutoff rule (defaulting to 06:00 local time) with preserved timezone metadata (`Europe/Rome`).
- Four structured sections:
  1. *Plan*: tasks scheduled for the shift.
  2. *Actual*: summary of work actually performed.
  3. *Impediments*: blockers, delays, interferences, or equipment downtime.
  4. *Next Steps*: handover instructions for the following shift.
- **Shift uniqueness constraint:** a composite uniqueness constraint `(site_id, operational_date, shift)` prevents duplicate records or accidental overwrites for any shift.
- Built-in browser print styling for clean physical log production.

---

## 4. Current Status and Demo Limitations

The current deployment is an architectural and functional prototype published to validate workflow mechanics with stakeholders. Key boundaries include:

- **Synthetic test data:** all database records and demonstration profiles are entirely fictional.
- **Perimeter and application security:** access to the environment is protected at the edge (HTTP Basic Auth) and handled at the application layer with personal credentials and per-site roles.
- **User provisioning via CLI:** user account creation is handled through a dedicated administrative CLI tool (`server/create-user.mjs`), while site memberships are managed via API for `owner` users. There is no public self-registration or password-reset screen in the web UI.
- **Text-only evidence:** handovers and verifications currently capture structured text notes; file attachments (photos, delivery slips, test sheets) are not yet wired up.
- **Bilingual interface:** UI text switches dynamically between English and Italian; user-submitted text content remains in the input language.

---

## 5. Planned Roadmap

Architectural specifications already defined for future increments include:
1. **Google OAuth Integration:** federated single sign-on alongside local password credentials.
2. **Web UI for Member Management:** visual interface allowing site owners to invite users and adjust roles directly from the browser.
3. **Object Storage Attachments (S3):** attachment upload module targeting a dedicated S3-compatible object bucket with cryptographic SHA-256 integrity verification and versioned manifests.
4. **Data Ingestion Pipeline:** structured import jobs for schedules, timesheets, and external deviation lists, maintaining strict separation between official third-party snapshots and internal site annotations.
