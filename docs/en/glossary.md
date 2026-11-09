# Domain Glossary IT / EN — Glossario di Dominio

This glossary defines key domain concepts used throughout SiteAssistant, establishing semantic and technical alignment between Italian and English terminology.

---

| English Term | Italian Term | Domain Definition & Rules |
| :--- | :--- | :--- |
| **Site** | **Cantiere** | The physical and organizational boundary where erection, mechanical installation, or automation commissioning occurs. Features a unique alphanumeric `code`, descriptive name, location, and start/end dates. The site diary additionally persists `time_zone` and the operational day cutoff time (`day_cutoff_time`). |
| **Task** | **Attività** | An atomic unit of installation work assigned to a subcontractor and monitored on site. Governed by a strict finite state machine (`todo`, `in_progress`, `to_verify`, `closed`, `blocked`), target due date, and mandatory executor/verifier separation. |
| **Executor / Assignee** | **Esecutore** | The individual supervisor or team lead materially responsible for performing the task. Authorized to start the task and submit it for verification with supporting evidence. |
| **Verification / Review** | **Verifica** | The formal engineering inspection and quality sign-off confirming that work conforms to project specifications and drawings before final closure. Cannot be executed by the user who submitted the completion proposal. |
| **Verifier / Reviewer** | **Verificatore** | The designated inspector assigned to review task quality. Authorized to verify or reject completion (`to_verify`), provided they did not personally submit the work. |
| **Session** | **Sessione** | The authenticated user state stored on the server in `sessions` via SHA-256 token hashing, accessed through the secure `sa_session` cookie (7-day TTL, HttpOnly, SameSite=Lax, Secure over HTTPS). Authoritatively dictates the acting identity (`actor`) for all audit events and transactions. |
| **Site Role** | **Ruolo cantiere** | The authorization level granted to an authenticated user for a specific construction site (`site_members`). Configured hierarchically and functionally: `owner`, `editor`, `verifier`, `viewer`. |
| **Owner** | **Owner (Responsabile cantiere)** | Top-level authority on a site: possesses full read/write access to tasks and diary, manages site memberships, and creates new sites. May verify tasks provided they did not personally submit them. |
| **Editor** | **Editor (Operatore / Caposquadra)** | Operational execution role: creates and edits tasks, executes state transitions, logs blockers, submits tasks for verification, and contributes to the site diary. Cannot close/verify tasks or manage members. |
| **Verifier** | **Verifier (Verificatore di cantiere)** | Quality control role: holds all standard write privileges (tasks and diary) plus formal authority to accept or reject task verification submissions (`to_verify`), bound by strict anti-self-review enforcement. |
| **Viewer** | **Viewer (Osservatore)** | Read-only stakeholder role: can inspect sites, task boards, lists, and diary logs, but has no write or state-transition permissions. |
| **create-user CLI** | **CLI create-user** | Administrative command-line utility (`server/create-user.mjs` or `npm run create-user`) for provisioning user accounts (normalized email, name, min. 12-character scrypt password) and assigning initial site memberships and roles. Reads passwords via masked TTY prompt or piped stdin. |
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
