---
title: API REST
description: Riferimento degli endpoint per chi integra o amministra SiteAssistant.
---

:::tip[Questa pagina è per chi integra]
Se usi soltanto la webapp, non ti serve: questa è la documentazione tecnica dell'interfaccia HTTP che l'applicazione usa "dietro le quinte", utile per chi integra SiteAssistant o per chi lo amministra dal server.
:::

L'API è un servizio HTTP che il frontend chiama direttamente. Non esistono token API: l'autenticazione usa il cookie di sessione `sa_session`, ottenuto dal login e inviato automaticamente dal browser.

## Autenticazione e account

| Metodo | Percorso | Accesso | Note |
| :-- | :-- | :-- | :-- |
| GET | `/api/health` | nessuno | Stato del servizio |
| POST | `/api/auth/login` | nessuno | `{ email, password }`; imposta il cookie |
| GET | `/api/auth/me` | autenticato | Utente e ruoli per cantiere |
| POST | `/api/auth/logout` | autenticato | Revoca la sessione |
| POST | `/api/auth/request` | nessuno | Richiesta di accesso `{ email }` |
| GET/POST | `/api/auth/request/decide` | owner (via link email) | Approva o rifiuta una richiesta |
| POST | `/api/auth/password` | autenticato | Cambio password |
| POST | `/api/auth/forgot` | nessuno | Reset password `{ email }` |

`POST /api/auth/request` e `POST /api/auth/forgot` rispondono sempre `202 accepted`, anche quando l'email non corrisponde a un account: la risposta non rivela mai se l'indirizzo esiste. Il link di revisione inviato all'owner scade dopo **72 ore** e vale una sola volta. Richieste di accesso, reset e cambio password sono limitati per indirizzo di rete e indirizzo email. Se il servizio email non è configurato, la risposta è `503` con codice `MAIL_NOT_CONFIGURED`.

## Cantieri

| Metodo | Percorso | Accesso | Note |
| :-- | :-- | :-- | :-- |
| GET | `/api/sites` | autenticato | Solo i cantieri di cui sei membro |
| POST | `/api/sites` | owner | `code`, `name`, `location`, `start_date`, `end_date` |
| GET | `/api/sites/{id}` | membro | Dettaglio cantiere |
| GET | `/api/sites/{id}/members` | owner | Elenco membri e ruoli |
| POST | `/api/sites/{id}/members` | owner | `{ user_id, role }`; `role: null` rimuove |

## Attività

| Metodo | Percorso | Accesso | Note |
| :-- | :-- | :-- | :-- |
| GET | `/api/tasks?siteId=&status=` | membro | Filtri opzionali |
| POST | `/api/tasks` | owner/editor/verifier | Supporta `Idempotency-Key` |
| GET | `/api/tasks/{id}` | membro | Include la cronologia eventi |
| POST | `/api/tasks/{id}/transition` | owner/editor/verifier | `{ to, note?, reason? }` |

## Diario

| Metodo | Percorso | Accesso | Note |
| :-- | :-- | :-- | :-- |
| GET | `/api/diary?siteId=` | membro | Voci del cantiere |
| POST | `/api/diary` | owner/editor/verifier | Una voce per cantiere/data/turno |

## Struttura progetto (WBS) e presenze (HR)

Queste aree sono esposte in **sola lettura**. L'import degli snapshot tramite endpoint dedicati è riservato agli owner; l'import planning dall'interfaccia copre anche Time Schedule e presenze (vedi [Import degli export planning](#import-degli-export-planning)).

| Metodo | Percorso | Accesso | Note |
| :-- | :-- | :-- | :-- |
| GET | `/api/wbs?site_id=` | membro | Albero della struttura |
| GET | `/api/wbs?site_id=&flat=1` | membro | Tabella piatta |
| GET | `/api/wbs/{id}` | membro | Nodo con figli immediati |
| POST | `/api/wbs/import` | owner | Promuove uno snapshot Time Schedule |
| GET | `/api/employees?site_id=` | membro | Dipendenti del cantiere |
| GET | `/api/employees/{id}` | membro | Dipendente con i suoi work days |
| GET | `/api/work-days?site_id=&employee_id=&from=&to=` | membro | Presenze filtrate per intervallo |
| POST | `/api/employees/import` | owner | Promuove uno snapshot presenze |

## Avanzamento di cantiere

