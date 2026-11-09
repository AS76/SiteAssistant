# Employees e Work Days

L'incremento 10 aggiunge due proiezioni applicative in sola lettura e le relative API. Gli employees sono record di cantiere, distinti dagli account `users`. Non sono previste modifiche manuali delle presenze né scritture verso la sorgente.

## Schema e configurazione

`server/migrations/{pg,sqlite}/009_employees_workdays.sql` crea `employees`, `work_days`, l'indice `(site_id, employee_id, operational_date)` e `hr_import_sources`. Come le altre migrazioni, usa lo schema applicativo selezionato dalla connessione PostgreSQL e le tabelle principali in SQLite. Non modifica le migrazioni precedenti e non è stata applicata a un database operativo.

La configurazione fidata `hr_import_sources(site_id, scope_id, run_id)` associa esplicitamente un cantiere al run da promuovere. È indipendente dalla configurazione WBS; non viene dedotta dai nomi né accettata dal corpo HTTP. L'ingestione e il provisioning di questa associazione restano prerequisiti esterni. PostgreSQL richiede gli schemi definiti da `database/import-schema.sql`; SQLite richiede database d'ingestione preparati e collegati come `ingest` e `source_snapshot` sulla stessa connessione, come per il WBS.

L'import accetta un run `ready` con `completeness_verified`, entrambi i batch `employees` e `work_days` in stato `typed`, scope coerenti e conteggi uguali a `expected_rows`. Identità mancanti, duplicate o non riconciliate bloccano l'intera promozione. Le tabelle raw e gli snapshot non vengono modificati.

## Identità e valori sorgente

- `employee_no` è univoco per cantiere. L'ID applicativo dipende da cantiere e numero dipendente; `source_entity_key_id` mantiene il riferimento all'identità d'ingestione.
- I work days hanno ID deterministici basati su cantiere, scope e `source_uuid`. `employee_no` viene risolto esclusivamente nello snapshot Employees selezionato. Un numero assente nello snapshot richiede riconciliazione; un numero sorgente null lascia `employee_id` null.
- `operational_date`, `hire_date`, `expire_date`, `start_time` e `finish_time` conservano i valori di calendario sorgente. Le API restituiscono date e orari senza conversioni di fuso; gli orari mantengono secondi e frazioni disponibili. Una data operativa mancante impedisce l'import.
- `shift` usa `shiftOf` con inizio giorno 06:00 e inizio notte 18:00, sul solo orario sorgente. L'ancoraggio tecnico UTC serve a classificare l'orario senza convertirlo e non determina la data operativa. Un `start_time` null produce `shift` null. Una coppia che attraversa mezzanotte resta invariata.
- `work_time_source`, `open_hours_source` e `booked_hours_source` alimentano rispettivamente `work_time`, `open_hours` e `booked_hours`. Semantica TBD: nessun calcolo di durata, totale, normalizzazione o interpretazione aggiuntiva. Null, zero e stato sorgente restano distinti.

La promozione è transazionale e serializzata per cantiere. Ripetere lo stesso run e gli stessi batch restituisce `unchanged: true` con conteggi zero, mantenendo ID e timestamp. Un nuovo run sostituisce la proiezione corrente, mantenendo ID e `created_at` delle identità ancora presenti. Lo storico rimane negli snapshot d'ingestione; i run completati sono trattati come immutabili e le correzioni richiedono un nuovo run.

## API

| Route | Risultato | Accesso |
| --- | --- | --- |
| `GET /api/employees?site_id=…` | Array ordinato per `employee_no` | Membership del cantiere, incluso viewer |
| `GET /api/employees/:id` | Dipendente con array `work_days` | Membership del cantiere del dipendente |
| `GET /api/work-days?site_id=…&employee_id=…&from=…&to=…` | Array ordinato per data e ID; filtri opzionali, estremi inclusivi `YYYY-MM-DD` | Membership del cantiere |
| `POST /api/employees/import` | Corpo `{ "site_id": "UUID sintetico del cantiere" }`; risultato `{ employees, work_days, unchanged, run_id }` | Owner del cantiere |

Il ruolo amministrativo attuale è `owner`: non esiste un ruolo `admin` distinto. L'import verifica i permessi anche nel repository. Le letture interne del repository sono fidate; le route richiedono sessione e membership. Non sono esposti endpoint di editing.

Errori di configurazione o sorgente restituiscono `409` con codice `HR_SOURCE_NOT_CONFIGURED`, `HR_SOURCE_UNAVAILABLE`, `HR_RUN_NOT_READY`, `HR_INCOMPLETE_SNAPSHOT` o `HR_RECONCILIATION_REQUIRED`, senza modificare la proiezione precedente. Filtri non validi restituiscono `400`.

## Verifiche e attivazione

`tests/hr.test.mjs`, registrato in `tests/index.js`, verifica le migrazioni e la promozione su SQLite e PostgreSQL in memoria con fixture sintetiche, inclusi filtri, permessi tramite listener HTTP, rollback, nuovi run e idempotenza. `npm run test:schema` verifica separatamente il contratto d'ingestione. I test HTTP esistenti con socket restano nel runner e possono richiedere l'host fuori sandbox.

Questo incremento non aggiunge UI, servizi remoti, deploy o import di file. Nessun servizio è stato attivato.
