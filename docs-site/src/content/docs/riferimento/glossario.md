---
title: Glossario
description: Terminologia italiana e inglese usata in SiteAssistant.
---

| Italiano | English | Significato |
| :-- | :-- | :-- |
| Cantiere | Site | Unità organizzativa che raccoglie attività e diario |
| Attività | Task | Unità di lavoro con esecutore e verificatore distinti |
| Esecutore | Executor / Assignee | Chi esegue materialmente l'attività |
| Verificatore | Verifier / Reviewer | Chi controlla e chiude il lavoro |
| Sottomissione | Submission | Passaggio a `to_verify` con nota di evidenza |
| Verifica | Verification | Approvazione che porta l'attività a `closed` |
| Rifiuto | Rejection | Rimando a `in_progress` con nota |
| Blocco | Block | Stato `blocked` con motivazione |
| Riapertura | Reopen | Ritorno a `in_progress` di un'attività chiusa |
| Diario | Site diary / Logbook | Piano, consuntivo, impedimenti e prossimo passo per turno |
| Turno | Shift | Frazione operativa: `day` o `night` |
| Giorno operativo | Operational day | Giorno che inizia all'ora di taglio (default 06:00), non a mezzanotte |
| Ora di taglio | Cutoff time | Orario locale che separa due giorni operativi |
| Ruolo di cantiere | Site role | `owner`, `editor`, `verifier`, `viewer` |
| Evidenza | Evidence | Nota testuale che accompagna la sottomissione |
| Appartenenza | Membership | Legame utente-cantiere con un ruolo |

La terminologia inglese è quella usata dall'interfaccia quando si seleziona **EN**; i valori tecnici (`todo`, `in_progress`, `to_verify`, `closed`, `blocked`) restano identici in entrambe le lingue.