Le voci di avanzamento importate dal sistema di cantiere sono visibili nella vista **Avanzamento**. I campi importati restano in sola lettura; il completamento degli step si registra dall'applicazione o via API.

| Metodo | Percorso | Accesso | Note |
| :-- | :-- | :-- | :-- |
| GET | `/api/site-progress?site_id=&wbs_id=` | membro | Voci del cantiere; filtro opzionale per voce WBS |
| GET | `/api/site-progress/{id}` | membro | Voce con `booked_hours` (somma delle ore prenotate) e gli step |
| POST | `/api/site-progress/import` | owner | Promuove uno snapshot di avanzamento |
| GET | `/api/progress-types?site_id=` | membro | Tipi di avanzamento del cantiere |
| POST | `/api/progress-types` | owner | Crea un tipo; i pesi degli step devono sommare 100 |
| DELETE | `/api/progress-types/{id}` | owner | Elimina un tipo non assegnato |
| PATCH | `/api/site-progress/{id}/progress-type` | owner | Assegna o toglie un tipo (`progress_type_id`) |
| PUT | `/api/site-progress/{id}/steps` | owner/editor | `{ steps: [{ step_id, percent }] }`; aggiunge una registrazione allo storico |

Ogni voce riporta descrizione, area PLC, sezione, avanzamento e avanzamento pianificato, scostamento, assegnatario, date pianificate ed effettive, ritardo atteso e i contrassegni `has_files`, `has_notes`, `has_deviations`. Il collegamento alla voce WBS avviene solo quando area PLC e sezione individuano **un solo** nodo; in tutti gli altri casi la voce resta senza collegamento.

Un tipo di avanzamento è un elenco di step con un peso. La somma dei pesi deve essere **100**, altrimenti la creazione è rifiutata con `WEIGHTS_NOT_100`. Se una voce ha un tipo assegnato, l'avanzamento restituito è `computed` (media pesata degli step); senza step registrati vale `0`, non il valore importato. Ogni `PUT` inserisce una riga in `progress_entries`: lo storico non viene riscritto e le curve si calcolano da lì.

## Deviazioni

Le deviazioni sono importate e consultabili in sola lettura nell'interfaccia; gli endpoint restituiscono gli stessi dati.

| Metodo | Percorso | Accesso | Note |
| :-- | :-- | :-- | :-- |
| GET | `/api/deviations?site_id=&status=&priority=` | membro | Elenco per cantiere, con filtri opzionali |
| GET | `/api/deviations/{id}` | membro | Dettaglio con i collegamenti espliciti (`links`) |
| POST | `/api/deviations/import` | owner | Promuove uno snapshot deviazioni |

Gli stati ammessi sono `open`, `approved`, `in_progress`, `work_completed`, `closed`, `rejected`. Uno stato di origine sconosciuto o assente resta vuoto (`null`) e viene contato nell'import: non viene mai interpretato come `open`. I collegamenti puntano a `site_progress_item`, `work_day`, `task` o `diary`; l'import non li crea e non li elimina da solo.

## Prenotazioni ore

Le prenotazioni si registrano anche dalla vista **Prenotazioni ore**.

| Metodo | Percorso | Accesso | Note |
| :-- | :-- | :-- | :-- |
| GET | `/api/time-bookings?site_id=&site_progress_item_id=&work_day_id=` | membro | Elenco per cantiere, con filtri opzionali |
| POST | `/api/time-bookings` | owner/editor | `{ work_day_id, site_progress_item_id, hours }` |
| DELETE | `/api/time-bookings/{id}` | owner/editor | Elimina una prenotazione |

Le ore sono un numero finito e non negativo. Presenza e voce di avanzamento devono appartenere allo **stesso cantiere** (`TIME_BOOKING_SITE_MISMATCH`), e per la stessa coppia esiste una sola prenotazione (`TIME_BOOKING_DUPLICATE`).

## Impatti economici

| Metodo | Percorso | Accesso | Note |
| :-- | :-- | :-- | :-- |
| GET | `/api/cost-impacts?site_id=&status=` | membro | Elenco per cantiere, con filtro di stato |
| GET | `/api/cost-impacts/{id}` | membro | Dettaglio con le deviazioni collegate |
| POST | `/api/cost-impacts` | owner/editor/verifier | `{ site_id, title, deviation_ids, claim_amount?, settlement_amount? }` |
| POST | `/api/cost-impacts/{id}/transition` | owner/verifier | `{ to, result?, claim_amount?, settlement_amount? }` |

