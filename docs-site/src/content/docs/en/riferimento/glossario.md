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
| Avanzamento di cantiere | Site progress | Imported progress item, linked to the WBS when the match is unique |
| Tipo di avanzamento | Progress type | Set of weighted steps defining how an item is measured |
| Peso dello step | Step weight | Percentage of an item assigned to a step; the total must be 100 |
| Storico avanzamento | Progress history | Append-only records the curves are calculated from |
| Ore pianificate | Planned hours | Expected hours for a progress item; when missing, those of the linked WBS node are used |
| Earned value | Earned value | EV, PV, AC, CPI and SPI block calculated from planned hours and booked hours |
| Mappatura colonne | Column mapping | Aliases and identity fields configured per site and import family |
| Identità di riga | Row identity | Fields that identify a row between one import and the next |
| Import planning | planning import | Upload of an xlsx export with preview and confirmation, with no deletions |
| Assistente dati | Data assistant | Question panel over the site data, read-only |
| Impostazioni | Settings | Currency, decimals and separators for amounts, stored in the browser |
| Deviazione | Deviation | Imported deviation, with status, priority and dates |
| Prenotazione ore | Time booking | Hours of an attendance day assigned to a progress item |
| Impatto economico | Cost impact | Internal claim linked to one or more deviations, with amount and result |
| Esito | Result | Closure of a cost impact: `settled`, `dropped` or `rejected` |
| Allegato | Attachment | File linked to a task, diary or site (API only) |
| Richiesta di accesso | Access request | Self-service request for an account, approved by an owner |
| Ruolo di cantiere | Site role | `owner`, `editor`, `verifier`, `viewer` |
| Evidenza | Evidence | Text note accompanying the submission |
| Appartenenza | Membership | User-site link with a role |

The English terminology is what the interface uses when **EN** is selected; the technical values (`todo`, `in_progress`, `to_verify`, `closed`, `blocked`) stay identical in both languages.
