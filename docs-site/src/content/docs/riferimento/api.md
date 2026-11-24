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

`POST /api/auth/login` conta solo gli accessi con password falliti per la stessa email e lo stesso indirizzo di rete, in una finestra mobile di **15 minuti**. Un accesso con password riuscito azzera il conteggio. Dopo **10 fallimenti** nella finestra, la richiesta successiva riceve `429 RATE_LIMITED`. Il tempo restante prima di riprovare è espresso in secondi nell'intestazione `Retry-After` e nel campo numerico `retry_after` del corpo JSON. L'accesso con passkey ha un limite separato basato sul numero di richieste.

`POST /api/auth/request` e `POST /api/auth/forgot` rispondono sempre `202 accepted`, anche quando l'email non corrisponde a un account: la risposta non rivela mai se l'indirizzo esiste. Il link di revisione inviato all'owner scade dopo **72 ore** e vale una sola volta. Richieste di accesso, reset e cambio password sono limitati per indirizzo di rete e indirizzo email. Se il servizio email non è configurato, la risposta è `503` con codice `MAIL_NOT_CONFIGURED`.

## Passkey (WebAuthn)

Il backend espone le rotte per l'accesso con **passkey** e l'interfaccia le usa: dal modulo di accesso si entra con **Accedi con passkey** o **Usa una passkey senza email**, e la finestra **Sicurezza** delle Impostazioni elenca, rinomina ed elimina le passkey dell'account. Il servizio non è attivo finché il server non riceve `WEBAUTHN_RP_ID` e `WEBAUTHN_ORIGIN`. Senza quelle variabili le rotte rispondono `503 WEBAUTHN_NOT_CONFIGURED` e l'applicazione lo mostra come messaggio; le tabelle del database aggiunte con la migrazione non attivano nulla da sole.

| Metodo | Percorso | Accesso | Note |
| :-- | :-- | :-- | :-- |
| POST | `/api/auth/webauthn/register/options` | utente autenticato | Opzioni di registrazione; il corpo è un oggetto JSON vuoto |
| POST | `/api/auth/webauthn/register/verify` | utente autenticato | Registra una passkey per l'utente della sessione; risponde `{ id, name }` |
| POST | `/api/auth/webauthn/login/options` | nessuno | `{ email }` oppure `{ discoverable: true }` |
| POST | `/api/auth/webauthn/login/verify` | nessuno | Verifica la passkey, imposta il cookie e risponde `{ user, assurance: "passkey" }` |
| GET | `/api/auth/credentials` | utente autenticato | Passkey dell'utente: `id`, `credential_id`, `name`, `transports`, `created_at`, `last_used_at` |
| PATCH | `/api/auth/credentials/{id}` | utente autenticato | `{ name }`, da 1 a 100 caratteri dopo il taglio degli spazi |
| DELETE | `/api/auth/credentials/{id}` | utente autenticato | Elimina la passkey e revoca le sessioni aperte con essa |

Le opzioni di registrazione e di accesso restituiscono le opzioni per il browser più un `challenge_id` generato dal server. Il client deve conservare `challenge_id` a parte: la risposta della credenziale non lo contiene. La verifica si invia nell'involucro `{ "challenge_id": "…", "response": { "id": "…", "response": {} } }`, dove `response` è la risposta completa del browser; senza un `challenge_id` in forma di UUID o senza `response.id` la risposta è `400 VALIDATION_ERROR`. La sfida scade dopo **cinque minuti** e viene consumata prima della verifica crittografica: una sfida scaduta, già usata o non verificata risponde `401 INVALID_CREDENTIALS`, senza distinguere il motivo. La registrazione esclude le passkey già iscritte dall'utente e richiede la verifica dell'utente; la verifica dell'accesso richiede la stessa verifica e aggiorna il contatore della credenziale, rifiutando un contatore che non avanza.

`login/options` accetta `{ email }` oppure `{ discoverable: true }`: l'email non distingue maiuscole e minuscole e un indirizzo senza account riceve la stessa forma di opzioni, senza che la risposta riveli se l'account esiste. `login/verify` crea una sessione con `auth_method` `webauthn` e `assurance` `passkey`, con la stessa durata delle altre sessioni: **7 giorni**. `DELETE` sull'ultima passkey rimasta di un utente risponde `409 LAST_CREDENTIAL`, perché una passkey eliminata non si può usare per rientrare; una passkey di un altro utente, o un identificativo che non è un UUID, risponde `404 NOT_FOUND` o `400 VALIDATION_ERROR`. Le rotte consumano il limite generale delle richieste; `login/options` e `login/verify` consumano anche il limite dei tentativi di accesso.

`register/verify` ricontrolla la sessione con cui è stata chiesta l'iscrizione: se è stata revocata o è scaduta, la risposta è `401 AUTH_REQUIRED` e la passkey non viene registrata. `PATCH` e `DELETE` fanno lo stesso controllo sulla sessione della richiesta. Un `401` su `login/options`, `login/verify` o `register/verify` non è una sessione scaduta per l'interfaccia: il modulo di accesso e la finestra **Sicurezza** restano aperti e mostrano il messaggio, senza riportare alla schermata di accesso.

## Cantieri

| Metodo | Percorso | Accesso | Note |
| :-- | :-- | :-- | :-- |
| GET | `/api/sites` | autenticato | Solo i cantieri di cui sei membro |
| POST | `/api/sites` | owner | `code`, `name`, `location`, `start_date`, `end_date`, `jurisdiction`, `time_zone`, `day_cutoff_time` |
| GET | `/api/sites/{id}` | membro | Dettaglio cantiere |
| PATCH | `/api/sites/{id}` | owner | Aggiorna uno o più campi tra `jurisdiction`, `time_zone` e `day_cutoff_time` |
| GET | `/api/sites/{id}/members` | owner | Elenco membri e ruoli, con le email |
| POST | `/api/sites/{id}/members` | owner | `{ user_id, role }`; `role: null` rimuove |
| GET | `/api/sites/{id}/assignable` | owner/editor/verifier | Membri attivi con `user_id`, `name` e `role`, senza email |
| GET | `/api/member-access?site_id=` | membro | Matrice effettiva degli accessi per modulo, per membro |
| PUT | `/api/member-access` | owner | `{ site_id, member_id, module, allowed }`; aggiorna un accesso |

Ogni cantiere dichiara una **giurisdizione**, `IT` o `UK`: è il diritto che si applica al cantiere e non dipende dalla lingua dell'interfaccia. Se `POST /api/sites` non la indica vale `IT`, che è anche il valore delle righe create prima dell'introduzione del campo. `GET /api/sites` e `GET /api/sites/{id}` restituiscono `jurisdiction`, `time_zone` e `day_cutoff_time`. In creazione questi campi sono facoltativi. Il fuso predefinito è `Europe/Rome` per `IT` e `Europe/London` per `UK`. L'ora di taglio predefinita è `06:00`.

`PATCH /api/sites/{id}` è riservato agli owner e accetta uno o più dei campi `jurisdiction` (`IT` o `UK`), `time_zone` (identificatore IANA) e `day_cutoff_time` (ora locale in formato `HH:MM`). I campi omessi conservano il valore corrente. Un corpo vuoto, un campo sconosciuto o un valore non valido restituisce `400 VALIDATION_ERROR`. Il salvataggio scrive un evento `update` con `entity_type` `site` nel registro di audit. La giurisdizione si imposta via API.

`GET /api/member-access` restituisce `members`, ognuno con `user_id`, `email`, `name`, `role` e `modules`, la mappa dei moduli con il valore effettivo. `PUT` accetta i moduli `overview`, `tasks`, `deviations`, `diary`, `progress`, `bookings`, `wbs`, `impacts`, `tools`, `certifications`, `hse`, `sites`, `logistics`, `reporting`, `workforce_names` e `workforce_presence`; `overview` e `sites` restano sempre consentiti e un owner non può escludere se stesso, altrimenti la risposta è `400 ACCESS_INVALID`. Un modulo escluso risponde `403 MODULE_FORBIDDEN` in lettura e in scrittura; Panoramica, report e assistente non leggono i moduli esclusi.