Un impatto nasce sempre `open`, richiede il titolo e **almeno una deviazione** dello stesso cantiere. Gli stati sono `open`, `notification_sent`, `submitted`, `closed`; i passaggi ammessi sono `open → notification_sent`, `notification_sent → submitted`, `submitted → closed` e `open → closed`. La chiusura richiede un esito tra `settled`, `dropped` e `rejected` e registra la data di chiusura; gli importi possono essere aggiornati durante il passaggio.

## Panoramica e assistente

| Metodo | Percorso | Accesso | Note |
| :-- | :-- | :-- | :-- |
| GET | `/api/dashboard?site_id=` | membro | Quattro indicatori, deviazioni per stato, avanzamento per sezione, ore per settimana |
| POST | `/api/assistant/chat` | membro | `{ site_id, messages, view, language }`; risposta in sola lettura con citazioni |

La dashboard calcola i valori dalle tabelle del cantiere: deviazioni per stato, media dell'avanzamento effettivo per sezione (con il pianificato), ore per settimana e importi dei reclami. L'assistente risponde nella lingua richiesta (`it` o `en`) e cita i record con `family`, `id` e `label`; se il provider non è configurato risponde `503 ASSISTANT_NOT_CONFIGURED`.

## Import degli export planning

| Metodo | Percorso | Accesso | Note |
| :-- | :-- | :-- | :-- |
| POST | `/api/import/preview` | owner/editor | `{ site_id, family, filename, data_base64 }`; non scrive nulla |
| POST | `/api/import/apply` | owner/editor | Come sopra, più `preview_token` |

`family` vale `employees`, `work_days`, `time_schedule`, `site_progress_items`, `deviations` o `daily_log`. Il file è un xlsx fino a **20 MiB**, inviato in base64. L'anteprima restituisce i conteggi `added`, `updated`, `unchanged`, `removed`, `rejected`, i campioni delle righe rifiutate e un `preview_token` valido **15 minuti**. L'applicazione verifica che il file e la famiglia siano gli stessi dell'anteprima; le righe assenti non vengono cancellate e il conteggio `removed` applicato è sempre zero.

## Allegati

Gli allegati a **attività e diario** si caricano anche dall'interfaccia; per il cantiere restano solo via API. La rimozione è solo via API.

| Metodo | Percorso | Accesso | Note |
| :-- | :-- | :-- | :-- |
| POST | `/api/attachments` | owner/editor | Carica un file (base64) |
| GET | `/api/attachments?site_id=&entity_type=&entity_id=` | membro | Metadati degli allegati |
| GET | `/api/attachments/{id}` | membro | Scarica i byte |
| DELETE | `/api/attachments/{id}` | owner/editor | Elimina |

Sono ammessi file fino a **15 MiB**, di tipo immagine o PDF (`UNSUPPORTED_MEDIA_TYPE`, `ATTACHMENT_TOO_LARGE`). Il caricamento e l'eliminazione sono riservati a owner ed editor; la lettura a tutti i membri. Prima di registrare l'allegato l'applicazione rilegge i byte salvati e confronta il checksum: se non coincide, il file viene rimosso e la risposta è `502`.

## Errori

Le risposte d'errore hanno la forma `{ "error": "messaggio", "code": "CODICE" }`. I codici più comuni: `VALIDATION_ERROR` (400), `INVALID_CREDENTIALS` (401), `FORBIDDEN` (403), `NOT_FOUND` (404), `DUPLICATE_SITE_CODE` e `DUPLICATE_DIARY` (409), `INVALID_TRANSITION` e `TIME_BOOKING_DUPLICATE` (409), `SEPARATE_PEOPLE_REQUIRED` (400), `NOTE_REQUIRED`/`REASON_REQUIRED` (400), `WEIGHTS_NOT_100` (400), `FILE_TOO_LARGE` (413), `LINK_EXPIRED` (410), `ATTACHMENT_TOO_LARGE` (413), `UNSUPPORTED_MEDIA_TYPE` (415), `RATE_LIMITED` (429), `MAIL_NOT_CONFIGURED`/`MAIL_UNAVAILABLE` (503), `ASSISTANT_NOT_CONFIGURED` (503).

:::note
L'API non espone uno schema OpenAPI: le tabelle qui sopra sono il contratto corrente. Per lo schema dati completo vedi `database/README.md` nel repository.
:::
