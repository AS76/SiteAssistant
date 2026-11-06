# Ripresa dello sviluppo con Codex

## Stato del repository

È implementata una demo web locale IT/EN con cantieri, attività, flusso di verifica, diario, persistenza nel browser, backup JSON, CSV e stampa. Non esistono ancora un backend applicativo, login reale, importatore operativo, connessione S3 o deploy Railway.

La direzione scelta è un'app interna complementare a un sistema sorgente. Railway ospiterà applicazione e PostgreSQL nello stesso progetto. I file saranno collegati tramite storage S3 compatibile; MCP è un canale opzionale, da verificare sul sistema che lo rende disponibile.

## Ripartire dal codice

In una nuova macchina, clonare il repository; se il checkout esiste già, riutilizzarlo preservando modifiche locali:

```sh
git clone https://github.com/AS76/SiteAssistant.git
cd SiteAssistant
```

Usare Node.js 24 per gli strumenti di sviluppo e Python 3 per il server statico:

```sh
npm ci
npm test
npm run test:schema
python3 -m http.server 8000 --bind 127.0.0.1 --directory app
```

Aprire la porta 8000 nel browser locale. La demo non condivide dati tra dispositivi. Il server statico rimane un processo in primo piano; i test vanno eseguiti prima o in un'altra console.

## Documenti da leggere

1. [Requisiti e comportamento attuale](requirements.md).
2. [Architettura e base dati](architecture.md).
3. [Infografica tecnica e macroaree](architecture-overview.html).
4. [Pianificazione, layout e mappe](planning-layouts.md).
5. [Import e archivio documenti](import-storage.md).
6. [Schema SQL e verifiche](../database/README.md).
7. [Scelte di hosting e costi](cost-options.md).

## Dati e profili privati

Il repository non contiene export reali, dossier analitici o mapping specifici di account e organizzazioni. L'accesso a tali materiali deve essere fornito dall'utente tramite un canale privato autorizzato; non si può ricostruire dal repository pubblico e non va cercato automaticamente nel sistema ospitante.

Per proseguire l'importatore servono il profilo di mapping privato e i file selezionati, conservati fuori dal checkout. Il codice applicativo dovrà ricevere percorsi o riferimenti configurati privatamente e validare il profilo. Un profilo privato non va copiato nei test pubblici: creare fixture sintetiche con gli stessi vincoli tecnici e senza testi o identificativi reali.

Lo schema SQL pubblicato usa nomi canonici, inclusi nomi generici per i campi custom. Il mapping deve essere revisionato rispetto a questi nomi; un vecchio profilo può richiedere adattamento. Non applicare automaticamente un dossier privato o uno script di analisi come migrazione di produzione.

## Prossimo incremento proposto

1. Introdurre API Node.js/TypeScript e configurazione di sviluppo locale, con test automatici e dati sintetici.
2. Integrare schema d'ingestione e modello applicativo in migrazioni versionate; definire identità, accessi e contesti.
3. Implementare anteprima e mapping di una famiglia di export; mantenere raw, snapshot e aggiornamenti interni separati. Lavorare sui file reali solo nel contesto privato autorizzato.
4. Sostituire progressivamente localStorage con API, mantenendo il comportamento della demo e gestendo conflitti di versione.
5. Integrare autenticazione e lettura S3 per file selezionati; poi preparare il deploy Railway, verificando piano e configurazione.

Non è necessario riscrivere subito il frontend. Pianificazione Gantt, progressi per percentuale/quantità/sì-no, PDF e immagini sono requisiti progettati; non funzionalità già disponibili. La compatibilità CAD richiede verifica e non è presunta dal solo caricamento del file.

## Verifiche disponibili

- `npm test`: regole della demo e formati di esportazione.
- `npm run test:schema`: schema PostgreSQL con dati sintetici, in memoria.
- `node tests/browser.cjs`: flussi desktop/mobile; richiede Playwright e Chromium. Configurare `SITEASSISTANT_URL` se il server usa un'altra porta e `CHROMIUM_PATH` se necessario.

Nel prompt di ripresa si può chiedere: «Leggi AGENTS.md e docs/development-handoff.md. Prosegui con il primo incremento backend usando dati sintetici, senza deploy e senza pubblicare materiali privati».
