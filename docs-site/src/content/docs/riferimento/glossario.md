---
title: Glossario
description: Terminologia italiana e inglese usata in SiteAssistant.
---

| Italiano | English | Significato |
| :-- | :-- | :-- |
| Cantiere | Site | Unità organizzativa che raccoglie attività e diario |
| Attività | Task | Unità di lavoro con esecutore e verificatore distinti |
| Tipo di attività | Task type | Classificazione dell'attività: ordinaria (predefinita) o correttiva |
| Idoneità | Fitness | Certificazione di un dipendente: abilitazione, visita medica, formazione o altro attestato |
| HSE | HSE | Registro di near miss, infortuni e osservazioni di cantiere, senza dati sanitari |
| Esecutore | Executor | Chi esegue materialmente l'attività |
| Verificatore | Verifier | Chi controlla e chiude il lavoro |
| Sottomissione | Submission | Passaggio a `to_verify` con nota di esecuzione |
| Verifica | Verification | Approvazione che porta l'attività a `closed` |
| Blocco | Block | Stato `blocked` con motivazione |
| Riapertura | Reopen | Ritorno a `in_progress` di un'attività chiusa |
| Diario | Site diary / Logbook | Piano, consuntivo, impedimenti e prossimo passo per turno |
| Turno | Shift | Frazione operativa: `day` o `night` |
| Giorno operativo | Operational day | Giorno che inizia all'ora di taglio (default 06:00), non a mezzanotte |
| Ora di taglio | Cutoff time | Orario locale che separa due giorni operativi |
| Struttura progetto | Project structure (WBS) | Gerarchia dei lavori importata dal Time Schedule, in sola lettura |
| Padre sintetico | Synthetic parent | Voce WBS ricostruita perché mancava nel Time Schedule |
| Dipendente | Employee | Record del personale di cantiere (proiezione in sola lettura) |
| Presenza | Work day | Giornata lavorativa di un dipendente, con orari e turno |
| Avanzamento di cantiere | Site progress | Voce di avanzamento importata, collegata alla WBS quando la corrispondenza è univoca |
| Tipo di avanzamento | Progress type | Insieme di step con pesi che definisce come si misura una voce |
| Peso dello step | Step weight | Percentuale di una voce assegnata a uno step; la somma deve essere 100 |
| Storico avanzamento | Progress history | Registrazioni in sola aggiunta da cui si calcolano le curve |
| Ore pianificate | Planned hours | Ore previste per una voce di avanzamento; se assenti si usano quelle del nodo WBS collegato |
| Earned value | Earned value | Blocco EV, PV, AC, CPI e SPI calcolato dalle ore pianificate e dalle ore prenotate |
| Mappatura colonne | Column mapping | Alias e campi di identità configurati per cantiere e famiglia di import |
| Identità di riga | Row identity | Campi che riconoscono una riga tra un import e il successivo |
| Import planning | planning import | Caricamento di un export xlsx con anteprima e conferma, senza cancellazioni |
| Assistente dati | Data assistant | Pannello di domande sui dati del cantiere, in sola lettura |
| Impostazioni | Settings | Valuta, decimali e separatori degli importi, salvati nel browser |
| Deviazione | Deviation | Scostamento importato, con stato, priorità e date |
| Prenotazione ore | Time booking | Ore di una presenza attribuite a una voce di avanzamento |
| Impatto economico | Cost impact | Richiesta interna collegata a una o più deviazioni, con importo e esito |
| Esito | Result | Chiusura di un impatto economico: `settled`, `dropped` o `rejected` |
| Allegato | Attachment | File collegato ad attività, diario o cantiere (solo API) |
| Richiesta di accesso | Access request | Richiesta autonoma di un account, approvata da un owner |
| Ruolo di cantiere | Site role | `owner`, `editor`, `verifier`, `viewer` |
| Evidenza | Evidence | Nota testuale che accompagna la sottomissione |
| Appartenenza | Membership | Legame utente-cantiere con un ruolo |

La terminologia inglese è quella usata dall'interfaccia quando si seleziona **EN**; i valori tecnici (`todo`, `in_progress`, `to_verify`, `closed`, `blocked`) restano identici in entrambe le lingue.
