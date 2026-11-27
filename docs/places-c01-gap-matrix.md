# Matrice dei gap per luoghi e asset / Places and assets gap matrix

## Parte italiana

### 1. Stato dell’arte al commit di base

Analisi statica del commit `46a2a464c699d75c37316c32cb91bcf82c53c16b`. La specifica dichiara la natura propositiva dei contratti e riepiloga lo stato dichiarato al §10. Le migrazioni presenti nel checkout e quelle applicate in un ambiente si verificano separatamente tramite `schema_migrations`. `docs/places-and-assets.md:3`, `docs/places-and-assets.md:145–159`, `server/migrations/index.mjs:65–82`.

#### Migrazioni

La 056 aggiunge alle ispezioni HSE `computed_outcome`, `declared_outcome`, `outcome_source` e `template_status`. Per le righe esistenti copia `outcome` in `computed_outcome` e marca la provenienza `backfilled`. Questo aggiornamento riguarda gli esiti HSE. Il collegamento obbligatorio resta verso `hse_assets`. `server/migrations/sqlite/056_hse_inspection_outcomes.sql:1–6`, `server/migrations/pg/056_hse_inspection_outcomes.sql:1–6`, `server/migrations/pg/030_hse_inspections.sql:1–16`, `server/hse-inspections.mjs:134–139`.

La 057 crea `places` con padre facoltativo dello stesso cantiere, tipi ammessi, archiviazione e metadati. Crea `assets` con stati di ciclo di vita, identificazione tecnica, date, garanzia e indice univoco del tag per cantiere sulle righe non archiviate. `asset_positions` registra autore, motivo e percorso, con riferimenti compositi per cantiere, fine successiva all’inizio e al massimo un intervallo aperto per asset. SQLite usa testo per date e istanti. PostgreSQL usa `DATE` e `TIMESTAMPTZ`. `server/migrations/sqlite/057_places_assets.sql:1–56`, `server/migrations/pg/057_places_assets.sql:1–56`.

La 057 estende l’audit a `place`, `asset`, `move` e `archive`. SQLite ricrea la tabella, copia gli eventi e ripristina gli indici. PostgreSQL modifica i vincoli. Il manifesto del commit termina a 057 in entrambi i dialetti. `server/migrations/sqlite/057_places_assets.sql:57–71`, `server/migrations/pg/057_places_assets.sql:58–63`, `tests/fixtures/migrations/manifest.json:296–308`.

#### Rotte registrate

Il dispatcher effettivo è in `server/http.mjs`. Le collezioni leggono `siteId` dalla query per GET e dal corpo per POST. Le rotte di risorsa verificano l’appartenenza usando l’ID. `/api/hse/assets` gestisce il catalogo HSE separato. `/api/location/search` serve la ricerca degli indirizzi dei cantieri. `server/http.mjs:544–603`, `server/places.mjs:54–62`, `server/places.mjs:94–103`, `server/assets.mjs:135–151`, `server/assets.mjs:171–182`, `server/http.mjs:655–658`, `server/geocode.mjs:1–10`.

| Metodo e rotta | Handler e riferimento |
| --- | --- |
| `GET /api/places` | `listPlaces` · `server/http.mjs:544–547` |
| `POST /api/places` | `createPlace` · `server/http.mjs:551–553` |
| `GET /api/places/:id` | `getPlace` · `server/http.mjs:557–560` |
| `PATCH /api/places/:id` | `updatePlace` · `server/http.mjs:557–563` |
| `GET /api/places/:id/history` | `listPlaceHistory` · `server/http.mjs:564–567` |
| `POST /api/places/:id/archive` | `archivePlace` · `server/http.mjs:568–571` |
| `GET /api/assets` | `listAssets` · `server/http.mjs:544–550` |
| `POST /api/assets` | `createAsset` · `server/http.mjs:554–556` |
| `GET /api/assets/:id` | `getAsset` · `server/http.mjs:572–575` |
| `PATCH /api/assets/:id` | `updateAsset` · `server/http.mjs:572–578` |
| `GET /api/assets/:id/positions` | `listAssetPositions` · `server/http.mjs:579–582` |
| `POST /api/assets/:id/archive` | `archiveAsset` · `server/http.mjs:583–586` |
| `POST /api/assets/:id/move` | `moveAsset` · `server/http.mjs:587–590` |

La lettura del blocco contiguo mostra che il dettaglio dei luoghi usa `/^\/api\/places\/([^/]+)$/` con GET e PATCH, seguito solo dalle regex ancorate per `history` e `archive`. Lo spostamento passa da `parentId` nel PATCH. Dopo il dettaglio degli asset, il blocco ammette soltanto GET su `positions` e POST su `archive` e `move`, poi passa alle rotte HSE. Restano quindi senza handler `POST /api/places/:id/moves`, `POST /api/assets/:id/positions`, `POST /api/assets/:id/transitions`, `GET /api/assets/:id/history` e i DELETE di luoghi e asset. Il dispatcher termina con `404 NOT_FOUND`. L’audit generale è consultabile tramite `GET /api/audit-events` con filtri e ruoli di revisione del cantiere. `server/http.mjs:557–594`, `server/places.mjs:124–140`, `server/http.mjs:1090`, `server/http.mjs:490–495`, `server/audit.mjs:46–67`.

#### Superfici dell’interfaccia

Le viste `places` e `assets` sono in `NAV_ITEMS` e nel gruppo `navSite`. Restano destinazioni di base nel filtro di visibilità e compaiono nel menu mobile «Altro». Il renderer monta `mountPlaces` e carica `mountAssets` dinamicamente. Il pannello delle abilitazioni per modulo le omette. `app/app.mjs:1689–1693`, `app/domain.mjs:306–318`, `app/app.mjs:4340`, `app/app.mjs:3709–3728`, `app/app.mjs:1203`.

Luoghi offre albero espandibile, filtri per tipo e stato, percorso, scheda con dipendenze e audit, creazione, rinomina, spostamento e archiviazione. Il selettore riutilizzabile per i luoghi è montato nei dialoghi del padre e nelle superfici asset per filtro e destinazione. `app/places-ui.mjs:28–32`, `app/places-ui.mjs:79–118`, `app/places-ui.mjs:182–240`, `app/places-ui.mjs:251–261`, `app/place-selector.mjs:39–54`, `app/assets-ui.mjs:113–125`, `app/assets-ui.mjs:219–222`.

Asset offre ricerca per tag o matricola, filtri per stato e sottoalbero, scheda con posizione, garanzia e cronologia delle posizioni. Le azioni operative sono installazione, trasferimento, passaggio a sostituito e dismissione. La vista si ferma a queste azioni, mentre creazione, modifica generica e archiviazione hanno handler HTTP. `app/assets-ui.mjs:9–25`, `app/assets-ui.mjs:61–76`, `app/assets-ui.mjs:97–125`, `app/assets-ui.mjs:135–174`, `app/assets-ui.mjs:247–268`, `server/http.mjs:554–556`, `server/http.mjs:576–586`.

Le allowlist della shell dei test browser per Luoghi, Asset e C03 elencano `places-ui.mjs`, `place-selector.mjs` e `assets-ui.mjs`. Il service worker li elenca nella shell della PWA. Le viste anagrafiche richiedono connettività. `tests/browser-places.cjs:13–17`, `tests/browser-assets.cjs:13–17`, `tests/browser-c03.cjs:143–149`, `app/sw.js:7–10`, `app/places-ui.mjs:67–77`, `app/assets-ui.mjs:53–59`.

### 2. Matrice

`coperto` indica un comportamento riscontrabile nel codice. `gap` indica uno scarto funzionale da valutare rispetto alla specifica. `escluso` indica un’attività fuori perimetro o una scelta proposta che richiede approvazione separata. Le etichette §N.X identificano le righe e rimandano alla sezione N della specifica. Il §3 serve come contesto per il ciclo di vita richiamato nei §§6 e 8. `docs/places-and-assets.md:3`, `docs/places-and-assets.md:27–41`, `docs/places-and-assets.md:68`, `docs/places-and-assets.md:135–147`.

#### §2 Modello del luogo

`docs/places-and-assets.md:18–25`.

| Requisito | Stato | Evidenza | Nota |
| --- | --- | --- | --- |
| §2.1 Identità, radice, tipo, stato e metadati | coperto | `server/migrations/sqlite/057_places_assets.sql:1–15`, `server/migrations/pg/057_places_assets.sql:1–15`, `server/places.mjs:79–83`, `server/places.mjs:94–109`, `server/places.mjs:124–138` | UUID creato dal server e stabile nelle mutazioni ordinarie. Padre nullo per un figlio diretto del cantiere, stato da `archived_at`. |
| §2.2 Un padre dello stesso cantiere e tipi in ordine | coperto | `server/migrations/pg/057_places_assets.sql:4–13`, `server/places.mjs:6`, `server/places.mjs:31–40`, `tests/places-assets.test.mjs:50–63` | Il codice realizza la proposta dei livelli omissibili e ammette ogni salto in avanti nell’ordine, comprese stanze alla radice. |
| §2.3 Percorso corrente e sottoalbero da antenati | coperto | `server/places.mjs:18–28`, `server/places.mjs:65–84`, `server/assets.mjs:109–132` | La scheda del luogo risolve il percorso corrente e il filtro asset percorre la gerarchia corrente, anche con posizione selezionata tramite `asOf`. |
| §2.4 Rinomina, spostamento e audit con identità stabili | coperto | `server/places.mjs:113–140`, `server/audit.mjs:15–35`, `server/places.mjs:87–92`, `server/assets.mjs:250–262` | Cambia il nodo radice del sottoalbero. I discendenti seguono il padre e gli asset conservano i riferimenti. Il trasferimento fisico usa una mutazione esplicita. |
| §2.5 Percorso registrato per le posizioni asset | coperto | `server/assets.mjs:78–88`, `server/assets.mjs:144–168`, `app/assets-ui.mjs:163–174` | Le posizioni mantengono il percorso dei nodi all’evento. La UI premette il nome attuale del cantiere. |
| §2.6 Percorso storico per evidenze e riferimenti di modulo | gap | `server/migrations/pg/057_places_assets.sql:41–56`, `server/http.mjs:1055–1069`, `server/http.mjs:958–990` | Lo snapshot è sulle posizioni asset. Mancano riferimenti di modulo espliciti con percorso all’evento e risoluzione delle entità archiviate. |
| §2.7 Archiviazione logica, dipendenze e selettori | coperto | `server/places.mjs:46–51`, `server/places.mjs:65–84`, `server/places.mjs:143–159`, `app/place-selector.mjs:15–23`, `app/place-selector.mjs:166–174` | Il server blocca figli attivi e posizioni aperte direttamente sul nodo. Un luogo archiviato è leggibile con stato, ed è escluso dalle nuove scelte. |
| §2.8 Nessuna cancellazione fisica ordinaria dei luoghi | coperto | `server/http.mjs:551–572`, `server/http.mjs:1090`, `tests/places-assets.test.mjs:150–155` | Il router espone l’archiviazione. La suite contiene un’asserzione HTTP per DELETE. |
| §2.9 Procedure amministrative di cancellazione | escluso | `docs/places-and-assets.md:24`, `server/http.mjs:551–572` | Il testo descrive una possibilità condizionata per record privi di figli, riferimenti e storico. Serve un perimetro amministrativo approvato. |
| §2.10 Alias tipizzati, unicità, validità e correzioni | escluso | `docs/places-and-assets.md:25`, `docs/places-and-assets.md:140`, `docs/places-and-assets.md:151–159`, `server/places.mjs:94–96`, `server/places.mjs:124–125` | Gli alias esulano da 2a. Autorità, namespace, maiuscole e minuscole, validità e storico richiedono un perimetro proprio. |

