# SiteAssistant — Demo User Guide

This guide walks you step-by-step through the features and operational flows of the SiteAssistant demonstration release.

> **Important Notice:** This demo uses purely **synthetic and fictional test data**. Do not input real personal names, sensitive credentials, commercial secrets, or real customer site codes. Access to the demo instance is gated at the network edge with Basic Authentication.

---

## 1. Access and Initial Setup

1. Open the application URL in any modern mobile or desktop browser.
2. **Language Selection:** Switch the UI language between **EN** and **IT** via the top-right toggle. Translations apply instantly without reloading the page or altering user inputs.
3. **Site Selection:** Select the active project from the *Site* dropdown. The Tasks list, Board view, and Diary immediately filter to display only data belonging to that site.

---

## 2. Registering a New Site

To register a new test installation site:
1. Click **"New Site"** in the top action bar.
2. Fill in the required fields:
   - **Code:** Unique alphanumeric project code (e.g., `PRJ-SYNTH-01`). Duplicate codes will be rejected by the server.
   - **Name:** Descriptive plant name (e.g., *Automated Sortation Hub Alpha*).
   - **Location:** City or terminal reference (e.g., *Sample Logistics Hub*).
   - **Start Date / End Date:** Planned schedule dates in `YYYY-MM-DD` format. End date cannot precede start date.
3. Click **"Save Site"**. The new site becomes immediately selectable in the active site dropdown.

---

## 3. Creating a Task

To record a task within the active site context:
1. Click **"New Task"**.
2. Complete the form:
   - **Title:** Clear, concise summary of the installation work (e.g., *Mount cable trays along Line 3*).
   - **Area:** Specific plant quadrant or floor level (e.g., *Mezzanine Level B2*).
   - **Company:** Subcontractor firm executing the work (e.g., *ElectroInstallations Ltd*).
   - **Executor:** Individual responsible for performing the work (e.g., *M. Rossi*).
   - **Verifier:** Designated inspector responsible for quality sign-off (e.g., *L. Bianchi*).
     > **Non-negotiable Rule:** Executor and Verifier **must be two distinct people**. If the same name is entered in both fields, submission will be rejected.
   - **Priority:** Select `Normal`, `High`, or `Urgent`.
   - **Due Date:** Target completion date (`YYYY-MM-DD`).
3. Click **"Create Task"**. The task is saved and initialised in the **Todo** (`todo`) status.

---

## 4. Executing Task State Transitions

Task progress and quality verification follow strict state-machine rules:

```text
[todo] ──(Start)──> [in_progress] ──(Submit to verify)──> [to_verify] ──(Verify & Close)──> [closed]
  │                       │                                    │                                  │
  └──(Block)──────────────┴────────────(Block)─────────────────┘                                  │
                                                                                                  │
                                     [in_progress] <────────(Reopen with reason)──────────────────┘
```

### 4.1 Starting Work (`todo` $\rightarrow$ `in_progress`)
- On the task card or row, click **"Start"**.
- Specify the operator name performing the action.
- Status advances to **In Progress** (`in_progress`).

### 4.2 Logging a Blocker (`blocked`)
- From any active state (`todo`, `in_progress`, or `to_verify`), click **"Block"**.
- A descriptive **reason is mandatory** (e.g., *Missing bracket hardware shipment from vendor*).
- The task is flagged as Blocked, logging the reason in the audit trail.

### 4.3 Submitting for Verification (`in_progress` $\rightarrow$ `to_verify`)
- When mechanical or electrical execution is completed, click **"Submit for Verification"**.
- An **evidence note is mandatory** (e.g., *Cable trays secured, torque checks complete as per diagram*).
- Status changes to **To Verify** (`to_verify`).

### 4.4 Verification and Formal Closure (`to_verify` $\rightarrow$ `closed`)
- Only the **designated Verifier** named during task creation is authorized to close the task.
- Click **"Verify & Close"**.
- Enter the actor's name (which must strictly match the designated Verifier) and a **verification note** (e.g., *Visual inspection passed, conforms to layout rev B*).
- If an actor other than the verifier attempts closure, the server rejects the request with a `409` conflict error.
- Status transitions to **Closed** (`closed`).

### 4.5 Reopening a Closed Task (`closed` $\rightarrow$ `in_progress`)
- If subsequent inspections reveal snags or defects, click **"Reopen"**.
- A **mandatory reason** explaining the rework requirement must be provided.
- Status reverts to **In Progress** (`in_progress`).

---

## 5. Compiling the Site Diary (Logbook)

The Diary records daily shift activity and handover information:
1. Switch to the **"Diary"** tab.
2. Select reporting parameters:
   - **Operational Date:** Working day date (`YYYY-MM-DD`).
   - **Shift:** Choose between **Day** (`day`) or **Night** (`night`).
3. Fill in the four structured reporting sections:
   - **Plan:** Planned targets for the shift.
   - **Actual:** Summary of work actually performed.
   - **Impediments:** Delays, safety holds, missing equipment, or interferences.
   - **Next Steps:** Critical handover tasks for the subsequent shift.
4. Click **"Save Diary"**.
   > **Uniqueness Constraint:** Only one diary entry is permitted per Site + Operational Date + Shift. Re-submitting the same combination will be rejected to prevent silent overwrites.
5. **Print & Export:** Use the **"Print"** button to trigger the browser's clean print layout, suitable for exporting clean PDF shift logs.
