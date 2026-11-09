---
title: Glossary
description: Italian and English terminology used in SiteAssistant.
---

| Italiano | English | Meaning |
| :-- | :-- | :-- |
| Cantiere | Site | Organising unit that holds tasks and diary |
| Attività | Task | Unit of work with distinct executor and verifier |
| Esecutore | Executor / Assignee | The person who performs the task |
| Verificatore | Verifier / Reviewer | The person who checks and closes the work |
| Sottomissione | Submission | Move to `to_verify` with an evidence note |
| Verifica | Verification | Approval moving the task to `closed` |
| Rifiuto | Rejection | Return to `in_progress` with a note |
| Blocco | Block | `blocked` status with a reason |
| Riapertura | Reopen | Moving a closed task back to `in_progress` |
| Diario | Site diary / Logbook | Plan, actuals, impediments and next step per shift |
| Turno | Shift | Operational fraction: `day` or `night` |
| Giorno operativo | Operational day | Day starting at the cutoff time (default 06:00), not midnight |
| Ora di taglio | Cutoff time | Local time separating two operational days |
| Ruolo di cantiere | Site role | `owner`, `editor`, `verifier`, `viewer` |
| Evidenza | Evidence | Text note accompanying the submission |
| Appartenenza | Membership | User-site link with a role |

The English column is what the interface shows when **EN** is selected; technical values (`todo`, `in_progress`, `to_verify`, `closed`, `blocked`) are identical in both languages.