#### §4 Collegamenti con i moduli

`docs/places-and-assets.md:43–54`.

| Requisito | Stato | Evidenza | Nota |
| --- | --- | --- | --- |
| §4.1 Chiavi tipizzate, FK per cantiere e contesto alla data del fatto | gap | `server/migrations/pg/057_places_assets.sql:41–56`, `server/assets.mjs:109–132`, `server/places.mjs:65–84` | Le FK e `asOf` coprono le posizioni asset. Mancano relazioni per i record dei moduli, conferma del luogo suggerito, luogo esplicitamente diverso e risoluzione di etichette e stati archiviati. |
| §4.2 Luogo principale e asset facoltativo per attività | gap | `server/migrations/sqlite/001_init.sql:11–24`, `server/repository.mjs:278–287`, `server/repository.mjs:362–373`, `server/http.mjs:1044–1069`, `app/app.mjs:3884` | La creazione usa `area` e il PATCH aggiorna solo `wbsId`. Mancano collegamento, storico, contesto per attività chiuse e selettore nel flusso. |
| §4.3 Registro difetti e collegamento opzionale con le deviazioni | escluso | `docs/places-and-assets.md:50`, `docs/places-and-assets.md:142`, `server/migrations/sqlite/011_deviations.sql:1–23`, `server/http.mjs:919–956` | La chiave `defect_id` è condizionata a un modulo futuro. Le deviazioni usano `plc_area` e hanno flussi propri. L’estensione e la riconciliazione richiedono approvazione. |
| §4.4 Titolarità e permessi degli allegati esistenti | coperto | `server/repository.mjs:681–713`, `server/repository.mjs:745–751`, `server/repository.mjs:798–835` | Entità titolare, cantiere e modulo governano lista e download. |
| §4.5 Contesto facoltativo per foto e allegati | gap | `server/repository.mjs:681–713`, `server/repository.mjs:798–835`, `server/http.mjs:958–990` | L’allegato ha un titolare. Mancano collegamento diretto a luogo o asset e navigazione dal titolare localizzato con indicazione della provenienza. |
| §4.6 Riferimento HSE obbligatorio nel flusso esistente | coperto | `server/migrations/pg/030_hse_inspections.sql:1–16`, `server/hse-inspections.mjs:58–67`, `server/hse-inspections.mjs:112–139`, `server/hse-assets.mjs:8–9` | L’ispezione usa `hse_assets` nello stesso cantiere, esclude gli elementi eliminati e verifica il modulo HSE. La selezione server verifica `deleted_at`, mentre il campo `active` del catalogo HSE è distinto. |
| §4.7 Luogo d’ispezione e asset installato facoltativi | gap | `server/hse-inspections.mjs:63–67`, `server/hse-inspections.mjs:134–139`, `server/http.mjs:532–543` | Mancano collegamenti separati alla posizione dell’evidenza e all’asset installato, con conservazione del contesto dopo la dismissione. L’estensione HSE richiede una decisione sul perimetro. |
| §4.8 Documenti versionati con collegamenti e protezione della versione consegnata | escluso | `docs/places-and-assets.md:53`, `docs/places-and-assets.md:142`, `server/http.mjs:958–990`, `server/repository.mjs:838–845` | Lo stato attuale arriva agli allegati e alle protezioni del flusso esistente. Il registro documentale e i suoi legami sono una proposta futura. |
| §4.9 Dossier di consegna, revisione e congelamento del perimetro | escluso | `docs/places-and-assets.md:54`, `docs/places-and-assets.md:142`, `server/migrations/sqlite/001_init.sql:37–48`, `server/http.mjs:1071–1089` | Le versioni del diario riguardano il diario. Dossier, selezione esplicita, emissione e consultazione delle revisioni costituiscono un modulo futuro. |

#### §5 Migrazione e rollback

`docs/places-and-assets.md:56–64`.

| Requisito | Stato | Evidenza | Nota |
| --- | --- | --- | --- |
| §5.1 Modello additivo in coppia e registro delle versioni | coperto | `server/migrations/sqlite/057_places_assets.sql:1–56`, `server/migrations/pg/057_places_assets.sql:1–56`, `server/migrations/index.mjs:65–82` | La 057 crea le anagrafiche e le posizioni. Il loader registra solo le versioni eseguite nel database. |
| §5.2 Migrazioni additive per collegamenti tipizzati e compatibilità legacy | gap | `server/migrations/pg/057_places_assets.sql:1–56`, `server/migrations/sqlite/001_init.sql:11–24`, `server/repository.mjs:371`, `server/http.mjs:1044–1062` | Il modello si ferma alle posizioni asset. Una futura coppia di migrazioni può aggiungere i collegamenti mantenendo `area` e l’API esistente. |
| §5.3 Inventario e normalizzazione conservativa dei valori preesistenti | escluso | `docs/places-and-assets.md:58–59`, `server/repository.mjs:371`, `server/planning-import.mjs:115–124` | Percorso preliminare del backfill. `area` e `plc_area` sono input distinti e la fonte originaria richiede una verifica separata. |
| §5.4 Approvazione di mappe versionate ed eccezioni | escluso | `docs/places-and-assets.md:60`, `docs/places-and-assets.md:141`, `server/http.mjs:544–590` | La riconciliazione per cantiere e fonte, comprese le ambiguità, richiede un perimetro esplicito e un responsabile. |
| §5.5 Anteprima, attivazione per cantiere e batch idempotente con metriche | escluso | `docs/places-and-assets.md:61`, `server/http.mjs:544–590`, `server/idempotency.mjs:12–32` | Il backfill operativo è separato. L’idempotenza esistente riguarda la creazione di attività, mentre il batch proposto richiede provenienza, controlli sulle modifiche e misure dedicate. |
| §5.6 Rollback operativo selettivo e conservazione delle modifiche successive | escluso | `docs/places-and-assets.md:62`, `server/migrations/index.mjs:74–82`, `server/http.mjs:544–590` | È parte del backfill da approvare. Le transazioni del loader riguardano l’applicazione delle migrazioni. |

#### §6 API e interfaccia

`docs/places-and-assets.md:66–94`.

