# SiteAssistant — prima versione

## Obiettivo

Collegare pianificazione, lavoro eseguito, verifica e diario del cantiere in una sola esperienza utilizzabile da telefono e desktop. Interfaccia italiano/inglese; contenuti dell'utente nella lingua originale.

## Flussi implementati nella demo

| Area | Comportamento | Criterio verificabile |
| --- | --- | --- |
| Cantieri | Creazione con codice, nome, ubicazione e date | Codice unico, nome obbligatorio, fine non precedente all'inizio |
| Contesto | Selezione cantiere e filtri attività | Dashboard, board, elenco e diario riferiti allo stesso cantiere |
| Attività | Titolo, area/asset, impresa, esecutore, verificatore, priorità e scadenza | Esecutore e verificatore distinti; date e campi validati |
| Stati | Da fare → in corso → da verificare → chiusa; blocco e riapertura | Verifica consentita solo alla persona designata, diversa da chi dichiara l'esecuzione; motivo richiesto per blocco, rifiuto e riapertura |
| Evidenze | Nota testuale al completamento e alla verifica | Nessuna proposta di completamento o chiusura senza nota |
| Storico | Autore, data e motivazione delle transizioni | Riapertura non cancella gli eventi precedenti |
| Diario | Data operativa, turno diurno/notturno, attività opzionale, piano, consuntivo, impedimenti e prossimo passo | Un'intestazione per cantiere/giorno; contributi del turno notturno riferiti esplicitamente al giorno scelto |
| Conteggi | Da eseguire, da verificare, chiuse e scadute | Una proposta di completamento non conta come chiusura; una card da verificare può essere scaduta |
| Portabilità | CSV filtrato, stampa diario, backup e ripristino JSON | Formule CSV neutralizzate; ripristino con validazione e conferma; errori senza cancellare dati correnti |
| Persistenza | API server + PostgreSQL (Neon); offline-first previsto (incremento 15) | Avviso se il salvataggio non riesce; testo dei form conservato dopo un errore |

## Interfaccia

Quattro sezioni: panoramica, cantieri, attività e diario. Il dettaglio attività mostra criteri di accettazione e timeline; il diario collega turno, attività e risultato. Stato esplicitato con testo oltre al colore. Modali con etichette, focus iniziale e chiusura via tastiera. I filtri non modificano i dati e rimangono chiari anche in assenza di risultati.

## Confini

Questa versione è una demo locale, non un sistema aziendale distribuito. Tutti gli esempi sono sintetici. Le identità selezionabili simulano i ruoli, senza offrire autenticazione. Le regole di transizione nel browser servono a discutere il processo, non proteggono dati da un utente che controlla il dispositivo.

## Successiva versione operativa

- Autenticazione, autorizzazioni server e isolamento per organizzazione/cantiere.
- Database, migrazioni, concorrenza controllata, backup verificati e ripristino.
- Foto e allegati privati con limiti e autorizzazioni.
- Diario inviato/chiuso e rettifiche versionate, esportazione PDF server.
- Import con anteprima, mapping, fonte/revisione e snapshot immutabili; nessuna ricostruzione dello storico dai soli stati correnti.
- Fonti autorevoli delle milestone distinte dai tracker di avanzamento.
- Offline e sincronizzazione solo dopo aver definito conflitti e protezione della cache.

Prima del rilascio operativo vanno concordati ruoli, modello di diario, volumi, hosting, conservazione dei dati e necessità di integrazioni.

## Direzione della versione multiutente

Uso interno e complementare a un sistema sorgente: import di export, consultazione di file S3 autorizzati e arricchimenti locali. Snapshot e stati originali rimangono separati da note, consuntivi e verifiche interne. Nessuna sincronizzazione in scrittura con il sistema sorgente è prevista. Connettori API/MCP e profili reali sono da verificare; vedere [Import e archivio documenti](import-storage.md).

Prima fase: attività e coordinamento, qualità/deviazioni, pianificazione/avanzamento e diario; documenti, storico e dashboard come servizi condivisi. I moduli saranno abilitabili per cantiere, con logistica ed engineering nei successivi incrementi.

L'area **Pianificazione, layout e mappe** riceverà pianificazioni Excel e documenti grafici PDF, immagini ad alta risoluzione e originali CAD. Gantt e altre viste condividono voci aggiornabili per percentuale, quantità installata o azione sì/no. Baseline, piano corrente, avanzamento dichiarato e verifica rimangono distinti. La visualizzazione/conversione CAD è soggetta a compatibilità e scelta del motore. Vedere [Specifica funzionale](planning-layouts.md); queste funzioni non sono ancora implementate.

La proposta tecnica usa PostgreSQL relazionale e API server; **Neon** è il database gestito (`eu-central-1`) e l'app gira sul VPS Hostinger dietro Traefik. I file si integrano tramite S3 compatibile (iDrive e2, bucket `siteassistant`). L'autenticazione è locale (email+password). Stato reale e stack in [Architettura](architecture.md).