`logistics`, `workforce_names` e `workforce_presence` richiedono un'autorizzazione esplicita con `allowed: true` per i membri che non sono owner. Gli altri moduli sono consentiti per impostazione predefinita. Gli owner del cantiere hanno sempre accesso a tutti i moduli. Un owner può concedere l'accesso da [Accessi per modulo](../../amministrazione/utenti-e-ruoli/#accessi-per-modulo) o via API.

## Attività

| Metodo | Percorso | Accesso | Note |
| :-- | :-- | :-- | :-- |
| GET | `/api/tasks?site_id=&status=&kind=` | membro | Filtri opzionali; accetta anche `siteId` |
| POST | `/api/tasks` | owner/editor/verifier | Supporta `Idempotency-Key`; `kind` vale `ordinary` (predefinito) o `corrective` |
| GET | `/api/tasks/{id}` | membro | Include la cronologia eventi |
| POST | `/api/tasks/{id}/transition` | owner/editor/verifier | `{ to, note?, reason? }` |

`POST /api/tasks` accetta i nomi `executor` e `verifier` insieme agli identificativi `executor_id` e `verifier_id`: i nomi restano sull'attività come riferimento leggibile, gli identificativi la collegano agli account e sono quelli che contano per i permessi. Con gli identificativi, la verifica e la riapertura spettano al verificatore designato o a un owner; senza identificativi — un'attività assegnata con un nome libero — servono solo gli owner. Esecutore e verificatore devono restare due persone diverse anche per identificativo, altrimenti la risposta è `400 SEPARATE_PEOPLE_REQUIRED`. `GET /api/sites/{id}/assignable` è l'elenco che usa il modulo di creazione: solo membri attivi, senza email, per owner, editor e verificatori; `/members` resta riservato agli owner e continua a includere le email.

## Diario

| Metodo | Percorso | Accesso | Note |
| :-- | :-- | :-- | :-- |
| GET | `/api/diary?site_id=` | membro | Voci del cantiere; accetta anche `siteId` |
| POST | `/api/diary` | owner/editor/verifier con modulo Diario | Una voce per cantiere, giorno e turno |
| PATCH | `/api/diary/{id}` | autore entro sette giorni oppure owner, con modulo Diario | Corregge il contenuto e archivia la versione precedente |
| GET | `/api/diary/{id}/versions` | membro con modulo Diario | Versioni in ordine decrescente |

`POST /api/diary` usa il fuso e l'ora di taglio del cantiere. Ometti `operational_date` e `shift` per far assegnare entrambi dal server al salvataggio. Se invii la data senza il turno, il server assegna il turno corrente. Per registrare una data e un turno specifici, invia `operational_date` in formato `YYYY-MM-DD` e `shift` con valore `day` o `night`. Gli eventuali campi `time_zone` e `day_cutoff_time` devono coincidere con quelli del cantiere, altrimenti la risposta è `400 VALIDATION_ERROR`. La voce registra entrambi i valori alla creazione.

La finestra di sette giorni si calcola confrontando `operational_date` con la data di calendario corrente nel fuso del cantiere. Una data futura restituisce `400 VALIDATION_ERROR`. Per una data più vecchia di sette giorni, il `POST` richiede il ruolo owner e una `motivation` di almeno 10 caratteri dopo aver rimosso gli spazi iniziali e finali. La risposta registra `author_id`, `recorded_late` e `recording_motivation`.

Il `PATCH` richiede almeno uno tra `plan`, `actual`, `impediments` e `next_step`. Usa una stringa vuota per svuotare un campo. Il giorno operativo e il turno sono fissi. Per correggere una voce altrui, senza autore associato o oltre i sette giorni serve un owner e vale lo stesso requisito per `motivation`. Un ruolo insufficiente restituisce `403 FORBIDDEN`. Una motivazione obbligatoria mancante o troppo breve restituisce `400 MOTIVATION_REQUIRED`. La risposta riporta la voce aggiornata con `updated_at`, `updated_by` e `updated_by_name`.

L'endpoint delle versioni restituisce un array, vuoto fino alla prima correzione. Ogni elemento include `version`, `snapshot` con la voce prima della correzione, `author_id` e `author_name` di chi ha eseguito la correzione, `created_at` e `motivation` se fornita.

Le due liste accettano sia `site_id` sia `siteId`, perché le attività e il diario usavano storicamente il secondo nome. Un parametro di query non previsto viene rifiutato con `400 VALIDATION_ERROR` invece di essere ignorato: un filtro scritto male non restituisce un elenco non filtrato.

## Struttura progetto (WBS) e presenze (HR)

Queste aree sono esposte in **sola lettura**. L'import degli snapshot tramite endpoint dedicati è riservato agli owner; l'import di pianificazione dall'interfaccia copre anche Time Schedule e presenze (vedi [Import degli export di pianificazione](#import-degli-export-di-pianificazione)).

| Metodo | Percorso | Accesso | Note |
| :-- | :-- | :-- | :-- |
| GET | `/api/wbs?site_id=` | membro | Albero della struttura |
| GET | `/api/wbs?site_id=&flat=1` | membro | Tabella piatta |
| GET | `/api/wbs/{id}` | membro | Nodo con figli immediati |
| POST | `/api/wbs/import` | owner | Promuove uno snapshot Time Schedule |
| GET | `/api/employees?site_id=` | membro con `workforce_names` | Dipendenti del cantiere |
| GET | `/api/employees/{id}` | membro con `workforce_names` | Dipendente con i suoi work days |
| GET | `/api/work-days?site_id=&employee_id=&from=&to=` | membro con `workforce_names` | Presenze filtrate per intervallo |
| POST | `/api/employees/import` | owner | Promuove uno snapshot presenze |

L'import degli snapshot via `POST /api/employees/import` classifica il turno a partire dall'orario locale di inizio e dall'ora di taglio del cantiere. Data operativa e orari sono conservati come forniti dalla sorgente.

### Riepilogo ore e presenze in cantiere

| Metodo | Percorso | Accesso | Note |
| :-- | :-- | :-- | :-- |
| GET | `/api/workforce/summary?site_id=&group_by=&from=&to=` | membro con `bookings` | Ore della sorgente raggruppate per `company`, `day` o `period` |
| GET | `/api/workforce/presence?site_id=&date=` | membro con `workforce_presence` | Presenze previste per un giorno operativo |

Entrambe le rotte richiedono `site_id` come UUID e date valide nel formato `YYYY-MM-DD`. Il riepilogo richiede `group_by`, `from` e `to`. L'intervallo include entrambe le date e deve coprire da 1 a 366 giorni. I parametri non validi restituiscono `400 VALIDATION_ERROR`.

Il riepilogo restituisce un array con `group_key`, `work_time`, `open_hours` e `booked_hours`. La chiave è l'impresa (o `null` se manca), la data operativa o l'intervallo `from/to`. Un totale della sorgente vale `null` se il dato manca in almeno una giornata del gruppo. Un intervallo senza giornate restituisce un array vuoto.

Le presenze richiedono `date` e restituiscono `first_name`, `last_name`, `company`, `shift`, `start_time` e `finish_time` per le giornate associate a un dipendente. La risposta omette gli identificativi dei dipendenti e i totali delle ore lavorate.

## Avanzamento di cantiere

Le voci di avanzamento importate dal sistema di cantiere sono visibili nella vista **Avanzamento**. I campi importati restano in sola lettura; il completamento degli step si registra dall'applicazione o via API.

| Metodo | Percorso | Accesso | Note |
| :-- | :-- | :-- | :-- |
| GET | `/api/site-progress?site_id=&wbs_id=&include_descendants=true` | membro | `wbs_id` filtra il nodo esatto per impostazione predefinita. `include_descendants=true` include anche i discendenti della gerarchia operativa. `X-WBS-Scope` indica `all`, `exact` o `subtree`. `X-Total-Count` conta le voci nel perimetro. |
| GET | `/api/site-progress/{id}` | membro | Voce con `booked_hours` (somma delle ore prenotate), `planned_hours` e gli step |
| PATCH | `/api/site-progress/{id}` | owner/editor | `{ planned_hours }`: aggiorna solo le ore pianificate |
| POST | `/api/site-progress/import` | owner | Promuove uno snapshot di avanzamento |
| GET | `/api/progress-types?site_id=` | membro | Tipi di avanzamento del cantiere |
| POST | `/api/progress-types` | owner | Crea un tipo; i pesi degli step devono sommare 100 |
| DELETE | `/api/progress-types/{id}` | owner | Elimina un tipo non assegnato |
| PATCH | `/api/site-progress/{id}/progress-type` | owner | Assegna o toglie un tipo (`progress_type_id`) |
| PUT | `/api/site-progress/{id}/steps` | owner/editor | `{ steps: [{ step_id, percent }] }`; aggiunge una registrazione allo storico |
| GET | `/api/progress/curve?site_id=&from=&to=` | membro con `progress` | Curva per sezione, per giorno di calendario |

Ogni voce riporta descrizione, area PLC, sezione, avanzamento e avanzamento pianificato, scostamento, assegnatario, date pianificate ed effettive, ritardo atteso, `planned_hours`, `booked_hours` e i contrassegni `has_files`, `has_notes`, `has_deviations`. Quando la voce è collegata a un nodo WBS, la risposta include anche `wbs_code` e `wbs_description` del nodo; senza collegamento i due campi sono `null`. Il collegamento alla voce WBS avviene solo quando area PLC e sezione individuano **un solo** nodo; in tutti gli altri casi la voce resta senza collegamento. `planned_hours` è un numero o `null`; se è `null`, l'earned value usa le ore del nodo WBS collegato, quando presenti.

L'elenco e il dettaglio delle voci restituiscono anche i campi di verifica. I conteggi riguardano lo stesso cantiere e lo stesso nodo WBS della voce e valgono `0` per una voce senza nodo.

- `verification_open_tasks` conta le attività con stato `to_verify`.
- `verification_conflict` vale `true` quando il valore effettivo `progress_pct` è esattamente `100` e `verification_open_tasks` è maggiore di `0`.
- `open_verifications` è il conteggio precedente, che include anche le attività con `acceptance_state = 'declared'`.

Il conflitto dipende dallo stato `to_verify`: un'accettazione formale (`acceptance_state = 'accepted'`) è un dato separato e non è il criterio dell'avviso. `open_verifications` non è un conteggio delle accettazioni formali.

Un tipo di avanzamento è un elenco di step con un peso. La somma dei pesi deve essere **100**, altrimenti la creazione è rifiutata con `WEIGHTS_NOT_100`. Se una voce ha un tipo assegnato, l'avanzamento restituito è `computed` (media pesata degli step); senza step registrati vale `0`, non il valore importato. Ogni `PUT` inserisce una riga in `progress_entries`: lo storico non viene riscritto e le curve si calcolano da lì.

`GET /api/progress/curve` raggruppa le registrazioni e le date pianificate con orario per giorno di calendario nel fuso del cantiere. Un valore salvato come sola data conserva il giorno originario. Se `to` è omesso, l'intervallo termina alla data locale corrente. Se `from` è omesso, l'intervallo copre 90 giorni inclusi gli estremi. L'intervallo può coprire fino a 400 giorni. I limiti si indicano in formato `YYYY-MM-DD`.

`PATCH /api/site-progress/{id}` accetta solo `{ planned_hours }`, con un numero tra **0** e **1000000** oppure `null` per tornare alle ore del nodo WBS. Qualsiasi altro campo è rifiutato con `VALIDATION_ERROR`; l'accesso è riservato a owner ed editor del cantiere.

## Deviazioni

Le deviazioni sono importate e consultabili in sola lettura nell'interfaccia; gli endpoint restituiscono gli stessi dati.

| Metodo | Percorso | Accesso | Note |
| :-- | :-- | :-- | :-- |
| GET | `/api/deviations?site_id=&status=&priority=` | membro | Elenco per cantiere, con filtri opzionali |
| GET | `/api/deviations/{id}` | membro | Dettaglio con i collegamenti espliciti (`links`) |
| POST | `/api/deviations/import` | owner | Promuove uno snapshot deviazioni |
| GET | `/api/deviations/reconciliation?site_id=` | membro | Controlli sulle date del cantiere |

Gli stati ammessi sono `open`, `approved`, `in_progress`, `work_completed`, `closed`, `rejected`. Uno stato di origine sconosciuto o assente resta vuoto (`null`) e viene contato nell'import: non viene mai interpretato come `open`. I collegamenti puntano a `site_progress_item`, `work_day`, `task` o `diary`; l'import non li crea e non li elimina da solo.

`GET /api/deviations/reconciliation` restituisce `counts` e `items`. `counts` contiene i due controlli — `closed_without_date` e `close_before_approval` — e `items` una riga per segnalazione, con `kind`, `id`, `deviation_no`, `title`, `official_status` e `disagreement_days`. Serve l'accesso al modulo `deviations` e `site_id` è obbligatorio: se manca o non è un UUID la risposta è `400 VALIDATION_ERROR`. Le deviazioni sono solo importate e non hanno uno stato interno né una storia dei cambi di stato: non esiste quindi un confronto tra stato ufficiale e stato interno, e `disagreement_days` resta `null` quando la distanza non è calcolabile.

## Prenotazioni ore

Le prenotazioni si registrano anche dalla vista **Prenotazioni ore**. Tutte e tre le rotte richiedono sia `bookings` sia `workforce_names`, oltre ai ruoli sul cantiere indicati sotto.

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

## Ordini di acquisto

Gli **ordini di acquisto** registrano ciò che il cantiere ha ordinato a un fornitore, con una riga per voce ordinata, e ne seguono l'esecuzione. Si gestiscono dalla vista **Logistica** (vedi [Logistica](../../moduli/logistica/)) e via API. Serve il modulo `logistics`, spento per impostazione predefinita (vedi [Cantieri](#cantieri)), mentre gli owner del cantiere lo hanno sempre. Con il modulo concesso leggono tutti i ruoli del cantiere, `viewer` compreso; scrivono owner ed editor. I cantieri dimostrativi contengono due ordini per cantiere, con righe nei quattro stati.

| Metodo | Percorso | Accesso | Note |
| :-- | :-- | :-- | :-- |
| GET | `/api/purchase-orders?site_id=&status=` | membro con modulo `logistics` | Elenco del cantiere in ordine di creazione; filtro di stato facoltativo |
| POST | `/api/purchase-orders` | owner/editor | `{ siteId, poNo, supplierName, orderedOn, notes? }`; risponde `201` |
| GET | `/api/purchase-orders/{id}` | membro con modulo `logistics` | Ordine con le righe in `items`, in ordine di `lineNo` |
| PATCH | `/api/purchase-orders/{id}` | owner/editor | `{ supplierName?, orderedOn?, notes? }` |
| POST | `/api/purchase-orders/{id}/status` | owner/editor | `{ status, note? }` |
| POST | `/api/purchase-orders/{id}/items` | owner/editor | `{ lineNo?, materialNo?, description, unit?, quantity, wbsId? }`; risponde `201` |
| PATCH | `/api/purchase-orders/{id}/items/{itemId}` | owner/editor | Aggiorna solo i campi inviati della riga |
| POST | `/api/purchase-orders/{id}/items/{itemId}/status` | owner/editor | `{ status }` |

`site_id` è obbligatorio e deve essere un UUID; l'elenco accetta solo quel nome, non `siteId`, e uno stato sconosciuto risponde `400 VALIDATION_ERROR`. `poNo` è obbligatorio, fino a 80 caratteri e **univoco nel cantiere** (`409 PO_DUPLICATE_NUMBER`). `supplierName` è obbligatorio fino a 200 caratteri, `orderedOn` è una data `YYYY-MM-DD`, `notes` arriva a 10000 caratteri e una stringa vuota vale `null`. Un ordine nasce `open` e senza righe; `PATCH` cambia fornitore, data e note e ignora gli altri campi: numero e stato non si modificano da lì.

Nelle righe `description` è obbligatoria fino a 500 caratteri, `materialNo` arriva a 10000, `unit` a 20 e `quantity` è positiva, fino a **999999999.999**, con al massimo tre decimali. `lineNo` è un intero positivo e univoco nell'ordine (`409 PO_DUPLICATE_LINE`); se manca vale l'ultimo numero più uno. `wbsId` è facoltativo e deve appartenere al cantiere dell'ordine.

Gli stati dell'ordine sono `open`, `template_generated`, `in_execution`, `completed` e `not_relevant`; quelli di una riga `open`, `in_execution`, `completed` e `not_relevant`. Le transizioni della riga sono `open → in_execution`, `in_execution → completed` e il passaggio a `not_relevant` da uno stato non finale; una riga finale non cambia più e risponde `409 PO_STATUS_CONFLICT`. `executionStartedOn`, `completedOn` e `notRelevantOn` si scrivono da soli con il giorno del passaggio, in UTC.

Lo stato dell'ordine si aggiorna da solo quando cambiano le righe: `in_execution` se almeno una riga è in esecuzione, `not_relevant` se tutte sono non rilevanti, `completed` se tutte sono finali, altrimenti resta `open` — o `template_generated` se l'ordine è già passato da quello stato. Dalla rotta di stato l'ordine passa a `template_generated` solo da `open`, a `completed` solo quando tutte le righe sono finali e a `not_relevant` solo quando tutte sono non rilevanti; `in_execution` non si imposta a mano. Un ordine finale non cambia più stato, e `closedAt` viene scritto solo dalla chiusura esplicita.

Le transizioni dell'ordine accettano una `note` facoltativa, che finisce in `changes.note` della riga di audit. Non esistono rotte `DELETE`: un ordine e le sue righe non si eliminano. Codici dedicati: `PO_NOT_FOUND` (404), `PO_ITEM_NOT_FOUND` (404), `PO_DUPLICATE_NUMBER` (409), `PO_DUPLICATE_LINE` (409), `PO_STATUS_CONFLICT` (409).

## Colli

Un **collo** raggruppa le righe di un ordine in un'unità di spedizione e registra quanto è stato imballato di ciascuna: è il passaggio tra l'ordine e la spedizione. Si legge e si scrive anche dalla vista **Logistica**, scheda **Pacchi** (vedi [Logistica](../../moduli/logistica/#i-pacchi)); gli stessi dati restano disponibili qui. Serve il modulo `logistics`, come per gli ordini; leggono tutti i ruoli del cantiere, `viewer` compreso, e scrivono owner ed editor.

| Metodo | Percorso | Accesso | Note |
| :-- | :-- | :-- | :-- |
| GET | `/api/packages?site_id=&purchase_order_id=` | membro con modulo `logistics` | Colli del cantiere in ordine di creazione; filtro facoltativo per ordine |
| POST | `/api/packages` | owner/editor | `{ siteId, purchaseOrderId, packageNo?, notes?, items }`; risponde `201` |
| GET | `/api/packages/{id}` | membro con modulo `logistics` | Collo con le righe imballate in `items` |
| POST | `/api/packages/{id}/close` | owner/editor | Chiude il collo; non ha corpo |

`site_id` è obbligatorio e deve essere un UUID; `purchase_order_id` restringe l'elenco a un ordine. `packageNo` è facoltativo, fino a 80 caratteri e **univoco nell'ordine**: se manca, il servizio assegna il primo numero libero nella forma `PKG-001`, `PKG-002` e così via, contando solo i numeri già in quella forma. Un numero già usato risponde `409 PACKAGE_DUPLICATE_NUMBER`. `notes` arriva a 10000 caratteri.

`items` è obbligatorio e contiene almeno una voce `{ purchaseOrderItemId, quantityPacked }`: ogni riga dell'ordine compare **una volta sola** nel collo e `quantityPacked` è positiva, fino a **999999999.999**, con al massimo tre decimali. La riga deve appartenere all'ordine indicato, altrimenti la risposta è `404 PACKAGE_ITEM_NOT_FOUND`. La somma delle quantità imballate di una riga, su **tutti** i colli dell'ordine, non può superare la quantità ordinata: un totale maggiore risponde `400 PACKAGE_QUANTITY_EXCEEDED` e non lascia righe parziali. Il collo nasce `open`.

Il primo collo che imballa una riga ancora `open` la porta in `in_execution` con il giorno dell'operazione come `executionStartedOn`; le righe già avviate, completate o non rilevanti non cambiano, e la data di inizio già presente resta quella. Dopo l'inserimento lo stato dell'ordine viene ricalcolato con le stesse regole degli ordini. `POST /api/packages/{id}/close` porta il collo a `closed` e scrive `closedAt`; chiuderlo di nuovo risponde `409 PACKAGE_STATUS_CONFLICT`. Non esistono rotte `DELETE`: un collo non si elimina. Ogni collo, ogni riga imballata e l'eventuale passaggio di stato della riga lasciano una riga nel [registro di audit](#registro-di-audit). Codici dedicati: `PACKAGE_NOT_FOUND` (404), `PACKAGE_ITEM_NOT_FOUND` (404), `PACKAGE_DUPLICATE_NUMBER` (409), `PACKAGE_STATUS_CONFLICT` (409), `PACKAGE_QUANTITY_EXCEEDED` (400).

## Spedizioni

Una **spedizione** raggruppa uno o più colli e ne segue il viaggio, con le ricezioni di quanto arriva. Si legge e si scrive anche dalla vista **Logistica**, scheda **Spedizioni** (vedi [Logistica](../../moduli/logistica/#le-spedizioni)); gli stessi dati restano disponibili qui. Serve il modulo `logistics`; leggono tutti i ruoli del cantiere, `viewer` compreso, e scrivono owner ed editor.

| Metodo | Percorso | Accesso | Note |
| :-- | :-- | :-- | :-- |
| GET | `/api/shipments?site_id=&status=` | membro con modulo `logistics` | Spedizioni del cantiere in ordine di creazione; filtro di stato facoltativo |
| POST | `/api/shipments` | owner/editor | `{ siteId, shipmentNo, carrier?, shippedOn?, expectedOn?, notes?, packageIds }`; risponde `201` |
| GET | `/api/shipments/{id}` | membro con modulo `logistics` | Spedizione con `packages` e `receipts` |
| POST | `/api/shipments/{id}/status` | owner/editor | `{ status, note? }` |
| POST | `/api/shipments/{id}/receipts` | owner/editor | `{ purchaseOrderItemId, quantityReceived, note? }`; risponde `201` |

`shipmentNo` è obbligatorio, fino a 80 caratteri e **univoco nel cantiere** (`409 SHIPMENT_DUPLICATE_NUMBER`); `carrier` arriva a 200 caratteri, `notes` a 10000. `shippedOn` ed `expectedOn` sono date `YYYY-MM-DD` facoltative. `packageIds` è obbligatorio, con almeno un collo, ognuno una volta sola: i colli devono appartenere al cantiere della spedizione (`400 SHIPMENT_PACKAGE_SITE_MISMATCH`) e un collo può stare in **una sola** spedizione (`409 SHIPMENT_PACKAGE_TAKEN`). La spedizione nasce `planned`.

Gli stati sono `planned`, `in_transit`, `arrived` e `received`, e si avanzano **un passo alla volta**: un salto o un passo indietro risponde `409 SHIPMENT_STATUS_CONFLICT`. Il passaggio ad `arrived` scrive `arrivedOn` con il giorno corrente; `received` richiede almeno una ricezione già registrata. La transizione accetta una `note` facoltativa, che finisce in `changes.note` della riga di audit.

Le **ricezioni** registrano quanto è arrivato di una riga ordinata: `purchaseOrderItemId` deve essere una riga **contenuta in uno dei colli della spedizione** — una voce `package_items` di quei colli —, altrimenti la risposta è `404 SHIPMENT_ITEM_NOT_FOUND`; una spedizione già `received` rifiuta nuove ricezioni con `409 SHIPMENT_STATUS_CONFLICT`. Inoltre `quantityReceived` è **non negativa** — lo zero è ammesso — fino a 999999999.999 con al massimo tre decimali, e `note` è facoltativa. Una ricezione non cambia lo stato della riga ordinata: resta un dato della spedizione e si legge in `receipts`. Non esistono rotte `DELETE`: una spedizione non si elimina e una ricezione non si annulla. Codici dedicati: `SHIPMENT_NOT_FOUND` (404), `SHIPMENT_ITEM_NOT_FOUND` (404), `SHIPMENT_DUPLICATE_NUMBER` (409), `SHIPMENT_PACKAGE_TAKEN` (409), `SHIPMENT_STATUS_CONFLICT` (409), `SHIPMENT_PACKAGE_SITE_MISMATCH` (400).

## Attrezzature

Il registro delle attrezzature è lo stesso che si gestisce dalla vista **Attrezzature**. La lettura è aperta a tutti i membri del cantiere; la scrittura a owner, editor e verificatori.

| Metodo | Percorso | Accesso | Note |
| :-- | :-- | :-- | :-- |
| GET | `/api/tools?site_id=&company=` | membro | Registro del cantiere; filtro opzionale ed esatto per appaltatore |
| POST | `/api/tools` | owner/editor/verifier | `{ site_id, name, code?, company?, status?, location?, notes? }` |
| PATCH | `/api/tools/{id}` | owner/editor/verifier | Aggiorna solo i campi inviati |
| DELETE | `/api/tools/{id}` | owner/editor/verifier | Elimina la riga |

`name` è obbligatorio, da 1 a 120 caratteri. `code`, `company`, `location` e `notes` sono testo libero, fino a 10000 caratteri, e possono essere `null`. Lo stato vale `available`, `in_use`, `maintenance` o `retired`; se manca in creazione vale `available`. L'elenco è ordinato per appaltatore, con le righe senza appaltatore in fondo, poi per nome. L'eliminazione è **logica**: `DELETE` toglie la riga dall'elenco, dai filtri e dalle letture successive, ma la conserva nel [registro di audit](#registro-di-audit).

## Idoneità

Le certificazioni dei dipendenti si gestiscono dalla vista **Idoneità**. La lettura è aperta a owner, editor e verificatori; la scrittura a owner ed editor. Il ruolo `viewer` non accede: le certificazioni sono dati personali e la risposta è `403 CERT_FORBIDDEN`.

| Metodo | Percorso | Accesso | Note |
| :-- | :-- | :-- | :-- |
| GET | `/api/certifications?site_id=&employee_id=&category=&status=&within=` | owner/editor/verifier | Elenco con stato calcolato e giorni residui |
| GET | `/api/certifications?site_id=&summary=1` | owner/editor/verifier | Solo i conteggi per stato e il totale |
| POST | `/api/certifications` | owner/editor | `{ siteId, employeeId, name, category?, issuer?, issuedOn?, expiresOn?, outcome?, notes? }` |
| PATCH | `/api/certifications/{id}` | owner/editor | Aggiorna solo i campi inviati |
| DELETE | `/api/certifications/{id}` | owner/editor | Elimina la riga |

`site_id` è obbligatorio nell'elenco. La categoria vale `qualification`, `medical`, `training` o `other`; se manca in creazione vale `other`. Lo stato vale `expired`, `expiring`, `valid` o `no_expiry` ed è **calcolato**, non memorizzato: `within` è la soglia in giorni per «in scadenza» (default **30**, da 0 a 365) e `days_left` è la differenza in giorni tra scadenza e oggi, negativa per le scadute e `null` per le certificazioni senza scadenza.

`name` è obbligatorio, da 1 a 120 caratteri; `issuer` arriva a 200 caratteri, `outcome` a 500 e `notes` a 2000. `issued_on` ed `expires_on` sono date `YYYY-MM-DD` e la scadenza non può precedere il rilascio. L'`employee_id` deve appartenere al cantiere. L'eliminazione è **logica**: la riga esce dagli elenchi, dai contatori e dai dettagli e resta nel [registro di audit](#registro-di-audit). Codici dedicati: `CERT_INVALID` (400), `CERT_FORBIDDEN` (403), `CERT_NOT_FOUND` (404).

## HSE

Il registro HSE si gestisce dalla vista **HSE**. La lettura è aperta a owner, editor e verificatori; la scrittura a owner ed editor. Il ruolo `viewer` non accede: la risposta è `403 HSE_FORBIDDEN`. Il registro è separato dagli altri moduli e non alimenta la Panoramica né il report.

| Metodo | Percorso | Accesso | Note |
| :-- | :-- | :-- | :-- |
| GET | `/api/hse-events?site_id=&type=&severity=&from=&to=` | owner/editor/verifier | Eventi del cantiere, dal più recente; filtri opzionali |
| GET | `/api/hse-events?site_id=&summary=1` | owner/editor/verifier | Solo i conteggi per tipo, per gravità e il totale |
| POST | `/api/hse-events` | owner/editor | `{ siteId, occurredOn, type, severity, eventNo?, location?, personsInvolved?, measures?, notes?, deviationId? }` |
| PATCH | `/api/hse-events/{id}` | owner/editor | Aggiorna solo i campi inviati |
| DELETE | `/api/hse-events/{id}` | owner/editor | Elimina la riga |

`site_id` è obbligatorio nell'elenco. `occurred_on` è obbligatoria in creazione ed è una data `YYYY-MM-DD`; `type` vale `near_miss`, `accident`, `observation`, `inspection` o `external_visit`; `severity` vale `low`, `medium` o `high`. I due tipi `inspection` ed `external_visit` sono quelli che l'applicazione scrive da sola quando si registra un'ispezione HSE (vedi [Ispezioni HSE](#ispezioni-hse)): in scrittura, con `POST` e `PATCH`, sono accettati solo `near_miss`, `accident` e `observation`, e un altro valore risponde `400 HSE_INVALID`. Il modulo di inserimento manuale propone gli stessi tre tipi, mentre il filtro **Tipo** della vista offre tutti e cinque.

Il riepilogo con `summary=1` conta tutti e cinque i tipi: `by_type` contiene sempre `inspection` ed `external_visit`, a zero quando il cantiere non ha ispezioni, oltre a `by_severity` e `total`. Il contatore **Totale** della vista conta tutte le righe, comprese quelle nate dalle ispezioni. `event_no` è facoltativo, fino a 120 caratteri, e **univoco nel cantiere** quando presente. `location` arriva a 200 caratteri, `measures` e `notes` a 2000; `persons_involved` è un intero tra 0 e 2147483647 e non accetta nomi. `deviation_id` è facoltativo e deve appartenere allo stesso cantiere. Il registro non contiene dati sanitari e non ha relazioni con i dipendenti: si registrano fatti, luoghi, misure e un conteggio di persone. L'eliminazione è **logica**: la riga esce dagli elenchi, dai contatori e dai dettagli e resta nel [registro di audit](#registro-di-audit). Un `event_no` già usato **resta riservato anche dopo l'eliminazione logica** della riga: riusarlo su un altro evento risponde `400 HSE_INVALID`, perché il numero identifica un evento e non deve passare a un altro. Agli eventi si possono allegare immagini e PDF: accesso, regole e traccia delle letture sono in [Allegati](#allegati). Ogni riga dell'elenco porta anche `inspection_id` e `asset_id`: sono l'ispezione e il soggetto da cui la riga nasce, e valgono `null` per i tre tipi manuali. Servono all'interfaccia per il comando **Apri l'ispezione**; filtri, ordinamento e riepilogo non cambiano. Codici dedicati: `HSE_INVALID` (400), `HSE_FORBIDDEN` (403), `HSE_NOT_FOUND` (404).

## Attrezzature HSE e catalogo delle ispezioni

Le **attrezzature HSE** sono ciò che il cantiere deve ispezionare: strumenti, opere di cantiere e dispositivi di protezione individuale. Si creano e si modificano dalla vista **Ispezioni** della sezione HSE; l'eliminazione è solo via API. Owner, editor e verificatori leggono. Solo owner ed editor scrivono. Serve il modulo `hse`, in lettura e in scrittura: un membro escluso dal modulo riceve `403 MODULE_FORBIDDEN`.

| Metodo | Percorso | Accesso | Note |
| :-- | :-- | :-- | :-- |
| GET | `/api/hse/assets?siteId=` | membro | Elenco del cantiere, senza le righe eliminate |
| POST | `/api/hse/assets` | owner/editor | `{ siteId, templateCode, name, code?, notes?, toolId?, active? }` |
| PATCH | `/api/hse/assets/{id}` | owner/editor | Aggiorna solo i campi inviati |
| DELETE | `/api/hse/assets/{id}` | owner/editor | Elimina la riga |
| GET | `/api/hse/inspection-templates?siteId=` | membro | Catalogo dei modelli della giurisdizione del cantiere |

`siteId` è obbligatorio e deve essere un UUID. `templateCode` è obbligatorio e deve appartenere al catalogo della **giurisdizione del cantiere**: un modello dell'altra giurisdizione risponde `400 TEMPLATE_JURISDICTION_MISMATCH`, un codice sconosciuto o assente `400 VALIDATION_ERROR`. `name` è obbligatorio, da 1 a 200 caratteri e **univoco nel cantiere** dopo il taglio degli spazi: un nome già in uso risponde `409 DUPLICATE_ASSET_NAME`. `code` arriva a 60 caratteri, `notes` a 2000, e una stringa vuota vale `null`. `active` è un booleano e vale `true` quando manca. `toolId` è facoltativo e deve puntare a un'attrezzatura non eliminata dello **stesso cantiere**.

`kind` e `category` non si inviano: se compaiono nel corpo vengono ignorati, perché sono **derivati dal modello**. `kind` vale `tool`, `site_work` o `ppe`; `category` è quella del modello (`lifting`, `lifting_accessories`, `ppe`, `scaffolding`). L'elenco è ordinato per categoria e nome, esclude le righe eliminate e arricchisce ogni riga con `templateTitle` e `jurisdiction`.

Ogni riga dell'elenco dice anche a che punto è l'ispezione, con quattro campi calcolati: `lastInspectionOn` è la data dell'ultima ispezione, `lastOutcome` il suo esito (`pass`, `pass_with_notes` o `fail`), `nextDueOn` la sua scadenza; tutti e tre valgono `null` quando l'attrezzatura non è mai stata ispezionata. `status` riassume la situazione in un valore, nell'ordine: `never` se non c'è nessuna ispezione, `failed` se l'ultimo esito è `fail`, `overdue` se `nextDueOn` è precedente a oggi, `due_soon` se scade entro i prossimi **30 giorni** (oggi compreso), `ok` in tutti gli altri casi, compreso un esito positivo senza scadenza. Per «ultima ispezione» conta la data dell'ispezione, poi la data di inserimento, poi l'identificativo; le date si confrontano sul calendario del server. I quattro campi sono solo nell'elenco: `GET /api/hse/assets/{id}` restituisce la riga senza di essi. L'eliminazione è **logica**: la riga esce dagli elenchi e le letture successive rispondono `404 HSE_ASSET_NOT_FOUND`, ma resta nel registro di audit; il nome torna disponibile per una nuova attrezzatura e, per liberare il vincolo, la riga eliminata viene rinominata in `<nome> (deleted <id>)`.

Il catalogo restituisce `{ jurisdiction, templates }`, con le sole famiglie della giurisdizione del cantiere. Ogni modello ha `code`, `jurisdiction`, `kind`, `category`, `title`, `reference`, `intervalMonths`, `draft` e `items`, dove ogni voce ha `code` e `label`: sono **controlli visivi**, non prove strumentali.

| Codice | Giurisdizione | Famiglia | Intervallo | Riferimento |
| :-- | :-- | :-- | :-- | :-- |
| `it_lifting` | IT | Apparecchi di sollevamento | 24 mesi | D.Lgs. 81/2008, Allegato VII |
| `it_ppe` | IT | Dispositivi di protezione individuale | 12 mesi | D.Lgs. 81/2008, Titolo III, Capo II |
| `it_scaffolding` | IT | Ponteggi | 3 mesi | D.Lgs. 81/2008, Titolo IV |
| `uk_lifting` | UK | Lifting equipment | 12 mesi | LOLER 1998 |
| `uk_lifting_accessories` | UK | Lifting accessories | 6 mesi | LOLER 1998 |
| `uk_ppe` | UK | Personal protective equipment | 12 mesi | PPE at Work Regulations 1992 |
| `uk_scaffolding` | UK | Scaffolding | 3 mesi | Work at Height Regulations 2005 |

Oggi tutti i modelli sono `draft: true`: sono in bozza, non ancora attivati. Owner, editor e verificatori leggono il catalogo; un cantiere che non esiste risponde `404 SITE_NOT_FOUND` e la lettura non lascia righe nel registro di audit. Codici dedicati delle attrezzature: `VALIDATION_ERROR` (400), `TEMPLATE_JURISDICTION_MISMATCH` (400), `DUPLICATE_ASSET_NAME` (409), `HSE_ASSET_NOT_FOUND` (404).

## Ispezioni HSE

Un'**ispezione HSE** registra l'esito dei controlli di un'attrezzatura HSE in una data. Ogni ispezione è una riga e ogni controllo del modello è una riga a parte: l'ispezione conserva l'etichetta di ogni controllo com'era nel modello il giorno della compilazione, così una modifica successiva al modello non riscrive un'ispezione passata. Si registrano dalla scheda del soggetto nella vista **Ispezioni** dell'interfaccia (vedi [HSE](../../moduli/hse/#registrare-unispezione)) e via API; si leggono dall'API e dalla scheda del soggetto, che mostra stato, storico e singoli controlli (vedi [HSE](../../moduli/hse/#aprire-un-soggetto-stato-storico-e-controlli)). Owner, editor e verificatori leggono. Solo owner ed editor scrivono. Serve il modulo `hse`, in lettura e in scrittura.

| Metodo | Percorso | Accesso | Note |
| :-- | :-- | :-- | :-- |
| GET | `/api/hse/inspections?siteId=&assetId=` | membro | Elenco del cantiere, dalla data dell'ispezione più recente |
| POST | `/api/hse/inspections` | owner/editor | `{ siteId, assetId, performedOn, performedBy, performerRole?, mode, outcome, notes?, nextDueOn?, items }` |
| GET | `/api/hse/inspections/{id}` | membro | Ispezione con le voci dei controlli e l'attrezzatura |

`siteId` è obbligatorio e deve essere un UUID. `assetId` è obbligatorio: l'attrezzatura deve appartenere allo stesso cantiere e non essere eliminata, altrimenti la risposta è `404 ASSET_NOT_FOUND`. `performedOn` è obbligatoria ed è una data `YYYY-MM-DD`. `performedBy` è obbligatorio, da 1 a 200 caratteri dopo il taglio degli spazi; `performerRole` è facoltativo. `mode` vale `internal` o `external`, `outcome` vale `pass`, `pass_with_notes` o `fail`: entrambi sono obbligatori. `notes` è facoltativo.

`items` deve contenere **ogni voce del modello esattamente una volta**: una voce mancante o ripetuta risponde `400 INSPECTION_ITEMS_INCOMPLETE`, un codice che il modello non prevede `400 INSPECTION_ITEMS_UNKNOWN`, un `result` diverso da `ok`, `not_ok` o `na` `400 VALIDATION_ERROR`. `label` e `position` non si inviano: l'etichetta e l'ordine sono quelli del modello. Un solo controllo rifiutato annulla l'intera ispezione: non restano righe parziali né voci nel registro di audit.

`nextDueOn` è facoltativo. Se manca, la scadenza si calcola sommando l'intervallo del modello alla data dell'ispezione, con il giorno riportato all'ultimo del mese quando non esiste (31 gennaio più 24 mesi fa 31 gennaio; 31 agosto più 6 mesi fa 28 febbraio, o 29 in un anno bisestile). `nextOn` è accettato come alias; se arrivano entrambi con valori diversi la risposta è `400 VALIDATION_ERROR`. Un `nextDueOn` esplicito vale come scelta: per lasciare la scadenza calcolata dal modello, ometti il campo.

`GET /api/hse/inspections` richiede `siteId`; `assetId` restringe l'elenco a una sola attrezzatura e deve appartenere allo stesso cantiere. `GET /api/hse/inspections/{id}` restituisce la riga con `items`, nell'ordine del modello, e l'attrezzatura. Un'ispezione resta leggibile dopo l'eliminazione logica dell'attrezzatura: è storia del cantiere, non un dato dell'attrezzatura.

Registrare un'ispezione scrive anche una **riga nel registro HSE**: tipo `inspection` per un controllo interno, `external_visit` per uno esterno; gravità `high` per un esito `fail`, `medium` per `pass_with_notes`, `low` per `pass`; `occurred_on` è la data dell'ispezione, `location` il codice dell'attrezzatura (il nome quando il codice manca) e `notes` il nome dell'attrezzatura seguito dal titolo del modello. La riga lascia `event_no`, `persons_involved`, `measures` e `deviation_id` a `null`, nasce nella stessa transazione dell'ispezione, scrive la propria voce di audit e il suo identificativo torna nell'ispezione come `hse_event_id`. Un `hseEventId` inviato nel corpo viene ignorato: il registro non si aggancia a un evento scelto dal client. Se una delle due scritture o una delle due voci di audit fallisce, non resta nulla: né riga di registro, né ispezione, né controlli.

Le ispezioni non si modificano e non si eliminano: non esistono rotte `PATCH` né `DELETE`, e una correzione è una nuova ispezione. Codici dedicati: `VALIDATION_ERROR` (400), `INSPECTION_ITEMS_INCOMPLETE` (400), `INSPECTION_ITEMS_UNKNOWN` (400), `ASSET_NOT_FOUND` (404), `INSPECTION_NOT_FOUND` (404).

## Registro di audit

Ogni inserimento, modifica ed eliminazione di un evento HSE, di una certificazione, di un'attrezzatura del registro o di un'attrezzatura HSE, ogni ispezione HSE registrata, ogni scrittura su un ordine di acquisto o su una sua riga, su un collo, su una spedizione o su una ricezione — e ogni cambio di giurisdizione di un cantiere — lascia una riga nel registro di audit, scritta nella stessa transazione della scrittura: se la scrittura fallisce, la traccia non viene salvata. In più, ogni download di un allegato di un evento o di un'ispezione HSE lascia una riga `read`: è scritta fuori dal download, quindi se fallisce il file viene servito lo stesso e l'errore resta nei log.

| Metodo | Percorso | Accesso | Note |
| :-- | :-- | :-- | :-- |
| GET | `/api/audit-events?site_id=&entity_type=&entity_id=` | owner/verifier | Righe dalla più recente, a pagine con `limit` e `offset` |

`site_id` è obbligatorio; `entity_type` vale `hse_event`, `certification`, `tool`, `hse_asset`, `hse_inspection`, `purchase_order`, `purchase_order_item`, `package`, `package_item`, `shipment`, `shipment_receipt` o `site` e `entity_id` è l'identificativo della riga da tracciare. Per `site` la riga riguarda il cantiere stesso: `entity_id` è il suo identificativo e `site_id` coincide con esso, e l'unica modifica tracciata è oggi il cambio di giurisdizione. Per `purchase_order_item` l'`entity_id` è quello della riga e `site_id` è il cantiere dell'ordine, perché la riga non ne ha uno proprio. L'accesso è per ruolo sul cantiere: leggono owner e verificatori, non editor e non viewer, anche quando sono loro a scrivere le righe tracciate. Non esistono rotte di scrittura: il registro è in sola aggiunta e non si modifica né si elimina dall'API. Un'ispezione HSE produce due righe `create`: una con `entity_type` `hse_inspection` e una con `entity_type` `hse_event`, per la riga di registro che nasce con l'ispezione. Non esistono rotte che modifichino o eliminino un'ispezione, quindi non compaiono righe `update` o `delete` con `entity_type` `hse_inspection`. Anche ordini di acquisto, righe, colli, spedizioni e ricezioni non si eliminano: per quei `entity_type` non compaiono righe `delete`.

Ogni riga riporta `entity_type`, `entity_id`, `action` (`create`, `update`, `delete`, `read`), `at`, `actor` — l'identificativo dell'utente che ha scritto —, `actor_name` — il nome dell'utente, ricavato dalla tabella utenti e `null` quando l'utente non è più presente — e `changes`, un oggetto JSON. In `create` contiene i campi valorizzati della riga creata; in `delete` l'intera riga com'era prima; in `update` solo i campi cambiati, nella forma `{ "campo": { "from": …, "to": … } }`, senza `id`, `site_id`, `created_at`, `updated_at` e `deleted_at`. In `read` contiene `{ "attachment": { "id": …, "filename": … } }`, con `entity_type` `hse_event` o `hse_inspection` e l'`entity_id` dell'evento o dell'ispezione: descrive solo l'oggetto aperto, senza copia della riga né dati delle persone. La lista dei metadati (`GET /api/attachments`) non scrive una lettura. Una modifica che non cambia alcun campo resta registrata con `changes` vuoto. Le transizioni di un ordine di acquisto scrivono in `changes` anche la `note` inviata, quando c'è.

L'interfaccia usa lo stesso endpoint nel pannello **Ultime modifiche** delle viste HSE, Idoneità e Attrezzature, con `limit=20` e senza `entity_id`; le pagine successive si leggono con `offset`. Le letture degli allegati agli eventi HSE compaiono nel pannello come azione `read`, con il nome del file; quelle degli allegati alle ispezioni no, perché il pannello filtra gli eventi, e si leggono con `entity_type=hse_inspection`.

L'eliminazione è quindi **logica** per i quattro tipi eliminabili — eventi HSE, certificazioni, attrezzature del registro e attrezzature HSE: la riga sparisce dagli elenchi, dai contatori e dai dettagli e le letture successive rispondono con il codice «non trovato» del modulo, ma resta leggibile nel registro di audit. Codici dedicati del registro: `AUDIT_INVALID` (400) per un identificativo non UUID, un `entity_type` sconosciuto o filtri non validi.

## Panoramica e assistente

| Metodo | Percorso | Accesso | Note |
| :-- | :-- | :-- | :-- |
| GET | `/api/dashboard?site_id=` | membro | Quattro indicatori, earned value, deviazioni per stato, avanzamento per sezione, ore per settimana |
| GET | `/api/dashboard/layout?site_id=` | membro | Layout personale: `widgets` e `custom` |
| PUT | `/api/dashboard/layout` | membro | `{ site_id, widgets }`; salva il layout personale |
| DELETE | `/api/dashboard/layout?site_id=` | membro | Ripristina il layout predefinito |
| GET | `/api/report?site_id=` | membro | Due tabelle e un blocco earned value: avanzamento e deviazioni per macro-area |
| POST | `/api/assistant/chat` | membro | `{ site_id, messages, view, language }`; risposta in sola lettura con citazioni |

La dashboard calcola i valori dalle tabelle del cantiere: deviazioni per stato, media dell'avanzamento effettivo per sezione (con il pianificato), ore per settimana, importi dei reclami e blocco `earnedValue`. La media per sezione include anche le voci senza tipo di avanzamento, per le quali vale il valore importato. L'assistente risponde nella lingua richiesta (`it` o `en`) e cita i record con `family`, `id` e `label`; se il provider non è configurato risponde `503 ASSISTANT_NOT_CONFIGURED`.

Il layout della Panoramica è personale per utente e cantiere. `widgets` è un elenco da 1 a 11 identificativi distinti del catalogo fisso: quattro indicatori (`kpi_open_deviations`, `kpi_booked_hours`, `kpi_open_claims`, `kpi_settled_claims`) e sette pannelli (`deviations_by_status`, `progress_by_section`, `hours_by_week`, `earned_value`, `priority_work`, `daily_pulse`, `journal_today`). Senza layout salvato la risposta è il predefinito con `custom: false`; un elenco vuoto, con duplicati o con identificativi sconosciuti è rifiutato con `400 LAYOUT_INVALID`.

`/api/report` restituisce i dati del report stampabile: `site` con `code` e `name`, `generated_at` in UTC, `progress`, `deviations` ed `earnedValue`. Ogni riga di `progress` ha `area`, `items`, `actual`, `planned` e `source` (`computed`, `imported` o `mixed`); ogni riga di `deviations` ha `area`, `total`, `open`, `closed` e `by_status` con `{ status, count }`. Le deviazioni sono raggruppate per area PLC (`plc_area`, altrimenti `Senza sezione`) e ordinate per totale decrescente; `closed` somma `closed` e `rejected`, mentre uno stato mancante resta aperto.

`earnedValue` ha `available` (falso quando mancano le ore pianificate, con `reason: "NO_PLANNED_HOURS"`), `bac_hours`, `ev_hours`, `pv_hours`, `ac_hours`, `cpi`, `spi`, `items_total`, `items_without_hours` e `by_section` (con `section`, `ev_hours`, `pv_hours`, `bac_hours` e `cpi`). Il BAC è la somma delle ore pianificate delle voci o dei nodi WBS collegati; `EV = BAC × avanzamento effettivo / 100`, `PV = BAC × avanzamento pianificato / 100`, `AC` è la somma delle ore prenotate; `CPI = EV / AC` e `SPI = EV / PV`, `null` quando il denominatore è zero o manca.

Il dashboard include `workDays` (solo `operationalDate` e `workTime`, con `null` preservati) e `hoursCoverage`: ore prenotate app nel periodo completo (`appBookedHours`), estremi delle date operative delle prenotazioni (`bookedFrom`, `bookedTo`), numero di giornate (`workDays`) e giornate con ore sorgente (`sourceWorkDays`). `sourceWorkTime` è il totale solo se tutte le giornate hanno ore sorgente; altrimenti è `null`. `knownSourceWorkTime` somma solo le giornate note, o è `null` se nessuna è nota. Ogni settimana di `hours` espone `hours` per la visualizzazione e `hoursExact` per i calcoli: il totale della finestra si ottiene sommando `hoursExact` delle settimane mostrate. Questi dati coprono tutte le giornate del cantiere, anche senza prenotazioni. Nessuna ora mancante viene sostituita con zero. Il KPI conserva le ultime sei settimane disponibili; il totale del periodo e la differenza fuori finestra sono mostrati separatamente. I calcoli di `earnedValue` restano invariati e usano tutte le prenotazioni app. La presenza di ore sorgente non prova che tutte le ore siano prenotate.

## Stato importazioni

Lo **Stato importazioni** è un riepilogo in sola lettura dell'ultimo bundle completo per ogni ambito di progetto: è lo stesso contenuto della vista **Stato importazioni** (vedi [Stato importazioni](../../moduli/reporting/)). Il server ricava il perimetro dalla sessione e ignora i parametri di query come `site_id`.

| Metodo | Percorso | Accesso | Note |
| :-- | :-- | :-- | :-- |
| GET | `/api/reporting/overview` | membro con modulo `reporting` in almeno un cantiere | `{ configured, scopes }`; nessun parametro |

`configured` è `false` quando il server non ha la connessione al database di reporting (`REPORTING_DATABASE_URL` mancante o vuota): la risposta è comunque `200`, con `scopes` vuoto, e nessuna query viene eseguita. Con la connessione configurata, `scopes` elenca un elemento per ambito autorizzato: `scopeId`, `projectReference` (`null` se assente), `exportDate` (`YYYY-MM-DD` o `null`), `loadedAt` (ISO 8601 o `null`), `counts` con le sei famiglie `employees`, `work_days`, `time_schedule`, `site_progress_items`, `daily_logs` e `deviations`, `totalRows` e `qualityIssues`.

L’accesso per cantiere usa le associazioni esplicite già configurate per gli import di WBS, personale, avanzamento e scostamenti. L’utente deve avere accesso al reporting in ogni cantiere associato all’ambito, anche quando lo usano più famiglie di import. Se nessun ambito rientra nel perimetro, la risposta è `200` con `scopes` vuoto e il database di reporting non viene interrogato. L’accesso globale richiede un ruolo owner attivo e l’ID dell’utente autenticato nella variabile server `REPORTING_GLOBAL_OWNER_IDS`, con valori separati da virgole. Per impostazione predefinita è disabilitato.

I conteggi sono interi non negativi e `totalRows` è la loro somma. La risposta non contiene righe di dettaglio, payload di origine né identificativi di caricamento. Gli ambiti sono ordinati per riferimento progetto e identificativo, e la lettura avviene in una sola transazione `REPEATABLE READ READ ONLY`, così metadati e conteggi descrivono lo stesso caricamento.

La rotta accetta solo `GET`: gli altri metodi rispondono `404`. Senza sessione valida la risposta è `401`; se il modulo non è consentito in nessun cantiere del membro è `403 MODULE_FORBIDDEN`; se il database di reporting non risponde è `503 REPORTING_UNAVAILABLE`, con messaggio generico e senza dettagli dell'errore. Lo Stato importazioni non ha rotte di export o di scrittura.

## Import degli export di pianificazione

| Metodo | Percorso | Accesso | Note |
| :-- | :-- | :-- | :-- |
| POST | `/api/import/preview` | owner/editor | `{ site_id, family, filename, data_base64 }`; non scrive nulla |
| POST | `/api/import/apply` | owner/editor | Come sopra, più `preview_token` |
| GET | `/api/import-mappings?site_id=` | owner/editor | Un elemento per famiglia: `family`, `aliases`, `identity`, `custom`, `columns`, `required`, `fields` |
| PUT | `/api/import-mappings` | owner/editor | `{ site_id, family, aliases, identity }`; salva o sostituisce la mappatura |
| DELETE | `/api/import-mappings/{family}?site_id=` | owner/editor | Rimuove la mappatura salvata e torna ai default |
| GET | `/api/import/template?family=` | utente autenticato | Modello xlsx della famiglia: intestazioni canoniche e una riga di esempio |

`family` vale `employees`, `work_days`, `time_schedule`, `site_progress_items`, `deviations` o `daily_log`. Il file è un xlsx fino a **20 MiB**, inviato in base64. L'anteprima restituisce i conteggi `added`, `updated`, `unchanged`, `removed`, `rejected`, i campioni delle righe rifiutate e un `preview_token` valido **15 minuti**. L'applicazione verifica che file, famiglia, righe e mappatura siano gli stessi dell'anteprima; le righe assenti non vengono cancellate e il conteggio `removed` applicato è sempre zero.

`GET /api/import/template` restituisce un file xlsx (`application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`, scaricato come `SiteAssistant-<family>-modello.xlsx`) con un solo foglio: la prima riga contiene le intestazioni canoniche della famiglia, la seconda una riga di esempio con valori fittizi. Non richiede `site_id` e non legge né scrive dati di cantiere: basta una sessione autenticata, di qualsiasi ruolo. La famiglia mancante o sconosciuta è rifiutata con `400 UNKNOWN_FAMILY`. La risposta è `Cache-Control: private, no-store`.

La mappatura è per cantiere e famiglia e si applica anche alle chiamate API: `aliases` associa ogni campo a un elenco di intestazioni alternative, `identity` elenca in ordine i campi che riconoscono la riga. Gli alias devono essere univoci, non vuoti e di massimo **80 caratteri**; `identity` deve contenere almeno un campo, senza duplicati. Una mappatura non valida è rifiutata con `MAP_INVALID`; un alias e una colonna canonica in disaccordo sullo stesso campo con `AMBIGUOUS_COLUMNS`. Se la mappatura cambia dopo l'anteprima, la conferma è rifiutata con `PREVIEW_MISMATCH` (409).

## Allegati

Gli allegati a **attività, diario, eventi HSE e ispezioni HSE** si caricano anche dall'interfaccia; per il cantiere restano solo via API. La rimozione è solo via API. `entity_type` vale `task`, `diary`, `site`, `hse_event` o `hse_inspection`; un evento HSE deve esistere e non essere eliminato, un'ispezione HSE deve esistere.

| Metodo | Percorso | Accesso | Note |
| :-- | :-- | :-- | :-- |
| POST | `/api/attachments` | owner/editor | Carica un file (base64) |
| GET | `/api/attachments?site_id=&entity_type=&entity_id=` | membro; per `hse_event` owner/editor/verifier | Metadati degli allegati |
| GET | `/api/attachments/{id}` | membro; per `hse_event` owner/editor/verifier | Scarica i byte |
| DELETE | `/api/attachments/{id}` | owner/editor | Elimina |

Per gli allegati a un evento HSE valgono le regole del registro: servono il modulo HSE e un ruolo tra owner, editor e verificatore per la lettura; caricamento ed eliminazione restano a owner ed editor. Un evento eliminato nasconde i suoi allegati: l'elenco non li restituisce e il download risponde `404 HSE_NOT_FOUND`. Gli allegati a un'ispezione HSE seguono la stessa matrice del registro HSE; anche per loro caricamento ed eliminazione restano a owner ed editor, e un allegato si vede solo se l'ispezione esiste nello stesso cantiere. Ogni download di un allegato HSE — di un evento o di un'ispezione — scrive una voce `read` nel registro di audit, con id e nome del file; se la scrittura fallisce il download riesce comunque. La descrizione facoltativa del modulo di caricamento serve solo all'avviso nell'interfaccia: non viene inviata né salvata.

Sono ammessi file fino a **15 MiB**, di tipo immagine o PDF (`UNSUPPORTED_MEDIA_TYPE`, `ATTACHMENT_TOO_LARGE`). Il caricamento e l'eliminazione sono riservati a owner ed editor; la lettura a tutti i membri, con l'eccezione HSE qui sopra. Prima di registrare l'allegato l'applicazione rilegge i byte salvati e confronta il checksum: se non coincide, il file viene rimosso e la risposta è `502`.

## Limiti di richiesta e paginazione

Ogni richiesta a `/api/` consuma un limite a finestra mobile di un minuto: **600 richieste al minuto per sessione autenticata** e **60 al minuto per indirizzo di rete** per le richieste anonime. Le quattro rotte di autenticazione (`/api/auth/login`, `/api/auth/forgot`, `/api/auth/password`, `/api/auth/request`) hanno un limite proprio e non consumano quello generale. Oltre il limite la risposta è `429 RATE_LIMITED` con l'intestazione `Retry-After` in secondi; `X-RateLimit-Remaining` dice quante richieste restano nella finestra. I valori si cambiano con le variabili `RATE_LIMIT_USER_PER_MIN` e `RATE_LIMIT_ANON_PER_MIN`.

Le liste di **attività**, **diario**, **deviazioni**, **avanzamento di cantiere**, **prenotazioni ore** e **registro di audit** accettano `limit` (default **50**, massimo **200**) e `offset` (default 0). Valori non interi o fuori intervallo sono rifiutati con `400 VALIDATION_ERROR`. La risposta resta un array; il totale, il limite applicato e l'offset arrivano nelle intestazioni `X-Total-Count`, `X-Limit` e `X-Offset`. L'applicazione chiede 200 righe per le viste che caricano l'elenco intero, quindi nessuna vista perde record.

## Errori

Le risposte d'errore includono i campi `{ "error": "messaggio", "code": "CODICE" }`. I codici più comuni: `VALIDATION_ERROR` (400), `INVALID_CREDENTIALS` (401), `FORBIDDEN` (403), `NOT_FOUND` (404), `DUPLICATE_SITE_CODE` e `DUPLICATE_DIARY` (409), `INVALID_TRANSITION` e `TIME_BOOKING_DUPLICATE` (409), `SEPARATE_PEOPLE_REQUIRED` (400), `NOTE_REQUIRED`/`REASON_REQUIRED` (400), `WEIGHTS_NOT_100` (400), `TOOL_INVALID` (400), `TOOL_FORBIDDEN` (403), `TOOL_NOT_FOUND` (404), `CERT_INVALID` (400), `CERT_FORBIDDEN` (403), `CERT_NOT_FOUND` (404), `HSE_INVALID` (400), `HSE_FORBIDDEN` (403), `HSE_NOT_FOUND` (404), `PO_NOT_FOUND`/`PO_ITEM_NOT_FOUND` (404), `PO_DUPLICATE_NUMBER`/`PO_DUPLICATE_LINE`/`PO_STATUS_CONFLICT` (409), `AUDIT_INVALID` (400), `FILE_TOO_LARGE` (413), `LINK_EXPIRED` (410), `MAP_INVALID` (400), `AMBIGUOUS_COLUMNS` (400), `PREVIEW_MISMATCH`/`PREVIEW_EXPIRED` (409), `ATTACHMENT_TOO_LARGE` (413), `UNSUPPORTED_MEDIA_TYPE` (415), `RATE_LIMITED` (429), `MAIL_NOT_CONFIGURED`/`MAIL_UNAVAILABLE` (503), `ASSISTANT_NOT_CONFIGURED` (503), `WEBAUTHN_NOT_CONFIGURED` (503), `LAST_CREDENTIAL` (409), `AUTH_REQUIRED` (401).

:::note
L'API non espone uno schema OpenAPI: le tabelle qui sopra sono il contratto corrente. Per lo schema dati completo vedi `database/README.md` nel repository.
:::