| Requisito | Stato | Evidenza | Nota |
| --- | --- | --- | --- |
| §6.1 Collezione luoghi, creazione, scheda, rinomina e archivio | coperto | `server/http.mjs:544–571`, `server/places.mjs:46–51`, `server/places.mjs:65–84` | La collezione restituisce un elenco piatto e gestisce `includeArchived`. L’app costruisce l’albero dai riferimenti al padre. |
| §6.2 Ricerca per nome e filtri per padre e stato lato API | gap | `server/http.mjs:544–550`, `server/places.mjs:46–51`, `app/places-ui.mjs:20–25`, `app/place-selector.mjs:31–35` | La collezione legge `siteId` e `includeArchived`. Ricerca per nome e filtri dell’albero sono locali. Manca il filtro API per padre e stato esplicito. |
| §6.3 Spostamento del sottoalbero e storico del luogo | coperto | `server/http.mjs:557–567`, `server/places.mjs:124–140`, `app/places-ui.mjs:287–291` | Lo storico ha una rotta dedicata. Lo spostamento usa PATCH con `parentId` e motivo facoltativo. |
| §6.4 Ricerca asset, registrazione, scheda, metadati e trasferimento | coperto | `server/http.mjs:544–556`, `server/http.mjs:572–590`, `server/assets.mjs:109–169`, `server/assets.mjs:208–231` | Lista per tag, matricola, stato, sottoalbero e `asOf`. Il PATCH modifica metadati e garanzia, più GET per le posizioni e POST su `move` per il trasferimento. |
| §6.5 Comando atomico di installazione da stato pianificato | gap | `server/assets.mjs:171–192`, `server/assets.mjs:208–234`, `app/assets-ui.mjs:247–274` | La creazione come installato è atomica. Nel flusso UI, se serve una posizione nuova, il trasferimento precede il PATCH e può restare salvato se il PATCH fallisce. |
| §6.6 Sostituzione con successore e data dell’evento | gap | `docs/places-and-assets.md:37`, `docs/places-and-assets.md:78`, `server/assets.mjs:7–18`, `server/assets.mjs:208–231`, `server/migrations/pg/057_places_assets.sql:17–39` | Il PATCH chiude la posizione allo stato terminale usando l’istante del server. Mancano successore, sostituzione atomica ed eventuale passaggio del tag nella stessa transazione. Il motivo è obbligatorio lato server solo per l’annullamento di un pianificato. |
| §6.7 Storico dedicato delle modifiche dell’asset | gap | `server/http.mjs:572–594`, `server/http.mjs:490–495`, `server/audit.mjs:46–68`, `server/assets.mjs:144–168` | Sono disponibili audit generale per i ruoli di revisione e posizioni per i membri del cantiere. Manca l’accesso dedicato alle modifiche dalla scheda asset. |
| §6.8 Adozione letterale del prefisso e dei metodi proposti | escluso | `docs/places-and-assets.md:68–79`, `docs/places-and-assets.md:151–158`, `server/http.mjs:544–590`, `app/api.mjs:147–159` | Il prefisso `/api/sites/:siteId`, `POST /places/:id/moves`, `POST /assets/:id/positions` e `POST /assets/:id/transitions` sono proposti. Il §10 indica come consegnata la rotta assente `/moves`. Il contratto effettivo è quello elencato al §1 di questa analisi. |
| §6.9 Revisione e chiavi di idempotenza per mutazioni anagrafiche | gap | `docs/places-and-assets.md:68`, `server/http.mjs:551–590`, `server/places.mjs:124–140`, `server/assets.mjs:195–234`, `server/http.mjs:1044–1053` | I write sono transazionali per richiesta. Mancano il controllo della revisione e il replay idempotente per creazioni ed eventi ripetibili di luoghi e asset. |
| §6.10 API per leggere, impostare e scollegare le ubicazioni dei moduli | gap | `docs/places-and-assets.md:80`, `server/http.mjs:532–543`, `server/http.mjs:958–990`, `server/http.mjs:1044–1069`, `server/http.mjs:1090` | Le route esistenti di attività, allegati e ispezioni terminano senza handler di ubicazione. Mancano creazione attività con riferimenti e audit dello scollegamento. |
| §6.11 API di mappe, backfill, difetti, documenti e dossier | escluso | `docs/places-and-assets.md:81–87`, `docs/places-and-assets.md:141–143`, `server/http.mjs:544–590`, `server/http.mjs:919–990`, `server/http.mjs:1071–1090` | Mappe e batch richiedono adozione separata. Difetti, versioni e legami documentali, revisioni ed emissione del dossier sono contratti futuri. |
| §6.12 Selettore base, percorsi completi e valore legacy | coperto | `app/place-selector.mjs:15–35`, `app/place-selector.mjs:39–71`, `app/place-selector.mjs:127–158`, `app/styles.css:1018–1033` | Ricerca per nome, percorsi per gli omonimi, supporto da tastiera e puntatore e layout adattivo. Il componente visualizza `area` se passata senza una scelta. |
| §6.13 Selettore integrato nei moduli con asset facoltativo | gap | `app/place-selector.mjs:37–42`, `app/places-ui.mjs:251–261`, `app/assets-ui.mjs:113–125`, `app/assets-ui.mjs:219–222`, `app/app.mjs:3884` | Il selettore emette solo un luogo ed è usato nei flussi anagrafici. Mancano i flussi dei moduli con coppia luogo e asset e valore legacy effettivamente passato dal chiamante. |
| §6.14 Albero luoghi con filtri, breadcrumb, azioni e dipendenze | coperto | `app/places-ui.mjs:20–32`, `app/places-ui.mjs:79–118`, `app/places-ui.mjs:144–157`, `app/places-ui.mjs:182–240` | Il dialogo mostra le dipendenze prima di spostamento o archiviazione. I conteggi delle posizioni in scheda coprono il sottoalbero. |
| §6.15 Ricerca per codice e anteprima di riconciliazione nell’albero | escluso | `docs/places-and-assets.md:91–92`, `app/place-selector.mjs:15–35`, `app/places-ui.mjs:79–118` | La ricerca per codice dipende dal perimetro degli alias. L’anteprima dipende dal backfill. |
| §6.16 Scheda asset con garanzia e cronologia delle posizioni | coperto | `app/assets-ui.mjs:135–174`, `server/assets.mjs:144–168` | Tag, matricola, posizione corrente, stato e campi garanzia sono leggibili. La cronologia mostra intervalli, motivi e percorsi registrati. |
| §6.17 Riferimenti ai record accessibili dalla scheda asset | gap | `app/assets-ui.mjs:144–174`, `server/assets.mjs:144–169`, `docs/places-and-assets.md:93` | La scheda si ferma all’anagrafica e alle posizioni. Mancano riferimenti ai record collegati e filtraggio per permessi del modulo. I documenti versionati dipendono dal registro futuro. |
| §6.18 Viste anagrafiche online ed etichette bilingui | coperto | `app/places-ui.mjs:67–77`, `app/assets-ui.mjs:53–59`, `app/i18n.mjs:704–798`, `app/i18n.mjs:1540–1634`, `app/sw.js:30–34` | Le viste richiedono connessione. Sono presenti etichette e messaggi locali in italiano e inglese. |
| §6.19 Localizzazione delle risposte di errore asset | gap | `docs/places-and-assets.md:94`, `app/places-ui.mjs:34–46`, `app/assets-ui.mjs:45–50`, `app/assets-ui.mjs:270–275` | I messaggi locali sono tradotti. Diversi errori della scheda o delle azioni asset mostrano direttamente codice e messaggio del server. |
| §6.20 Replay con UUID verificati e conflitti recuperabili | gap | `app/offline.mjs:195–214`, `app/app.mjs:4503`, `server/http.mjs:1044–1056`, `server/repository.mjs:362–373` | La coda conserva la richiesta e registra errore o retry. Il flusso attività si ferma ad `area` e alla WBS esistente. Mancano validazione al replay di luogo e asset e gestione specifica dei conflitti. |

#### §7 Permessi e ambienti demo

`docs/places-and-assets.md:96–107`.

| Requisito | Stato | Evidenza | Nota |
| --- | --- | --- | --- |
| §7.1 Autenticazione, appartenenza e ruoli di lettura | coperto | `server/http.mjs:285–286`, `server/repository.mjs:90–104`, `server/places.mjs:46–62`, `server/assets.mjs:109–116`, `server/assets.mjs:135–168` | Per le anagrafiche si controllano appartenenza e ruoli. Verificatore e viewer possono leggere nel proprio cantiere. |
| §7.2 Gestione dei luoghi riservata all’owner secondo la proposta | gap | `docs/places-and-assets.md:100–105`, `app/places-ui.mjs:28–32`, `server/place-asset-scope.mjs:45–50`, `server/repository.mjs:90–96`, `tests/places-assets.test.mjs:134–143` | La UI espone le azioni a owner e demo user. L’API ammette anche editor per creazione, rinomina, spostamento e archivio. La politica richiede conferma prima di uniformare i controlli. |
| §7.3 Operazioni asset di owner ed editor | coperto | `server/place-asset-scope.mjs:45–50`, `server/repository.mjs:90–96`, `server/assets.mjs:171–182`, `server/assets.mjs:195–209`, `app/assets-ui.mjs:20–25` | Il server usa `EDIT_ROLES`. La scheda espone le azioni di ciclo di vita in base al ruolo e allo stato. |
| §7.4 Isolamento demo su cantieri sandbox | coperto | `server/migrations/sqlite/051_demo_user.sql:44–48`, `server/signup.mjs:62–70`, `tests/places-assets.test.mjs:158–166`, `README.md:66–68` | Le appartenenze filtrate impediscono scritture demo su cantieri ordinari. Le prove nel codice usano dati sintetici. |
| §7.5 Controlli del modulo di origine su riferimenti, ricerca, conteggi e file | gap | `server/places.mjs:65–84`, `server/assets.mjs:144–168`, `server/repository.mjs:798–835` | Le schede aggregano dati anagrafici e posizioni. Le liste e i download degli allegati verificano il modulo nel flusso diretto. Manca il filtro equivalente per futuri accessi trasversali ai record dei moduli. |
| §7.6 Audit delle mutazioni anagrafiche | coperto | `server/audit.mjs:15–35`, `server/places.mjs:106–108`, `server/places.mjs:134–158`, `server/assets.mjs:184–190`, `server/assets.mjs:225–261` | Gli eventi anagrafici includono autore, istante e modifiche. L’audit di collegamento resta parte delle righe §4.1 e §6.10. |
| §7.7 Politica specifica per demo condivisa e amministrazione backfill | escluso | `docs/places-and-assets.md:105–107`, `docs/places-and-assets.md:143`, `app/places-ui.mjs:28–32`, `server/place-asset-scope.mjs:45–50` | L’abilitazione selettiva di spostamento e archivio richiede accordo con l’owner. L’amministrazione del backfill è parte di un’iniziativa separata. |

#### §8 Criteri di accettazione e test negativi

`docs/places-and-assets.md:109–123`.

