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

## 3. Current Capabilities (Implemented in Demo)

The current live demonstration release (static frontend communicating with a REST API backed by PostgreSQL or SQLite) delivers four core modules:

### 3.1 Site Management
- Registration of construction sites featuring a unique site code, descriptive name, location, and planned start/end dates.
- Active site selector establishing the working context for all subsequent operations.

### 3.2 Task Tracking
- Creation of tasks assigned to a specific site, containing: title, plant area, assigned subcontractor company, executor, designated verifier, priority level (`normal`, `high`, `urgent`), and due date.
- **Role separation rule:** the application strictly requires the executor and verifier to be distinct persons upon creation.
- List view and board view; on mobile the board scrolls horizontally with snap between columns. Filterable by status and site.
- CSV export of loaded tasks with built-in formula-injection sanitization.

### 3.3 State Machine and Verification Workflow
Task lifecycle is strictly governed by a server-validated finite state machine with immutable audit trail logging (`task_events`):
- `todo` $\rightarrow$ can transition to `in_progress` or `blocked` (mandatory blocking reason).
- `in_progress` $\rightarrow$ can transition to `to_verify` (mandatory execution note) or `blocked` (mandatory blocking reason).
- `to_verify` $\rightarrow$ can transition to `closed` (mandatory completion note; **strictly restricted to the designated verifier**) or `blocked`.
- `closed` $\rightarrow$ can be reopened to `in_progress` (mandatory reopening reason).
- `blocked` $\rightarrow$ holds the task until unblocked, logging the reason.

### 3.4 Operational Daily Logbook (Site Diary)
- Recording of daily site activities structured by **site**, **operational date** (format `YYYY-MM-DD`), and **shift** (`day` / `night`).
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
- **No application-level authentication:** access to the demo environment is protected at the ingress perimeter via HTTP Basic Auth. Inside the app, individual user accounts do not yet exist; person fields (`executor`, `verifier`, transition actors) are free-text strings claimed by the operator.
- **Text-only evidence:** handovers and verifications currently capture structured text notes; file attachments (photos, delivery slips, test sheets) are not yet wired up.
- **Bilingual interface:** UI text switches dynamically between English and Italian; user-submitted text content remains in the input language.

---

## 5. Planned Roadmap

Architectural specifications already defined for future increments include:
1. **User Authentication & Role-Based Access Control:** introduction of local identities (email + scrypt password) or Google OAuth, with site-level permission roles (`owner`, `editor`, `verifier`, `viewer`).
2. **Configurable Operational Day Cutoff:** automated operational date calculation with site-specific cutoff times (defaulting to 06:00 local time) and seamless cross-midnight night shift attribution.
3. **Object Storage Attachments (S3):** attachment upload module targeting a dedicated S3-compatible object bucket with cryptographic SHA-256 integrity verification and versioned manifests.
4. **Data Ingestion Pipeline:** structured import jobs for schedules, timesheets, and external deviation lists, maintaining strict separation between official third-party snapshots and internal site annotations.
