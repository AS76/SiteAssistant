# Glossario di Dominio IT / EN — Domain Glossary

Questo glossario definisce i termini chiave di dominio utilizzati in SiteAssistant, stabilendo la corrispondenza semantica e concettuale tra la terminologia italiana e quella inglese.

---

| Termine IT | Termine EN | Descrizione e Regola di Dominio |
| :--- | :--- | :--- |
| **Cantiere** | **Site** | L'unità organizzativa e geografica in cui si svolgono i lavori di installazione, montaggio o automazione. Nello schema applicativo attuale possiede un codice univoco (`code`), un nome descrittivo, un'ubicazione e date di inizio/fine; l'associazione a un fuso orario (`timezone`) e a un orario di taglio per il giorno operativo (`day_cutoff_time`) è prevista dalla specifica (non ancora implementata nello schema applicativo). |
| **Attività** | **Task** | La singola unità di lavoro esecutivo assegnata a un'impresa e tracciata nel cantiere. Possiede un ciclo di vita governato da stati (`todo`, `in_progress`, `to_verify`, `closed`, `blocked`), una scadenza e la separazione obbligatoria tra esecutore e verificatore. |
| **Esecutore** | **Executor / Assignee** | La persona o il caposquadra designato come responsabile materiale dello svolgimento dell'attività. Ha la facoltà di avviare il task e sottometterlo a verifica fornendo una nota di evidenza. |
| **Verifica** | **Verification / Review** | L'atto formale di ispezione tecnica e collaudo con cui il verificatore designato accerta che l'attività sia stata completata a regola d'arte secondo le specifiche di progetto, prima della chiusura definitiva. |
| **Verificatore** | **Verifier / Reviewer** | Il tecnico o ispettore di qualità designato al momento della creazione del task. È l'unica figura abilitata a transitare il task da `to_verify` a `closed`. Deve essere obbligatoriamente una persona distinta dall'esecutore. |
| **Diario di cantiere** | **Site Diary / Logbook** | Il giornale dei lavori in cui vengono annotati formalmente il piano del turno, le attività effettivamente eseguite (consuntivo), i blocchi riscontrati e le consegne per il turno successivo. È indicizzato in modo univoco per cantiere, giorno operativo e turno. |
| **Turno** | **Shift** | La frazione operativa del giorno lavorativo. Nel modello standard si distingue in turno diurno (`day`) e turno notturno (`night`). |
| **Giorno operativo** | **Operational Day** | La convenzione temporale che definisce i limiti del giorno lavorativo di cantiere. A differenza del giorno solare (mezzanotte-mezzanotte), il giorno operativo $D$ inizia all'ora di taglio prefissata (default `06:00:00` locali) e termina alle `05:59:59` del giorno successivo. I turni notturni e gli eventi prima delle 06:00 appartengono al giorno operativo in cui il turno ha avuto inizio. |
| **Ora di taglio** | **Cutoff Time** | L'orario locale (default `06:00`) che delimita il passaggio tra un giorno operativo e il successivo. Evita lo spezzamento contabile dei turni notturni a cavallo di mezzanotte. |
| **Deviazione** | **Deviation / Snag / Non-conformity** | Uno scostamento rispetto al piano di progetto, al cronoprogramma o alle specifiche costruttive. Include non-conformità di cantiere, interferenze fisiche o difetti di montaggio da sanare. Nello schema d'ingestione è gestita con identificatore univoco e tracciamento dello storico. |
| **Stato ufficiale** | **Official Status** | Lo stato formale di una lavorazione, presenza o consegna registrato nei sistemi informativi primari aziendali (ERP, P6, portali fornitore). Conservato in modo immutabile negli snapshot d'importazione. |
| **Stato interno** | **Internal Status** | Lo stato reale di avanzamento e verifica gestito direttamente dal Site Manager sul campo all'interno di SiteAssistant. Non sovrascrive né viene sovrascritto in modo distruttivo dallo stato ufficiale. |
| **Annotazione interna** | **Internal Annotation** | Nota tecnica, commento operativo o marcatura di integrazione collegata a una voce di progetto o a un record sorgente, persistente anche in caso di nuove importazioni del file sorgente. |
| **Impedimento / Blocco** | **Impediment / Blocker** | Causa ostativa di natura tecnica, logistica, meteorologica o di sicurezza che impedisce la prosecuzione regolare di un'attività o del turno. Richiede motivazione obbligatoria per la registrazione. |
| **Evidenza** | **Evidence** | Nota descrittiva, riscontro dimensionale (e in prospettiva foto o allegato firmato) prodotta dall'esecutore per attestare l'ultimazione di un compito e consentirne la verifica. |