| Requisito | Stato | Evidenza | Nota |
| --- | --- | --- | --- |
| §8.1 Rinomina e spostamento con UUID stabili e percorso asset conservato | coperto | `server/places.mjs:124–140`, `server/assets.mjs:78–88`, `server/assets.mjs:121–132`, `tests/places-assets.test.mjs:90–99`, `tests/assets-read.test.mjs:124–130` | Il filtro usa la gerarchia corrente e le posizioni mantengono i nodi del percorso registrato. |
| §8.2 Percorso congelato in un dossier emesso | escluso | `docs/places-and-assets.md:54`, `docs/places-and-assets.md:113`, `server/http.mjs:1071–1090` | L’asserzione dipende dal futuro modulo dossier. La conservazione delle evidenze di modulo è tracciata a §2.6 e §4.1. |
| §8.3 Rifiuto dei cicli con 409 e serializzazione delle mutazioni | coperto | `server/places.mjs:31–39`, `server/places.mjs:113–132`, `server/place-asset-scope.mjs:45–50`, `server/storage/sqlite.mjs:47–58`, `server/storage/pg.mjs:71–82` | Il controllo avviene dopo il lock del cantiere nella stessa transazione della scrittura. |
| §8.4 Riferimenti di parentela e posizione tra cantieri rifiutati senza scritture parziali | coperto | `server/place-asset-scope.mjs:52–64`, `server/places.mjs:12–15`, `server/places.mjs:31–40`, `server/assets.mjs:78–88`, `server/assets.mjs:195–205`, `tests/places-assets.test.mjs:57–63`, `tests/places-assets.test.mjs:77–88`, `tests/assets-read.test.mjs:209–212` | Il riferimento estraneo visibile dà 422. Quello non accessibile dà 404. I collegamenti con nuovi record di modulo vanno verificati quando introdotti. |
| §8.5 Cancellazione fisica ordinaria assente e archivio protetto | coperto | `server/http.mjs:551–590`, `server/migrations/sqlite/057_places_assets.sql:11–13`, `server/migrations/sqlite/057_places_assets.sql:50–53`, `server/places.mjs:143–159`, `app/place-selector.mjs:15–23`, `tests/places-read.test.mjs:164–165` | Le FK proteggono i riferimenti esistenti. Figli attivi o posizioni aperte sul nodo danno 409. Le sole posizioni storiche consentono archivio e lettura. |
| §8.6 Duplicati degli alias e concorrenza per namespace | escluso | `docs/places-and-assets.md:25`, `docs/places-and-assets.md:117`, `server/migrations/pg/057_places_assets.sql:1–15` | Il test dipende da contratto e perimetro degli alias. |
| §8.7 Tag duplicati per asset attivi respinti con 409 | coperto | `server/migrations/sqlite/057_places_assets.sql:39`, `server/migrations/pg/057_places_assets.sql:39`, `server/assets.mjs:97–106`, `tests/places-assets.test.mjs:66–74` | Il vincolo effettivo è più ampio della proposta del §3 e copre anche gli stati terminali finché non archiviati. |
| §8.8 Controlli del ciclo di vita, garanzia e intervallo aperto unico | coperto | `server/assets.mjs:7–12`, `server/assets.mjs:38–57`, `server/assets.mjs:70–95`, `server/assets.mjs:208–226`, `server/assets.mjs:250–262`, `server/migrations/pg/057_places_assets.sql:53–55`, `tests/places-assets.test.mjs:114–131` | Le richieste ordinarie controllano installazione, date e transizioni. Il trasferimento chiude e apre nella stessa transazione. |
| §8.9 Verifica del predecessore e dei suoi documenti dopo una sostituzione | gap | `server/assets.mjs:208–231`, `server/migrations/pg/057_places_assets.sql:17–39`, `server/repository.mjs:681–683` | Il passaggio a sostituito lascia leggibile il record e la matricola, ma manca un successore e manca il legame documentale dell’asset da verificare. |
| §8.10 Casi di adozione e rollback senza perdita o duplicati | escluso | `docs/places-and-assets.md:58–62`, `docs/places-and-assets.md:119`, `server/http.mjs:544–590` | Null, vuoti, varianti, omonimi e modifiche successive sono criteri del backfill separato. |
| §8.11 Compatibilità attività legacy, replay, HSE e allegati | coperto | `server/repository.mjs:371`, `app/app.mjs:633`, `app/offline.mjs:195–207`, `server/http.mjs:1044–1053`, `server/idempotency.mjs:5–32`, `server/hse-inspections.mjs:58–67`, `server/repository.mjs:745–751` | `area` rimane nel flusso. Una richiesta uguale con la stessa chiave ottiene la risposta salvata. HSE e allegati conservano le referenze originarie. |
| §8.12 Viewer senza mutazioni e scritture demo isolate | coperto | `server/repository.mjs:90–104`, `server/place-asset-scope.mjs:45–50`, `server/migrations/sqlite/051_demo_user.sql:44–48`, `tests/places-assets.test.mjs:134–143`, `tests/places-assets.test.mjs:158–166`, `tests/assets-read.test.mjs:213` | Le scritture delle anagrafiche passano dal controllo dei ruoli e delle appartenenze. |
| §8.13 Test di accesso indiretto a file, risultati e conteggi dei moduli | gap | `server/places.mjs:65–84`, `server/assets.mjs:144–168`, `server/repository.mjs:798–835`, `docs/places-and-assets.md:121` | I flussi diretti hanno controlli. I casi negativi trasversali vanno aggiunti con i collegamenti e le aggregazioni. |
| §8.14 Base dei test di vincoli e concorrenza nei due dialetti | coperto | `server/db.mjs:16`, `tests/places-assets.test.mjs:15–42`, `tests/places-assets.test.mjs:57–74`, `tests/places-assets.test.mjs:114–131`, `package.json:18` | La suite definisce casi di vincoli, duplicati concorrenti e trasferimenti concorrenti. Per il dialetto PostgreSQL usa PGlite o PostgreSQL reale secondo la configurazione. |
| §8.15 Caso concorrente specifico per la gerarchia | gap | `docs/places-and-assets.md:114`, `docs/places-and-assets.md:123`, `tests/places-assets.test.mjs:57–64`, `tests/places-assets.test.mjs:114–131`, `server/place-asset-scope.mjs:45–50` | Il lock esiste. Le asserzioni sul ciclo sono sequenziali. Il caso in parallelo riguarda i trasferimenti asset e manca il caso concorrente sui luoghi richiesto dal §8. |
| §8.16 Coerenza tra stato installato e posizione dopo l’archiviazione | gap | `docs/places-and-assets.md:31`, `docs/places-and-assets.md:39`, `server/assets.mjs:91–95`, `server/assets.mjs:236–245`, `server/http.mjs:583–586` | Creazione e aggiornamento richiedono un posto per lo stato installato. L’archiviazione può chiudere l’intervallo lasciando lo stato `installed`. Va chiarito il significato dello stato sugli asset archiviati. |

### 3. Criteri H02/H09

Al commit base, `git grep -I -n -w -e H02 -e H09 HEAD -- .` ha restituito codice 1 e nessuna occorrenza come identificatore. Le corrispondenze per sottostringa sono dati di font incorporati privi di definizioni dei criteri. L’elenco di accettazione del §8 non contiene quei riferimenti. Senza il testo della fonte non è possibile attribuire una dipendenza H02 o H09 a una riga funzionale dei §§2 e 4–8. `docs-site/src/assets/albero-wbs-en.svg:2`, `docs/places-and-assets.md:109–123`.

| Riga di accettazione esterna | Stato | Evidenza | Dipendenza |
| --- | --- | --- | --- |
| §8 · H02 | ignoto — fonte esterna al repository | `docs/places-and-assets.md:109–123` | Collegamento alle righe funzionali da determinare dalla fonte. |
| §8 · H09 | ignoto — fonte esterna al repository | `docs/places-and-assets.md:109–123` | Collegamento alle righe funzionali da determinare dalla fonte. |

Per chiudere le due righe serve la fonte di accettazione con testo e revisione dei criteri H02/H09 e la relativa associazione a righe o prove. La separazione tra planimetria e mappatura WBS deriva dalla card e non consente di attribuire per deduzione uno dei due criteri a un incremento. `docs/places-and-assets.md:109–123`, `docs/places-and-assets.md:135`, `docs/wbs.md:15–35`.

### 4. Decomposizione proposta

Il prossimo numero libero è **058**. Un incremento che cambia il modello richiede la coppia SQLite e PostgreSQL corrispondente. L’assegnazione del numero spetta al primo incremento di schema effettivamente avviato. `tests/fixtures/migrations/manifest.json:302–308`, `server/migrations/index.mjs:65–82`.

| Incremento candidato | Perimetro | Migrazione | Planimetria | Mappatura WBS | File presumibilmente toccati |
| --- | --- | --- | --- | --- | --- |
| Albero, API e ruoli dei luoghi | §6.2, §7.2, §8.15. Filtri lato server, allineamento dei ruoli dopo conferma e prova contemporanea delle mutazioni della gerarchia. Riconciliare la descrizione del PATCH con il router. `server/places.mjs:46–51`, `server/place-asset-scope.mjs:45–50`, `app/places-ui.mjs:28–32`, `tests/places-assets.test.mjs:57–64`. | No | No | No | `server/places.mjs`, `server/http.mjs`, `server/place-asset-scope.mjs`, `app/places-ui.mjs`, `tests/places-assets.test.mjs`, `docs/places-and-assets.md` |
| Contratto di scrittura delle anagrafiche | §6.9. Decidere il contratto di revisione e replay idempotente di creazioni ed eventi. Il flusso attività fornisce un precedente per l’idempotenza. `docs/places-and-assets.md:68`, `server/idempotency.mjs:12–32`, `server/http.mjs:551–590`. | Da definire, in base alla persistenza di revisioni e chiavi | No | No | `server/http.mjs`, `server/places.mjs`, `server/assets.mjs`, `server/idempotency.mjs`, `app/api.mjs`, `server/migrations/sqlite/`, `server/migrations/pg/`, `tests/places-assets.test.mjs` |
| Installazione e coerenza dell’archivio asset | §6.5 e §8.16. Riunire apertura o cambio posizione e aggiornamento di stato con data e transazione unica. Chiarire la relazione tra archiviazione e dismissione. `server/assets.mjs:171–192`, `server/assets.mjs:208–245`, `app/assets-ui.mjs:247–274`. | No con i dati esistenti | No | No | `server/assets.mjs`, `server/http.mjs`, `app/api.mjs`, `app/assets-ui.mjs`, `tests/places-assets.test.mjs` |
| Sostituzione con successore | §6.6 e §8.9. Collegare i due UUID, preservare la matricola e chiudere la posizione. Approvare l’eventuale passaggio del tag. La verifica dei documenti dipende da un collegamento documentale. `docs/places-and-assets.md:37`, `docs/places-and-assets.md:156`, `server/assets.mjs:208–231`, `server/migrations/pg/057_places_assets.sql:17–39`. | Sì, relazione tra asset e regola tag se approvata | No | No | `server/migrations/sqlite/`, `server/migrations/pg/`, `server/assets.mjs`, `server/http.mjs`, `app/assets-ui.mjs`, `tests/places-assets.test.mjs` |
| Scheda, audit e messaggi asset | §6.7 e §6.19. Esporre le modifiche tracciate nella scheda, definire il ruolo di lettura e localizzare gli errori. `server/http.mjs:490–495`, `server/audit.mjs:46–68`, `app/assets-ui.mjs:45–50`. | No per l’audit già raccolto | No | No | `server/audit.mjs`, `server/assets.mjs`, `server/http.mjs`, `app/api.mjs`, `app/assets-ui.mjs`, `app/i18n.mjs`, `tests/assets-read.test.mjs`, `tests/assets-ui.test.mjs` |
| Collegamenti delle attività | §2.6, §4.1–§4.2, §5.2, §6.10, §6.13 e §6.20 per le attività. Aggiungere collegamenti espliciti, percorso storico, selettore, replay e compatibilità con `area`. Conservare il collegamento WBS esistente. `server/repository.mjs:278–287`, `server/http.mjs:1044–1069`, `app/offline.mjs:195–214`. | Sì | No | No | `server/migrations/sqlite/`, `server/migrations/pg/`, `server/repository.mjs`, `server/http.mjs`, `app/app.mjs`, `app/api.mjs`, `app/place-selector.mjs`, `app/offline.mjs` |
| Evidenze e schede trasversali | §2.6, §4.1, §4.5, §4.7, §5.2, §6.10, §6.13, §6.17, §7.5 e §8.13 per allegati e ispezioni. Integrare allegati con provenienza, poi HSE se approvato, mantenendo la titolarità, i permessi e i casi negativi per risultati, conteggi e file. `server/repository.mjs:695–713`, `server/repository.mjs:798–835`, `server/hse-inspections.mjs:134–139`. | Sì per i nuovi collegamenti | No | No | `server/migrations/sqlite/`, `server/migrations/pg/`, `server/repository.mjs`, `server/hse-inspections.mjs`, `server/http.mjs`, `app/app.mjs`, `app/assets-ui.mjs`, `app/place-selector.mjs` |
| Planimetria | Incremento autonomo richiesto dalla card, da definire con la fonte di accettazione. La specifica cita disegni as-built come documenti e colloca BIM/GIS fuori dalla prima release. L’interfaccia attuale offre l’albero. `docs/places-and-assets.md:35`, `docs/places-and-assets.md:135`, `app/places-ui.mjs:82–118`. | Da definire. Sì se si introduce un legame persistente | Sì | No | `app/places-ui.mjs`, `app/styles.css`, `server/http.mjs`, `server/migrations/sqlite/`, `server/migrations/pg/` |
| Mappatura WBS | Incremento autonomo richiesto dalla card, da definire con la fonte di accettazione. Specificare il legame tra nodi WBS e luoghi. Il legame attività–WBS esistente è distinto. `docs/wbs.md:15–35`, `server/migrations/sqlite/036_wbs_operational.sql:6–25`, `server/repository.mjs:278–287`, `server/migrations/pg/057_places_assets.sql:1–15`. | Sì se la mappa è persistente. Confermare prima il contratto | No | Sì | `server/wbs.mjs`, `server/places.mjs`, `server/http.mjs`, `app/app.mjs`, `server/migrations/sqlite/`, `server/migrations/pg/` |

