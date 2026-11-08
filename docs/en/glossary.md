# Domain Glossary IT / EN — Glossario di Dominio

This glossary defines key domain concepts used throughout SiteAssistant, establishing semantic and technical alignment between Italian and English terminology.

---

| English Term | Italian Term | Domain Definition & Rules |
| :--- | :--- | :--- |
| **Site** | **Cantiere** | The physical and organizational boundary where erection, mechanical installation, or automation commissioning occurs. In the current application schema, a site features a unique alphanumeric `code`, descriptive name, location, and start/end dates; assigning a local timezone (`timezone`) and operational cutoff time (`day_cutoff_time`) is specified in project blueprints (planned, not yet implemented in the application schema). |
| **Task** | **Attività** | An atomic unit of installation work assigned to a subcontractor and monitored on site. Governed by a strict finite state machine (`todo`, `in_progress`, `to_verify`, `closed`, `blocked`), target due date, and mandatory executor/verifier separation. |
| **Executor / Assignee** | **Esecutore** | The individual supervisor or team lead materially responsible for performing the task. Authorized to start the task and submit it for verification with supporting evidence. |
| **Verification / Review** | **Verifica** | The formal engineering inspection and quality sign-off confirming that work conforms to project specifications and drawings before final closure. |
| **Verifier / Reviewer** | **Verificatore** | The designated inspector assigned during task creation. The sole role authorized to transition tasks from `to_verify` to `closed`. Must strictly be a distinct person from the executor. |
| **Site Diary / Logbook** | **Diario di cantiere** | The daily operational record capturing shift planning, actual work done, encountered blockers, and shift handover instructions. Indexed uniquely by site, operational date, and shift. |
| **Shift** | **Turno** | The operational working window within a 24-hour cycle. Standardized into day shift (`day`) and night shift (`night`). |
| **Operational Day** | **Giorno operativo** | The operational temporal convention governing site activities. Unlike standard civil calendar days (midnight to midnight), operational day $D$ starts at a designated cutoff time (default `06:00:00` local time) and ends at `05:59:59` on day $D+1$. Night shifts spanning midnight belong to the operational day in which the shift started. |
| **Cutoff Time** | **Ora di taglio** | The configured local site time (default `06:00`) demarcating the boundary between operational days, preventing arbitrary calendar fragmentation of night shifts. |
| **Deviation / Snag** | **Deviazione** | Any variance or non-conformity relative to project design, master schedule, or installation tolerances. Recorded in the ingestion model with distinct identity tracking and history preservation. |
| **Official Status** | **Stato ufficiale** | The formal status recorded in external enterprise systems (ERP, Primavera P6, contractor reports), ingested and preserved immutably in source snapshots. |
| **Internal Status** | **Stato interno** | The live, field-level execution status managed directly by the Site Manager within SiteAssistant. Strictly decoupled from official external records. |
| **Internal Annotation** | **Annotazione interna** | Qualitative technical observations or supplementary notes attached to source records, designed to persist across subsequent re-extractions of source data. |
| **Impediment / Blocker** | **Impedimento / Blocco** | Any technical, logistical, safety, or material obstacle hindering regular work progression. Requires a mandatory explanatory reason upon logging. |
| **Evidence** | **Evidenza** | Descriptive notes, dimensional measurements (and planned photographic/file attachments) provided by the executor to demonstrate completion prior to inspection. |
