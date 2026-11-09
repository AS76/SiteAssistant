---
title: Glossary
description: Italian and English terminology used in SiteAssistant.
---

| Italiano | English | Meaning |
| :-- | :-- | :-- |
| Cantiere | Site | Organisational unit that collects tasks and diary |
| Attività | Task | Unit of work with a distinct executor and reviewer |
| Esecutore | Executor | The person who physically executes the task |
| Verificatore | Verifier | The person who checks and closes the work |
| Sottomissione | Submission | Move to `to_verify` with an execution note |
| Verifica | Verification | Approval that moves the task to `closed` |
| Blocco | Block | `blocked` status with a reason |
| Riapertura | Reopen | Return of a closed task to `in_progress` |
| Diario | Site diary / Logbook | Plan, actual results, blockers and next step per shift |
| Turno | Shift | Operational fraction: `day` or `night` |
| Giorno operativo | Operational day | Day starting at the cutoff time (default 06:00), not at midnight |
| Ora di taglio | Cutoff time | Local time separating two operational days |
| Struttura progetto | Project structure (WBS) | Work hierarchy imported from the Time Schedule, read only |
| Padre sintetico | Synthetic parent | WBS item rebuilt because it was missing from the Time Schedule |
| Dipendente | Employee | Site personnel record (read-only projection) |
| Presenza | Work day | An employee's working day, with times and shift |
| Allegato | Attachment | File linked to a task, diary or site (API only) |
| Richiesta di accesso | Access request | Self-service request for an account, approved by an owner |
| Ruolo di cantiere | Site role | `owner`, `editor`, `verifier`, `viewer` |
| Evidenza | Evidence | Text note accompanying the submission |
| Appartenenza | Membership | User-site link with a role |

The English terminology is what the interface uses when **EN** is selected; the technical values (`todo`, `in_progress`, `to_verify`, `closed`, `blocked`) stay identical in both languages.