### 5. Fuori perimetro

- Alias dei luoghi, ricerca e unicità dei codici, correzioni con storico. Gli alias sono fuori da 2a e richiedono autorità, namespace, validità e regole sui codici approvati. `docs/places-and-assets.md:25`, `docs/places-and-assets.md:91`, `docs/places-and-assets.md:117`, `docs/places-and-assets.md:140`, `docs/places-and-assets.md:151–159`.

- BIM/GIS, geometrie, sincronizzazione o modifica delle sorgenti, manutenzione e ricambi, firma digitale, automazione delle scadenze di garanzia, trasferimenti tra cantieri e classificazione automatica delle foto. Sono fuori dalla prima release indicata nella specifica. `docs/places-and-assets.md:135`.

- Backfill dei luoghi e mappatura dei valori storici. Inventario, normalizzazione, approvazione, anteprima, applicazione, rollback e metriche richiedono un mandato separato. Il testo legacy resta un input distinto dal dato originario della fonte. `docs/places-and-assets.md:58–64`, `docs/places-and-assets.md:81–82`, `docs/places-and-assets.md:141`.

- Contratti e decisioni da approvare. Il prefisso e i metodi proposti, le eccezioni amministrative, i registri futuri di difetti, documenti e dossier, l’estensione alle deviazioni e le condizioni di adozione HSE richiedono perimetro. Restano da confermare livelli omissibili e posizione primaria, politiche su tag e matricole, ruoli, profondità dell’audit, conservazione e vincoli di garanzia. La matrice segnala gli scarti osservabili e mantiene il carattere propositivo di queste scelte. `docs/places-and-assets.md:3`, `docs/places-and-assets.md:21–24`, `docs/places-and-assets.md:29–41`, `docs/places-and-assets.md:50–54`, `docs/places-and-assets.md:68–87`, `docs/places-and-assets.md:137–147`.

- Planimetria e mappatura WBS sono incrementi separati indicati dalla card. Il loro perimetro specifico attende la fonte di accettazione. I disegni documentali e la WBS attuale sono punti di partenza distinti. `docs/places-and-assets.md:35`, `docs/places-and-assets.md:135`, `docs/wbs.md:15–35`.

## English part

### 1. Baseline implementation

Static review of commit `46a2a464c699d75c37316c32cb91bcf82c53c16b`. The specification describes its contracts as proposals and summarises reported implementation status in §10. The migration files in the checkout and the migrations applied in an environment are verified separately through `schema_migrations`. `docs/places-and-assets.md:3`, `docs/places-and-assets.md:145–159`, `server/migrations/index.mjs:65–82`.

#### Migrations

Migration 056 adds `computed_outcome`, `declared_outcome`, `outcome_source` and `template_status` to HSE inspections. For existing rows it copies `outcome` into `computed_outcome` and marks the source as `backfilled`. This update concerns HSE outcomes. The mandatory reference still points to `hse_assets`. `server/migrations/sqlite/056_hse_inspection_outcomes.sql:1–6`, `server/migrations/pg/056_hse_inspection_outcomes.sql:1–6`, `server/migrations/pg/030_hse_inspections.sql:1–16`, `server/hse-inspections.mjs:134–139`.

Migration 057 creates `places` with an optional same-site parent, allowed kinds, archiving and metadata. It creates `assets` with lifecycle states, technical identification, dates, warranty and a unique tag index per site across unarchived rows. `asset_positions` stores the author, reason and recorded path, with composite site-scoped references, an end after the start and at most one open interval per asset. SQLite represents dates and timestamps as text. PostgreSQL uses `DATE` and `TIMESTAMPTZ`. `server/migrations/sqlite/057_places_assets.sql:1–56`, `server/migrations/pg/057_places_assets.sql:1–56`.

Migration 057 extends auditing to `place`, `asset`, `move` and `archive`. SQLite rebuilds the table, copies events and restores the indexes. PostgreSQL updates the constraints. The baseline manifest ends at 057 for both dialects. `server/migrations/sqlite/057_places_assets.sql:57–71`, `server/migrations/pg/057_places_assets.sql:58–63`, `tests/fixtures/migrations/manifest.json:296–308`.

#### Registered routes

The dispatcher is in `server/http.mjs`. Collection routes take `siteId` from the query for GET and from the body for POST. Resource routes use the ID to check membership. `/api/hse/assets` serves the separate HSE register. `/api/location/search` is for site address lookup. `server/http.mjs:544–603`, `server/places.mjs:54–62`, `server/places.mjs:94–103`, `server/assets.mjs:135–151`, `server/assets.mjs:171–182`, `server/http.mjs:655–658`, `server/geocode.mjs:1–10`.

| Method and route | Handler and reference |
| --- | --- |
| `GET /api/places` | `listPlaces` · `server/http.mjs:544–547` |
| `POST /api/places` | `createPlace` · `server/http.mjs:551–553` |
| `GET /api/places/:id` | `getPlace` · `server/http.mjs:557–560` |
| `PATCH /api/places/:id` | `updatePlace` · `server/http.mjs:557–563` |
| `GET /api/places/:id/history` | `listPlaceHistory` · `server/http.mjs:564–567` |
| `POST /api/places/:id/archive` | `archivePlace` · `server/http.mjs:568–571` |
| `GET /api/assets` | `listAssets` · `server/http.mjs:544–550` |
| `POST /api/assets` | `createAsset` · `server/http.mjs:554–556` |
| `GET /api/assets/:id` | `getAsset` · `server/http.mjs:572–575` |
| `PATCH /api/assets/:id` | `updateAsset` · `server/http.mjs:572–578` |
| `GET /api/assets/:id/positions` | `listAssetPositions` · `server/http.mjs:579–582` |
| `POST /api/assets/:id/archive` | `archiveAsset` · `server/http.mjs:583–586` |
| `POST /api/assets/:id/move` | `moveAsset` · `server/http.mjs:587–590` |

Reading the contiguous block shows that place detail uses `/^\/api\/places\/([^/]+)$/` for GET and PATCH, followed only by anchored regexes for `history` and `archive`. A move uses `parentId` in PATCH. After asset detail, the block allows only GET on `positions` and POST on `archive` and `move`, then switches to HSE routes. Thus `POST /api/places/:id/moves`, `POST /api/assets/:id/positions`, `POST /api/assets/:id/transitions`, `GET /api/assets/:id/history` and DELETE for places and assets have no handler. The dispatcher ends in `404 NOT_FOUND`. The generic audit is available through `GET /api/audit-events` with filters and site review roles. `server/http.mjs:557–594`, `server/places.mjs:124–140`, `server/http.mjs:1090`, `server/http.mjs:490–495`, `server/audit.mjs:46–67`.

#### Interface surfaces

The `places` and `assets` views appear in `NAV_ITEMS` and the `navSite` group. They are core destinations in the visibility filter and appear under More on mobile. The renderer mounts `mountPlaces` and loads `mountAssets` dynamically. The module access panel omits them. `app/app.mjs:1689–1693`, `app/domain.mjs:306–318`, `app/app.mjs:4340`, `app/app.mjs:3709–3728`, `app/app.mjs:1203`.

Places provides an expandable tree, kind and status filters, breadcrumbs, a detail panel with dependencies and audit history, plus creation, rename, move and archive. The reusable place selector is mounted in parent dialogs and in the asset filter and destination controls. `app/places-ui.mjs:28–32`, `app/places-ui.mjs:79–118`, `app/places-ui.mjs:182–240`, `app/places-ui.mjs:251–261`, `app/place-selector.mjs:39–54`, `app/assets-ui.mjs:113–125`, `app/assets-ui.mjs:219–222`.

Assets provides tag or serial-number search, status and subtree filters, and a record card with location, warranty and position history. Its actions are install, transfer, mark as replaced and decommission. The view stops at those actions, while creation, general edits and archiving have HTTP handlers. `app/assets-ui.mjs:9–25`, `app/assets-ui.mjs:61–76`, `app/assets-ui.mjs:97–125`, `app/assets-ui.mjs:135–174`, `app/assets-ui.mjs:247–268`, `server/http.mjs:554–556`, `server/http.mjs:576–586`.

The browser shell allowlists for Places, Assets and C03 include `places-ui.mjs`, `place-selector.mjs` and `assets-ui.mjs`. The service worker lists them in the PWA shell. The register views require a connection. `tests/browser-places.cjs:13–17`, `tests/browser-assets.cjs:13–17`, `tests/browser-c03.cjs:143–149`, `app/sw.js:7–10`, `app/places-ui.mjs:67–77`, `app/assets-ui.mjs:53–59`.

### 2. Matrix

`covered` means the behaviour can be verified in code. `gap` means a functional difference from the specification to assess. `excluded` marks work outside the scope or a proposed choice requiring separate approval. Labels §N.X identify rows and refer to section N of the specification. Section 3 provides context for lifecycle behaviour referenced in §§6 and 8. `docs/places-and-assets.md:3`, `docs/places-and-assets.md:27–41`, `docs/places-and-assets.md:68`, `docs/places-and-assets.md:135–147`.

#### §2 Place model

`docs/places-and-assets.md:18–25`.

| Requirement | Status | Evidence | Note |
| --- | --- | --- | --- |
| §2.1 Identity, root, kind, status and metadata | covered | `server/migrations/sqlite/057_places_assets.sql:1–15`, `server/migrations/pg/057_places_assets.sql:1–15`, `server/places.mjs:79–83`, `server/places.mjs:94–109`, `server/places.mjs:124–138` | Server-generated UUID, stable across ordinary writes. A null parent makes the place a direct child of the site. Status derives from `archived_at`. |
| §2.2 One same-site parent and ordered kinds | covered | `server/migrations/pg/057_places_assets.sql:4–13`, `server/places.mjs:6`, `server/places.mjs:31–40`, `tests/places-assets.test.mjs:50–63` | The code implements the optional-level proposal and allows any forward skip in the ordering, including rooms at the root. |
| §2.3 Current path and subtree from ancestry | covered | `server/places.mjs:18–28`, `server/places.mjs:65–84`, `server/assets.mjs:109–132` | Place detail resolves the current path and the asset filter walks the current tree, including when `asOf` selects a historical position. |
| §2.4 Rename, move and audit with stable identities | covered | `server/places.mjs:113–140`, `server/audit.mjs:15–35`, `server/places.mjs:87–92`, `server/assets.mjs:250–262` | The write changes the subtree root. Descendants follow their parent and assets retain their references. Physical transfers use an explicit write. |
| §2.5 Recorded path for asset positions | covered | `server/assets.mjs:78–88`, `server/assets.mjs:144–168`, `app/assets-ui.mjs:163–174` | Positions retain the place-node path from the event. The UI prepends the current site name. |
| §2.6 Historical paths for evidence and module references | gap | `server/migrations/pg/057_places_assets.sql:41–56`, `server/http.mjs:1055–1069`, `server/http.mjs:958–990` | The snapshot is on asset positions. Module records lack explicit links with the path at the time of the event and resolution of archived entities. |
| §2.7 Logical archiving, dependencies and selectors | covered | `server/places.mjs:46–51`, `server/places.mjs:65–84`, `server/places.mjs:143–159`, `app/place-selector.mjs:15–23`, `app/place-selector.mjs:166–174` | The server blocks active children and open positions directly on the node. Archived places remain readable with their status and are omitted from new choices. |
| §2.8 No ordinary physical deletion of places | covered | `server/http.mjs:551–572`, `server/http.mjs:1090`, `tests/places-assets.test.mjs:150–155` | The router exposes archiving. The suite contains an HTTP assertion for DELETE. |
| §2.9 Administrative deletion procedures | excluded | `docs/places-and-assets.md:24`, `server/http.mjs:551–572` | The text describes a conditional option for records without children, references or history. It needs approved administrative scope. |
| §2.10 Typed aliases, uniqueness, validity and corrections | excluded | `docs/places-and-assets.md:25`, `docs/places-and-assets.md:140`, `docs/places-and-assets.md:151–159`, `server/places.mjs:94–96`, `server/places.mjs:124–125` | Aliases are outside 2a. Authority, namespaces, case rules, validity and history require their own scope. |

#### §4 Links with modules

`docs/places-and-assets.md:43–54`.

| Requirement | Status | Evidence | Note |
| --- | --- | --- | --- |
| §4.1 Typed keys, site-scoped FKs and context as of the event | gap | `server/migrations/pg/057_places_assets.sql:41–56`, `server/assets.mjs:109–132`, `server/places.mjs:65–84` | The FKs and `asOf` cover asset positions. Module records need links, confirmation of a suggested place, support for an explicitly different place and resolution of archived labels and statuses. |
| §4.2 Primary place and optional asset for tasks | gap | `server/migrations/sqlite/001_init.sql:11–24`, `server/repository.mjs:278–287`, `server/repository.mjs:362–373`, `server/http.mjs:1044–1069`, `app/app.mjs:3884` | Creation uses `area` and PATCH updates only `wbsId`. Links, history, context on closed tasks and a selector in the task flow are missing. |
| §4.3 Defect register and optional deviation link | excluded | `docs/places-and-assets.md:50`, `docs/places-and-assets.md:142`, `server/migrations/sqlite/011_deviations.sql:1–23`, `server/http.mjs:919–956` | The `defect_id` key depends on a future module. Deviations use `plc_area` and have their own flows. Integration and reconciliation require approval. |
| §4.4 Existing attachment ownership and access controls | covered | `server/repository.mjs:681–713`, `server/repository.mjs:745–751`, `server/repository.mjs:798–835` | The owning record, site and module govern listing and downloads. |
| §4.5 Optional context for photos and attachments | gap | `server/repository.mjs:681–713`, `server/repository.mjs:798–835`, `server/http.mjs:958–990` | An attachment has an owner. Direct place or asset links and navigation through a located owner with provenance are missing. |
| §4.6 Mandatory HSE reference in the existing flow | covered | `server/migrations/pg/030_hse_inspections.sql:1–16`, `server/hse-inspections.mjs:58–67`, `server/hse-inspections.mjs:112–139`, `server/hse-assets.mjs:8–9` | The inspection uses `hse_assets` within the same site, excludes deleted records and checks HSE module access. The server lookup checks `deleted_at`, while the HSE register has a separate `active` field. |
| §4.7 Optional inspection place and installed asset | gap | `server/hse-inspections.mjs:63–67`, `server/hse-inspections.mjs:134–139`, `server/http.mjs:532–543` | Separate links to the evidence location and installed asset are missing, along with retained context after decommissioning. The HSE extension needs a scope decision. |
| §4.8 Versioned documents with links and protection for delivered versions | excluded | `docs/places-and-assets.md:53`, `docs/places-and-assets.md:142`, `server/http.mjs:958–990`, `server/repository.mjs:838–845` | The current flow covers attachments and its existing deletion safeguards. The document register and its links are a future proposal. |
| §4.9 Handover dossier, revision and frozen scope | excluded | `docs/places-and-assets.md:54`, `docs/places-and-assets.md:142`, `server/migrations/sqlite/001_init.sql:37–48`, `server/http.mjs:1071–1089` | Diary versions apply to the diary. Dossiers, explicit selection, issue and access to revisions form a future module. |

#### §5 Migration and rollback

`docs/places-and-assets.md:56–64`.

| Requirement | Status | Evidence | Note |
| --- | --- | --- | --- |
| §5.1 Paired additive model and migration ledger | covered | `server/migrations/sqlite/057_places_assets.sql:1–56`, `server/migrations/pg/057_places_assets.sql:1–56`, `server/migrations/index.mjs:65–82` | Migration 057 creates the registers and positions. The loader records only versions executed in the database. |
| §5.2 Additive migrations for typed links and legacy compatibility | gap | `server/migrations/pg/057_places_assets.sql:1–56`, `server/migrations/sqlite/001_init.sql:11–24`, `server/repository.mjs:371`, `server/http.mjs:1044–1062` | The model stops at asset positions. A future migration pair can add links while preserving `area` and the existing API. |
| §5.3 Inventory and conservative normalisation of existing values | excluded | `docs/places-and-assets.md:58–59`, `server/repository.mjs:371`, `server/planning-import.mjs:115–124` | Preparatory work for backfill. `area` and `plc_area` are distinct inputs, and the original source requires separate verification. |
| §5.4 Approval of versioned maps and exceptions | excluded | `docs/places-and-assets.md:60`, `docs/places-and-assets.md:141`, `server/http.mjs:544–590` | Reconciliation per site and source, including ambiguous cases, requires explicit scope and a designated approver. |
| §5.5 Preview, per-site activation and idempotent batches with metrics | excluded | `docs/places-and-assets.md:61`, `server/http.mjs:544–590`, `server/idempotency.mjs:12–32` | Operational backfill is separate. Existing idempotency covers task creation. The proposed batch requires provenance, change checks and its own metrics. |
| §5.6 Selective operational rollback and preservation of later changes | excluded | `docs/places-and-assets.md:62`, `server/migrations/index.mjs:74–82`, `server/http.mjs:544–590` | This belongs to the backfill work requiring approval. Loader transactions apply migrations. |

#### §6 API and interface

`docs/places-and-assets.md:66–94`.

| Requirement | Status | Evidence | Note |
| --- | --- | --- | --- |
| §6.1 Place collection, creation, detail, rename and archive | covered | `server/http.mjs:544–571`, `server/places.mjs:46–51`, `server/places.mjs:65–84` | The collection returns a flat list and supports `includeArchived`. The app builds the tree from parent references. |
| §6.2 Server-side place name search and parent and status filters | gap | `server/http.mjs:544–550`, `server/places.mjs:46–51`, `app/places-ui.mjs:20–25`, `app/place-selector.mjs:31–35` | The collection reads `siteId` and `includeArchived`. Name search and tree filters run locally. The API lacks parent and explicit status filters. |
| §6.3 Subtree move and place history | covered | `server/http.mjs:557–567`, `server/places.mjs:124–140`, `app/places-ui.mjs:287–291` | History has a dedicated route. Moves use PATCH with `parentId` and an optional reason. |
| §6.4 Asset search, registration, detail, metadata and transfer | covered | `server/http.mjs:544–556`, `server/http.mjs:572–590`, `server/assets.mjs:109–169`, `server/assets.mjs:208–231` | The list filters by tag, serial number, status, subtree and `asOf`. PATCH edits metadata and warranty, GET reads positions, and POST on `move` records transfers. |
| §6.5 Atomic installation command from planned status | gap | `server/assets.mjs:171–192`, `server/assets.mjs:208–234`, `app/assets-ui.mjs:247–274` | Creating an already-installed asset is atomic. In the UI, when a new position is needed, the transfer precedes PATCH and can remain saved if PATCH fails. |
| §6.6 Replacement with a successor and event date | gap | `docs/places-and-assets.md:37`, `docs/places-and-assets.md:78`, `server/assets.mjs:7–18`, `server/assets.mjs:208–231`, `server/migrations/pg/057_places_assets.sql:17–39` | PATCH closes the position on transition to a terminal state using server time. A successor, atomic replacement and optional tag transfer in the same transaction are missing. The server requires a reason only when cancelling a planned asset. |
| §6.7 Dedicated record of asset changes | gap | `server/http.mjs:572–594`, `server/http.mjs:490–495`, `server/audit.mjs:46–68`, `server/assets.mjs:144–168` | Site review roles have the generic audit, and site members have position history. The asset record lacks dedicated access to tracked changes. |
| §6.8 Literal adoption of the proposed prefix and methods | excluded | `docs/places-and-assets.md:68–79`, `docs/places-and-assets.md:151–158`, `server/http.mjs:544–590`, `app/api.mjs:147–159` | The `/api/sites/:siteId` prefix, `POST /places/:id/moves`, `POST /assets/:id/positions` and `POST /assets/:id/transitions` are proposals. Section 10 lists the absent route `/moves` as delivered. The actual contract is listed in section 1 of this review. |
| §6.9 Revisions and idempotency keys for register writes | gap | `docs/places-and-assets.md:68`, `server/http.mjs:551–590`, `server/places.mjs:124–140`, `server/assets.mjs:195–234`, `server/http.mjs:1044–1053` | Writes are transactional per request. Place and asset creation and retryable events lack revision checks and idempotent replay. |
| §6.10 API to read, set and unlink module locations | gap | `docs/places-and-assets.md:80`, `server/http.mjs:532–543`, `server/http.mjs:958–990`, `server/http.mjs:1044–1069`, `server/http.mjs:1090` | Existing task, attachment and inspection routes have no location handler. Task creation with references and unlink auditing are missing. |
| §6.11 APIs for mappings, backfill, defects, documents and handovers | excluded | `docs/places-and-assets.md:81–87`, `docs/places-and-assets.md:141–143`, `server/http.mjs:544–590`, `server/http.mjs:919–990`, `server/http.mjs:1071–1090` | Mappings and batches require separate adoption work. Defects, document versions and links, and handover revisions and issue are future contracts. |
| §6.12 Base selector, full paths and legacy value | covered | `app/place-selector.mjs:15–35`, `app/place-selector.mjs:39–71`, `app/place-selector.mjs:127–158`, `app/styles.css:1018–1033` | The component offers name search, paths for homonyms, keyboard and pointer input, and responsive layout. It displays `area` when supplied without a selection. |
| §6.13 Module selector with an optional asset | gap | `app/place-selector.mjs:37–42`, `app/places-ui.mjs:251–261`, `app/assets-ui.mjs:113–125`, `app/assets-ui.mjs:219–222`, `app/app.mjs:3884` | The selector emits only a place and is used in register workflows. Module workflows with a place and asset pair and the legacy value supplied by the caller are missing. |
| §6.14 Place tree with filters, breadcrumbs, actions and dependencies | covered | `app/places-ui.mjs:20–32`, `app/places-ui.mjs:79–118`, `app/places-ui.mjs:144–157`, `app/places-ui.mjs:182–240` | The dialog shows dependencies before moving or archiving. Position counts in the detail view cover the subtree. |
| §6.15 Code search and reconciliation preview in the tree | excluded | `docs/places-and-assets.md:91–92`, `app/place-selector.mjs:15–35`, `app/places-ui.mjs:79–118` | Code search depends on alias scope. Preview depends on backfill. |
| §6.16 Asset record with warranty and position history | covered | `app/assets-ui.mjs:135–174`, `server/assets.mjs:144–168` | Tag, serial number, current position, status and warranty fields are readable. History shows intervals, reasons and recorded paths. |
| §6.17 Links to accessible records from the asset card | gap | `app/assets-ui.mjs:144–174`, `server/assets.mjs:144–169`, `docs/places-and-assets.md:93` | The record card stops at register data and positions. Linked records and filtering by module permissions are missing. Versioned documents depend on the future register. |
| §6.18 Online register views and bilingual labels | covered | `app/places-ui.mjs:67–77`, `app/assets-ui.mjs:53–59`, `app/i18n.mjs:704–798`, `app/i18n.mjs:1540–1634`, `app/sw.js:30–34` | The views require a connection. Italian and English labels and local messages are present. |
| §6.19 Localisation of asset error responses | gap | `docs/places-and-assets.md:94`, `app/places-ui.mjs:34–46`, `app/assets-ui.mjs:45–50`, `app/assets-ui.mjs:270–275` | Local messages are translated. Several asset record or action errors display the server code and message directly. |
| §6.20 Replay with validated UUIDs and recoverable conflicts | gap | `app/offline.mjs:195–214`, `app/app.mjs:4503`, `server/http.mjs:1044–1056`, `server/repository.mjs:362–373` | The queue retains the request and records errors or retries. The task flow supports `area` and the existing WBS field. Place and asset validation on replay and specific conflict handling are missing. |

#### §7 Permissions and demo environments

`docs/places-and-assets.md:96–107`.

| Requirement | Status | Evidence | Note |
| --- | --- | --- | --- |
| §7.1 Authentication, membership and read roles | covered | `server/http.mjs:285–286`, `server/repository.mjs:90–104`, `server/places.mjs:46–62`, `server/assets.mjs:109–116`, `server/assets.mjs:135–168` | Register access checks membership and roles. Verifiers and viewers can read within their own site. |
| §7.2 Owner-only place management under the proposed role model | gap | `docs/places-and-assets.md:100–105`, `app/places-ui.mjs:28–32`, `server/place-asset-scope.mjs:45–50`, `server/repository.mjs:90–96`, `tests/places-assets.test.mjs:134–143` | The UI shows actions to owners and demo users. The API also allows editors to create, rename, move and archive places. The policy needs confirmation before the checks are aligned. |
| §7.3 Owner and editor asset operations | covered | `server/place-asset-scope.mjs:45–50`, `server/repository.mjs:90–96`, `server/assets.mjs:171–182`, `server/assets.mjs:195–209`, `app/assets-ui.mjs:20–25` | The server uses `EDIT_ROLES`. The record card shows lifecycle actions based on role and status. |
| §7.4 Demo isolation to sandbox sites | covered | `server/migrations/sqlite/051_demo_user.sql:44–48`, `server/signup.mjs:62–70`, `tests/places-assets.test.mjs:158–166`, `README.md:66–68` | Filtered memberships prevent demo writes on ordinary sites. The test code uses synthetic data. |
| §7.5 Originating module checks for links, search, counts and files | gap | `server/places.mjs:65–84`, `server/assets.mjs:144–168`, `server/repository.mjs:798–835` | Record cards aggregate register and position data. Attachment lists and downloads check the module in their direct flow. An equivalent filter is missing for future cross-module access to records. |
| §7.6 Register mutation auditing | covered | `server/audit.mjs:15–35`, `server/places.mjs:106–108`, `server/places.mjs:134–158`, `server/assets.mjs:184–190`, `server/assets.mjs:225–261` | Register events include the author, timestamp and changes. Link auditing remains part of rows §4.1 and §6.10. |
| §7.7 Specific shared-demo and backfill administration policy | excluded | `docs/places-and-assets.md:105–107`, `docs/places-and-assets.md:143`, `app/places-ui.mjs:28–32`, `server/place-asset-scope.mjs:45–50` | Selective enablement of move and archive requires owner agreement. Backfill administration belongs to separate work. |

#### §8 Acceptance criteria and negative tests

`docs/places-and-assets.md:109–123`.

| Requirement | Status | Evidence | Note |
| --- | --- | --- | --- |
| §8.1 Rename and move with stable UUIDs and retained asset paths | covered | `server/places.mjs:124–140`, `server/assets.mjs:78–88`, `server/assets.mjs:121–132`, `tests/places-assets.test.mjs:90–99`, `tests/assets-read.test.mjs:124–130` | The filter uses the current tree and positions retain the nodes of the recorded path. |
| §8.2 Frozen path in an issued handover dossier | excluded | `docs/places-and-assets.md:54`, `docs/places-and-assets.md:113`, `server/http.mjs:1071–1090` | The assertion depends on the future handover module. Retention for module evidence is tracked in §2.6 and §4.1. |
| §8.3 409 cycle rejection and serialised writes | covered | `server/places.mjs:31–39`, `server/places.mjs:113–132`, `server/place-asset-scope.mjs:45–50`, `server/storage/sqlite.mjs:47–58`, `server/storage/pg.mjs:71–82` | The check runs after acquiring the site lock in the same transaction as the write. |
| §8.4 Cross-site parent and position references rejected without partial writes | covered | `server/place-asset-scope.mjs:52–64`, `server/places.mjs:12–15`, `server/places.mjs:31–40`, `server/assets.mjs:78–88`, `server/assets.mjs:195–205`, `tests/places-assets.test.mjs:57–63`, `tests/places-assets.test.mjs:77–88`, `tests/assets-read.test.mjs:209–212` | A visible foreign reference returns 422. An inaccessible one returns 404. References from new module records need checks when those links are introduced. |
| §8.5 No ordinary physical deletion and guarded archiving | covered | `server/http.mjs:551–590`, `server/migrations/sqlite/057_places_assets.sql:11–13`, `server/migrations/sqlite/057_places_assets.sql:50–53`, `server/places.mjs:143–159`, `app/place-selector.mjs:15–23`, `tests/places-read.test.mjs:164–165` | The FKs protect existing references. Active children or open positions at the node return 409. Historical positions alone allow archiving and continued access. |
| §8.6 Duplicate aliases and concurrent writes per namespace | excluded | `docs/places-and-assets.md:25`, `docs/places-and-assets.md:117`, `server/migrations/pg/057_places_assets.sql:1–15` | The test depends on an agreed alias contract and scope. |
| §8.7 Duplicate active asset tags rejected with 409 | covered | `server/migrations/sqlite/057_places_assets.sql:39`, `server/migrations/pg/057_places_assets.sql:39`, `server/assets.mjs:97–106`, `tests/places-assets.test.mjs:66–74` | The implemented constraint is broader than the §3 proposal and also covers terminal states until archived. |
| §8.8 Lifecycle and warranty checks and one open interval | covered | `server/assets.mjs:7–12`, `server/assets.mjs:38–57`, `server/assets.mjs:70–95`, `server/assets.mjs:208–226`, `server/assets.mjs:250–262`, `server/migrations/pg/057_places_assets.sql:53–55`, `tests/places-assets.test.mjs:114–131` | Ordinary requests validate installation, dates and transitions. A transfer closes and opens positions in one transaction. |
| §8.9 Verify the predecessor and its documents after replacement | gap | `server/assets.mjs:208–231`, `server/migrations/pg/057_places_assets.sql:17–39`, `server/repository.mjs:681–683` | Marking an asset as replaced leaves the record and serial number readable, but there is no successor or asset document link to verify. |
| §8.10 Adoption and rollback cases without loss or duplicates | excluded | `docs/places-and-assets.md:58–62`, `docs/places-and-assets.md:119`, `server/http.mjs:544–590` | Nulls, blanks, variants, homonyms and later edits are acceptance cases for separate backfill work. |
| §8.11 Legacy task, replay, HSE and attachment compatibility | covered | `server/repository.mjs:371`, `app/app.mjs:633`, `app/offline.mjs:195–207`, `server/http.mjs:1044–1053`, `server/idempotency.mjs:5–32`, `server/hse-inspections.mjs:58–67`, `server/repository.mjs:745–751` | `area` remains in the flow. The same request with the same key returns the saved response. HSE and attachments keep their original references. |
| §8.12 No viewer writes and isolated demo writes | covered | `server/repository.mjs:90–104`, `server/place-asset-scope.mjs:45–50`, `server/migrations/sqlite/051_demo_user.sql:44–48`, `tests/places-assets.test.mjs:134–143`, `tests/places-assets.test.mjs:158–166`, `tests/assets-read.test.mjs:213` | Register writes go through role and membership checks. |
| §8.13 Tests for indirect access to module files, results and counts | gap | `server/places.mjs:65–84`, `server/assets.mjs:144–168`, `server/repository.mjs:798–835`, `docs/places-and-assets.md:121` | Direct flows have access checks. Cross-module negative cases need to accompany the links and aggregates. |
| §8.14 Baseline constraint and concurrency tests in both dialects | covered | `server/db.mjs:16`, `tests/places-assets.test.mjs:15–42`, `tests/places-assets.test.mjs:57–74`, `tests/places-assets.test.mjs:114–131`, `package.json:18` | The suite defines constraint, concurrent duplicate and concurrent transfer cases. It uses PGlite or real PostgreSQL for that dialect, depending on configuration. |
| §8.15 Specific concurrent hierarchy test | gap | `docs/places-and-assets.md:114`, `docs/places-and-assets.md:123`, `tests/places-assets.test.mjs:57–64`, `tests/places-assets.test.mjs:114–131`, `server/place-asset-scope.mjs:45–50` | The lock exists. Cycle assertions are sequential. The parallel case exercises asset transfers, leaving the §8 concurrent place case uncovered. |
| §8.16 Consistency of installed status and position after archiving | gap | `docs/places-and-assets.md:31`, `docs/places-and-assets.md:39`, `server/assets.mjs:91–95`, `server/assets.mjs:236–245`, `server/http.mjs:583–586` | Creation and updates require a place for installed status. Archiving can close the interval while leaving the status `installed`. The meaning of that status on archived assets needs clarification. |

### 3. H02/H09 criteria

At the baseline, `git grep -I -n -w -e H02 -e H09 HEAD -- .` returned exit code 1 with no identifier matches. Substring matches occur in embedded font data without defining either criterion. The §8 acceptance list contains neither reference. Without the source text, no functional row in §§2 and 4–8 can be assigned an H02 or H09 dependency. `docs-site/src/assets/albero-wbs-en.svg:2`, `docs/places-and-assets.md:109–123`.

| External acceptance row | Status | Evidence | Dependency |
| --- | --- | --- | --- |
| §8 · H02 | unknown — source outside the repository | `docs/places-and-assets.md:109–123` | The source is needed to identify the affected functional rows. |
| §8 · H09 | unknown — source outside the repository | `docs/places-and-assets.md:109–123` | The source is needed to identify the affected functional rows. |

To close both rows, obtain the acceptance source with the text and revision of H02/H09 and the corresponding row or test mapping. The card requires separate floor plan and WBS mapping work. That instruction does not establish which criterion applies to either increment. `docs/places-and-assets.md:109–123`, `docs/places-and-assets.md:135`, `docs/wbs.md:15–35`.

### 4. Proposed increments

The next available migration number is **058**. A model change needs matching SQLite and PostgreSQL migrations. The number belongs to whichever schema increment starts first. `tests/fixtures/migrations/manifest.json:302–308`, `server/migrations/index.mjs:65–82`.

| Candidate increment | Scope | Migration | Floor plan | WBS mapping | Likely files |
| --- | --- | --- | --- | --- | --- |
| Place tree, API and roles | §6.2, §7.2, §8.15. Server-side filters, role alignment after confirmation and a concurrent hierarchy test. Align the description of PATCH with the router. `server/places.mjs:46–51`, `server/place-asset-scope.mjs:45–50`, `app/places-ui.mjs:28–32`, `tests/places-assets.test.mjs:57–64`. | No | No | No | `server/places.mjs`, `server/http.mjs`, `server/place-asset-scope.mjs`, `app/places-ui.mjs`, `tests/places-assets.test.mjs`, `docs/places-and-assets.md` |
| Register write contract | §6.9. Agree on revisions and idempotent replay for creation and events. The task flow provides an idempotency precedent. `docs/places-and-assets.md:68`, `server/idempotency.mjs:12–32`, `server/http.mjs:551–590`. | Depends on how revisions and keys are stored | No | No | `server/http.mjs`, `server/places.mjs`, `server/assets.mjs`, `server/idempotency.mjs`, `app/api.mjs`, `server/migrations/sqlite/`, `server/migrations/pg/`, `tests/places-assets.test.mjs` |
| Installation and asset archive consistency | §6.5 and §8.16. Combine opening or changing a position and updating status, with a date and a single transaction. Clarify the relationship between archiving and decommissioning. `server/assets.mjs:171–192`, `server/assets.mjs:208–245`, `app/assets-ui.mjs:247–274`. | No with the existing fields | No | No | `server/assets.mjs`, `server/http.mjs`, `app/api.mjs`, `app/assets-ui.mjs`, `tests/places-assets.test.mjs` |
| Replacement with a successor | §6.6 and §8.9. Link both UUIDs, retain the serial number and close the position. Approve any tag transfer. Verifying documents depends on a document link. `docs/places-and-assets.md:37`, `docs/places-and-assets.md:156`, `server/assets.mjs:208–231`, `server/migrations/pg/057_places_assets.sql:17–39`. | Yes, for the asset relationship and any approved tag policy | No | No | `server/migrations/sqlite/`, `server/migrations/pg/`, `server/assets.mjs`, `server/http.mjs`, `app/assets-ui.mjs`, `tests/places-assets.test.mjs` |
| Asset card, audit and messages | §6.7 and §6.19. Show tracked changes on the record card, define read access and localise errors. `server/http.mjs:490–495`, `server/audit.mjs:46–68`, `app/assets-ui.mjs:45–50`. | No for audit data already collected | No | No | `server/audit.mjs`, `server/assets.mjs`, `server/http.mjs`, `app/api.mjs`, `app/assets-ui.mjs`, `app/i18n.mjs`, `tests/assets-read.test.mjs`, `tests/assets-ui.test.mjs` |
| Task links | §2.6, §4.1–§4.2, §5.2, §6.10, §6.13 and §6.20 for tasks. Add explicit links, historical paths, the selector, replay handling and `area` compatibility. Retain the existing WBS link. `server/repository.mjs:278–287`, `server/http.mjs:1044–1069`, `app/offline.mjs:195–214`. | Yes | No | No | `server/migrations/sqlite/`, `server/migrations/pg/`, `server/repository.mjs`, `server/http.mjs`, `app/app.mjs`, `app/api.mjs`, `app/place-selector.mjs`, `app/offline.mjs` |
| Evidence and cross-module record cards | §2.6, §4.1, §4.5, §4.7, §5.2, §6.10, §6.13, §6.17, §7.5 and §8.13 for attachments and inspections. Add attachments with provenance, then HSE if approved, preserving record ownership and permissions and covering negative cases for results, counts and files. `server/repository.mjs:695–713`, `server/repository.mjs:798–835`, `server/hse-inspections.mjs:134–139`. | Yes for the new links | No | No | `server/migrations/sqlite/`, `server/migrations/pg/`, `server/repository.mjs`, `server/hse-inspections.mjs`, `server/http.mjs`, `app/app.mjs`, `app/assets-ui.mjs`, `app/place-selector.mjs` |
| Floor plan | A separate increment required by the card, to be scoped using the acceptance source. The specification lists as-built drawings as documents and puts BIM/GIS outside the first release. The current interface provides the tree. `docs/places-and-assets.md:35`, `docs/places-and-assets.md:135`, `app/places-ui.mjs:82–118`. | To be determined. Yes if a persistent link is introduced | Yes | No | `app/places-ui.mjs`, `app/styles.css`, `server/http.mjs`, `server/migrations/sqlite/`, `server/migrations/pg/` |
| WBS mapping | A separate increment required by the card, to be scoped using the acceptance source. Define the link between WBS nodes and places. The existing task-to-WBS link is separate. `docs/wbs.md:15–35`, `server/migrations/sqlite/036_wbs_operational.sql:6–25`, `server/repository.mjs:278–287`, `server/migrations/pg/057_places_assets.sql:1–15`. | Yes if the mapping is persisted. Confirm the contract first | No | Yes | `server/wbs.mjs`, `server/places.mjs`, `server/http.mjs`, `app/app.mjs`, `server/migrations/sqlite/`, `server/migrations/pg/` |

### 5. Out of scope

- Place aliases, code search and uniqueness, and correction history. Aliases are outside 2a and need agreed authorities, namespaces, validity and code rules. `docs/places-and-assets.md:25`, `docs/places-and-assets.md:91`, `docs/places-and-assets.md:117`, `docs/places-and-assets.md:140`, `docs/places-and-assets.md:151–159`.

- BIM/GIS, geometries, source synchronisation or modification, maintenance and spares, digital signatures, automated warranty deadlines, transfers between sites and automatic photo classification. These are outside the first release described in the specification. `docs/places-and-assets.md:135`.

- Place backfill and historical value mapping. Inventory, normalisation, approval, preview, application, rollback and metrics need separate authorisation. Legacy text is distinct from the original source data. `docs/places-and-assets.md:58–64`, `docs/places-and-assets.md:81–82`, `docs/places-and-assets.md:141`.

- Contracts and decisions requiring approval. The proposed prefix and methods, administrative exceptions, future defect, document and handover registers, deviation integration and HSE adoption conditions need scope decisions. Optional levels and primary position, tag and serial-number policies, roles, audit depth, retention and warranty constraints remain subject to confirmation. The matrix records observable differences and preserves the proposed status of these choices. `docs/places-and-assets.md:3`, `docs/places-and-assets.md:21–24`, `docs/places-and-assets.md:29–41`, `docs/places-and-assets.md:50–54`, `docs/places-and-assets.md:68–87`, `docs/places-and-assets.md:137–147`.

- Floor plans and WBS mapping are separate increments identified by the card. Their detailed scope awaits the acceptance source. Drawings treated as documents and the existing WBS are distinct starting points. `docs/places-and-assets.md:35`, `docs/places-and-assets.md:135`, `docs/wbs.md:15–35`.
