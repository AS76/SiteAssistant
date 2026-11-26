# Specifica dei luoghi e degli asset installati

Proposta per SiteAssistant, verificata su `origin/main` al commit `3313f4e`. Il comportamento futuro descritto nelle sezioni seguenti richiede implementazione e approvazione. Le osservazioni sul comportamento attuale riportano i riferimenti al checkout.

## 1. Problema e casi d’uso

Oggi l’attività appartiene a un sito e ha un campo testuale facoltativo `area`. La creazione legge il testo e la lista lo mostra direttamente (`server/migrations/pg/001_init.sql:11–24`, `server/repository.mjs:360–369`, `app/app.mjs:585`). Il testo da solo non identifica un locale né permette di ritrovare in modo affidabile tutte le evidenze sullo stesso componente.

Gli esempi seguenti descrivono pratiche di cantiere e impiantistiche. Sono scenari illustrativi, senza dati o record di SiteAssistant.

| Contesto | Operazione e risultato atteso |
| --- | --- |
| Cantiere | Durante il giro delle finiture si rileva che una porta tagliafuoco non chiude. Difetto, foto e attività correttiva sono reperibili dal locale. Se la porta è censita, si naviga anche dalla sua scheda. |
| Impianto | Durante il collaudo di un’unità di trattamento aria, il tecnico associa verbale e foto della targhetta all’unità. Il percorso mostra il locale tecnico e lo distingue dal locale omonimo di un altro edificio. |
| Manutenzione | Una pompa di ricircolo viene sostituita. Il manutentore recupera seriale e garanzia della nuova pompa e consulta gli interventi precedenti sotto la vecchia pompa. |
| Handover | Per la consegna di un piano il responsabile raccoglie elenco asset, manuali, verbali e difetti aperti. A consegna emessa conserva la versione del fascicolo anche se cambiano le denominazioni dei locali. |

## 2. Modello dei luoghi

- Il sito esistente è la radice. Ogni luogo ha UUID immutabile, `site_id`, riferimento al padre, tipo, nome, stato e metadati di creazione e modifica. L’UUID del luogo resta stabile anche se cambia il percorso. Un padre nullo indica un figlio diretto del sito.
- Percorso ordinario `sito → edificio → piano → zona → locale`. Proposta per cantieri senza edificio e piani senza zone: si possono omettere livelli intermedi rispettando l’ordine dei tipi. Si ammettono ad esempio una zona esterna direttamente sotto il sito e un locale direttamente sotto il piano. Un nodo ha un solo padre e appartiene sempre allo stesso sito.
- Percorso corrente e inclusione nei filtri per sottoalbero derivano dagli antenati. Allegati, dati di garanzia e diritti dei moduli restano associati alle entità che li possiedono. Il nodo padre non assegna automaticamente un luogo ai record dei figli. I record storici conservano anche il percorso registrato al momento pertinente.
- La rinomina modifica l’etichetta. Lo spostamento cambia il padre dell’intero sottoalbero con controllo dei tipi e degli antenati. Entrambe le operazioni registrano autore, istante e valori precedenti. Asset e record collegati mantengono gli UUID. La posizione fisica di un asset cambia solo con un movimento esplicito. Un aggiornamento fra siti viene respinto.
- La rimozione ordinaria è archiviazione logica. Si lavora dalle foglie verso la radice: bloccare l’archiviazione con figli attivi o asset previsti o installati la cui posizione corrente è nel nodo. Con soli riferimenti documentali o storici, consentire l’archiviazione e rendere il nodo consultabile con stato visibile. Il selettore per nuovi collegamenti esclude i nodi archiviati. L’API ordinaria non offre eliminazione fisica. Eventuali procedure amministrative di correzione possono eliminare solo record privi di figli, riferimenti e storico.
- Codici committente ed esportazioni usano alias espliciti `site_id + namespace + codice canonico → place_id`. Il namespace identifica l’autorità o la fonte e, se necessario, il perimetro del catalogo. Conservare codice originale, fonte e validità. Impedire doppia assegnazione del codice canonico nello stesso namespace e sito, anche dopo archiviazione. Un codice corretto lascia traccia dell’alias precedente. Mai ricavare identità da nome o percorso. La politica di maiuscole e minuscole dei codici si concorda per fonte.

## 3. Registro degli asset installati

| Dato | Regola proposta |
| --- | --- |
| Minimo | UUID immutabile, sito, tag, denominazione, categoria, stato e metadati di creazione/modifica. Tag univoco nel sito fra asset attivi o previsti. Posizione corrente obbligatoria all’installazione, facoltativa in previsione. |
| Identificazione tecnica | Seriale, produttore, modello, sistema impiantistico, riferimenti esterni. Seriale richiesto solo per categorie approvate dall’owner. Valore assente esplicito. Il seriale da solo non identifica l’asset. |
| Date operative | Data di installazione, collaudo e messa in servizio distinte. Registrare la data effettiva di passaggio allo stato installato. |
| Garanzia | Fornitore o garante, riferimento, data iniziale e finale, condizioni e documento. Date facoltative, con fine uguale o successiva all’inizio quando note. Nessuna scadenza implicita in assenza dei dati contrattuali. |
| Documenti | Riferimenti a versioni di manuali, dichiarazioni, verbali, elaborati as-built e prove di garanzia. Metadati del documento separati dai byte dell’allegato. |

Transizioni proposte: previsto → installato → sostituito o dismesso. Un previsto annullato può essere dismesso con motivo. Una sostituzione chiude la posizione del vecchio asset e collega il suo UUID a quello del nuovo, che ha identità e garanzia proprie. Se il tag designa la posizione funzionale, il successore può ereditarlo nella stessa transazione dopo la chiusura del predecessore. Il tag precedente resta visibile nello storico. Stati terminali consultabili, con correzioni amministrative tracciate.

Ogni posizione ha `site_id`, `asset_id`, `place_id`, inizio e fine di validità, autore, motivo e percorso registrato. Gli intervalli non si sovrappongono e al massimo uno è aperto. Il trasferimento fisico chiude e apre gli intervalli nella stessa transazione. Un luogo può contenere più asset. Per il primo rilascio ogni asset installato ha un solo luogo corrente.

Il registro proposto ha un’identità separata da `hse_assets`. Oggi quella tabella gestisce beni HSE dei tipi `tool`, `site_work` e `ppe` con template di controllo. L’ispezione HSE richiede il loro ID. È possibile aggiungere un riferimento esplicito all’asset installato per l’attrezzatura che compare in entrambi i registri (`server/migrations/sqlite/029_hse_assets.sql:1–16`, `server/migrations/sqlite/030_hse_inspections.sql:1–16`).

## 4. Collegamenti con i moduli

Usare chiavi tipizzate per modulo con `site_id` e UUID del record, del luogo e dell’asset secondo necessità. I riferimenti devono essere verificabili con vincoli che includano il sito. Dove luogo e asset compaiono insieme, il luogo del record descrive l’evidenza al momento del fatto. Si può proporre il luogo dell’asset valido a quella data, con conferma. Un luogo diverso è ammesso se esplicito, ad esempio per una foto scattata in officina prima della posa. Per riferimenti in sola lettura o archiviati, mantenere visibili gli ID risolti con etichetta e stato, oltre al percorso registrato. Le viste aggregate applicano i permessi del modulo originario.

| Modulo | Punto di partenza verificato | Chiave proposta | Rimozione e migrazione |
| --- | --- | --- | --- |
| Attività | `tasks.area` testuale. Il PATCH attuale accetta solo `wbsId` (`server/migrations/sqlite/001_init.sql:11–24`, `server/http.mjs:992–1008`, `server/repository.mjs:276–285`). | Una collocazione primaria e un asset facoltativo per `task_id`. | Mostrare il contesto archiviato, anche a task chiusa. Backfill con mappa approvata di `area`, conservando il testo. Nessuna deduzione di asset dal titolo. |
| Difetti | Nessun registro difetti dedicato individuato. Le deviazioni sono una proiezione con `plc_area` e propri collegamenti (`server/migrations/sqlite/011_deviations.sql:1–23`, `server/http.mjs:867–904`). | `defect_id` con luogo obbligatorio e asset facoltativo quando esisterà il modulo. Eventuale collegamento separato a `deviation_id`. | Conservare luogo e asset archiviati sulla scheda. Nessuna conversione automatica delle deviazioni in difetti. Se si integrano le deviazioni, risolvere `plc_area` con la mappa della fonte in una relazione locale separata. |
| Foto e allegati | Immagini e PDF associati a `entity_type/entity_id`. Il sito è ricavato dal proprietario, con verifica del ruolo e del modulo (`server/repository.mjs:680–681`, `server/repository.mjs:693–728`, `server/migrations/pg/038_identity_evidence.sql:15`). | `attachment_id` con collocazione e asset facoltativi, mantenendo il proprietario e i controlli di accesso. | L’archiviazione del contesto non cancella il file. Per gli allegati esistenti si può navigare dal proprietario collocato, indicando la provenienza del contesto. Nessuna copia, analisi EXIF o assegnazione massiva della posizione. |
| Ispezioni | L’ispezione HSE ha `asset_id` obbligatorio verso `hse_assets`. La creazione verifica sito e stato del bene HSE (`server/migrations/pg/030_hse_inspections.sql:1–16`, `server/hse-inspections.mjs:60–65`, `server/hse-inspections.mjs:105–131`). | `inspection_id` con luogo del controllo e asset installato facoltativi. Resta il riferimento obbligatorio al bene HSE per il flusso esistente. | Conservare il contesto del controllo anche dopo dismissione. Collegare lo storico solo con riscontro esplicito della corrispondenza e della posizione alla data del controllo. |
| Documenti | Il percorso esistente gestisce PDF come allegati (`server/repository.mjs:712–728`, `server/http.mjs:906–928`). Nessun registro documentale versionato individuato. | `document_version_id` collegabile a più luoghi o asset. La versione identifica l’allegato con i suoi metadati. | La versione e i riferimenti restano consultabili. Classificare i PDF esistenti solo su conferma. Una versione già consegnata richiede tutela dalla cancellazione dell’allegato. |
| Handover | Il diario ha campi testuali e chiave di giornata/turno. Nessun fascicolo di consegna dedicato individuato (`server/migrations/sqlite/001_init.sql:37–48`, `server/seed-demo.mjs:584–598` per i soli esempi sintetici nelle note). | `handover_revision_id` con perimetro di luoghi, elenco asset, versioni dei documenti e riferimenti alle evidenze. Al rilascio, congelare elenco e percorso di ciascun elemento. | Le revisioni emesse restano leggibili con riferimenti archiviati. Nessun backfill da diario, descrizioni o nomi dei file. La prima revisione nasce da selezione esplicita. |

## 5. Migrazione e rollback

1. Fare un inventario in sola lettura per sito dei distinti di `tasks.area`, conteggi, null, stringhe vuote e varianti. Dove si approva un’estensione alle deviazioni, inventariare separatamente per sito e fonte: l’import proietta già `plc_area` come `area_code` (`server/planning-import.mjs:84–90`, `server/planning-import.mjs:115–124`). Conservare il valore disponibile a database esattamente com’è, con riferimento al record. Distinguere il dato persistito dal valore originario di un eventuale file sorgente.
2. Proporre candidati con normalizzazione conservativa per il confronto: Unicode NFC, spazi esterni rimossi, sequenze di spazi ridotte e confronto senza distinzione di maiuscole dove appropriato. Conservare punteggiatura, zeri iniziali e accenti. Applicare ai codici esterni solo la regola concordata per la fonte. La chiave di ricerca serve a raggruppare candidati e non assegna un’identità.
3. Far approvare al responsabile del sito la gerarchia e la mappa per sito e fonte, con regole versionate e deroghe per record. Una descrizione come «P1», un locale omonimo in più edifici o un valore che indica più zone resta da risolvere. Nessuno split automatico su separatori. Se manca il dettaglio, è lecito mappare al livello confermato. Null e vuoti restano senza luogo. Se un input riutilizzato cambia significato, non riapplicare la regola senza verificarne validità e contesto.
4. Aggiungere modello e collegamenti compatibili in entrambe le basi dati tramite una futura coppia di migrazioni. Mantenere API e colonna `area` compatibili con i client esistenti. Attivare per sito dopo anteprima di candidati, confermati e irrisolti. Applicare a lotti idempotenti con registro di fonte, valore, regola, decisione, attore e UUID risultanti. Non sovrascrivere collocazioni inserite a mano o valori cambiati dopo l’anteprima. Misurare record e valori preservati, copertura, irrisolti e conflitti.
5. Rollback operativo: disattivare nuove scritture e letture del modello per il sito, lasciando attive le viste legacy su `area`. Per annullare un lotto, staccare solo i collegamenti da esso creati ancora identici al risultato registrato. Isolare i conflitti e conservare nodi, asset, movimenti e riferimenti prodotti dopo l’attivazione. Verificare i conteggi prima di riattivare. Evitare rollback distruttivo dello schema durante la convivenza dei client.

Il loader registra le versioni eseguite in `schema_migrations` (`server/migrations/index.mjs:69–79`). Il numero della futura migrazione va scelto dal ramo di implementazione. La base qui osservata contiene già migrazioni fino alla 055 in entrambi i dialetti (`server/migrations/sqlite/055_demo_seed_environment.sql:1`, `server/migrations/pg/055_demo_seed_environment.sql:1`). Lo stato di un ambiente PostgreSQL si verifica con il massimo di `app.schema_migrations.version` in quell’ambiente.

## 6. API e interfaccia

Contratti proposti. Il prefisso è `/api/sites/:siteId` e `:id` è un UUID del sito indicato. Le operazioni con effetto sullo storico sono transazionali. Usare una revisione per rifiutare scritture su dati superati e chiavi di idempotenza per creazioni o eventi ritentabili.

| Metodo | Percorso relativo | Scopo |
| --- | --- | --- |
| GET, POST | `/places` | Leggere albero, cercare per nome/codice, filtrare per padre e stato. Creare un nodo. |
| GET, PATCH | `/places/:id` | Leggere scheda e percorso. Rinominare e gestire alias. |
| POST | `/places/:id/moves`, `/places/:id/archive` | Spostare sottoalbero o archiviare con motivo e controlli. |
| GET, POST | `/assets` | Cercare per tag, seriale, stato e sottoalbero. Registrare un asset. |
| GET, PATCH | `/assets/:id` | Leggere la scheda e modificare i metadati, inclusa la garanzia. |
| GET, POST | `/assets/:id/positions` | Leggere lo storico o registrare un trasferimento. |
| POST | `/assets/:id/transitions` | Installare, sostituire con successore o dismettere, con data e motivo. |
| GET | `/places/:id/history`, `/assets/:id/history` | Consultare le modifiche tracciate a luogo o asset. |
| GET, PUT, DELETE | `/tasks/:id/location`, `/attachments/:id/location`, `/hse-inspections/:id/location` | Leggere, impostare e scollegare luogo e asset nel perimetro del record. Tracciare lo scollegamento. Per le attività, estendere anche la creazione esistente con riferimenti opzionali. |
| GET, POST | `/place-mappings` | Consultare candidati e irrisolti. Approvare una versione della mappa. |
| POST | `/place-backfills`, `/place-backfills/:id/rollback` | Anteprima o applicazione di un lotto approvato. Annullamento controllato del lotto. |
| GET, POST, PATCH | `/defects` per elenco/creazione, `/defects/:id` per dettaglio/modifica | Contratto futuro del modulo difetti, con luogo e asset nella scheda. |
| GET, POST | `/documents`, `/documents/:id/versions` | Contratto futuro per registro e versioni. |
| GET, PUT | `/documents/:id/versions/:versionId/links` | Leggere o aggiornare il set di legami di una versione, con nuova versione quando già consegnata. |
| GET, POST | `/handovers`, `/handovers/:id/revisions` | Contratto futuro per fascicoli e revisioni. |
| POST | `/handovers/:id/revisions/:revisionId/issue` | Emettere e congelare una revisione. |

Schermate minime:

- **Selettore luogo** con ricerca per nome e codice, percorso completo per gli omonimi, scelta dell’asset facoltativa e valore legacy visibile quando manca la mappa. Usabile da tastiera e da mobile.
- **Albero luoghi** con espansione, breadcrumb, filtri per tipo e stato, azioni secondo ruolo e riepilogo delle dipendenze prima di spostamento o archiviazione. Includere una vista di riconciliazione con anteprima del lotto.
- **Scheda asset** con tag, seriale, posizione, stato, garanzia, documenti e storico delle posizioni. Mostrare riferimenti ai record dei moduli accessibili.
- Etichette e messaggi in italiano e inglese. Nel primo rilascio gestire online anagrafiche e riconciliazione. La coda delle attività esiste già (`app/app.mjs:378–384`, `app/offline.mjs:166–194`). Il replay legacy con il solo `area` resta valido. Per eventuali ID accodati, rivalidare sito e stato al replay e mostrare il conflitto senza perdere il contenuto della richiesta.

## 7. Permessi e ambienti demo

Oggi i ruoli di sito passano da `accessible_site_members`. I ruoli di modifica generali includono `owner`, `editor` e `demo_user`, mentre quelli di verifica includono `owner`, `verifier` e `demo_user` (`server/repository.mjs:90–101`). La vista esclude `demo_user` dagli account ordinari e limita gli account sandbox a siti sandbox con ruolo diverso da owner (`server/migrations/sqlite/051_demo_user.sql:44–48`). L’approvazione signup in modalità sandbox assegna `demo_user` sui siti marcati sandbox (`server/signup.mjs:62–70`).

| Ruolo | Regola proposta |
| --- | --- |
| Owner | Crea, rinomina, sposta e archivia luoghi, gestisce alias, approva e annulla backfill. Esegue tutte le operazioni sugli asset del sito. |
| Editor | Crea asset, aggiorna dati, installa, registra trasferimenti, sostituzioni e dismissioni. Collega record nei moduli per cui dispone del diritto di scrittura. |
| Verifier e viewer | Consultano le anagrafiche del sito e i riferimenti visibili. Le operazioni di verifica continuano a seguire le regole del rispettivo modulo. |
| Demo user | Simula operazioni di luogo e asset su dati sintetici, solo con account e sito sandbox consentiti. Niente interventi amministrativi sul backfill condiviso. |

Controllare ruolo, appartenenza al sito e permessi del modulo dal server a ogni richiesta. La scheda trasversale filtra anche risultati di ricerca, conteggi e download. Conservare audit di mutazioni, collegamenti e azioni del backfill. Valutare con l’owner su quali siti sandbox condivisi attivare le operazioni di spostamento e archiviazione. La demo usa cataloghi e file sintetici in conformità alle indicazioni esistenti (`README.md:66–68`).

## 8. Criteri di accettazione e test negativi

| Prova | Esito verificabile |
| --- | --- |
| Rinomina e spostamento | Gli UUID e i collegamenti restano invariati. I filtri usano il nuovo percorso. Il fascicolo già emesso e le evidenze storiche mostrano il percorso registrato. |
| Ciclo | Spostare un luogo sotto sé stesso o un proprio discendente restituisce `409`. Anche due spostamenti concorrenti incompatibili non possono lasciare un ciclo. |
| Padri o asset cross-site | Un padre, un luogo o un asset di un altro sito produce `422` per un conflitto tra riferimenti visibili, oppure `404` quando il riferimento non è accessibile. Nessuna mutazione parziale. |
| Cancellazione con riferimenti | La rimozione fisica di un luogo o asset referenziato viene respinta. Archiviare un luogo occupato da un asset attivo o con figli attivi restituisce `409`. Con soli riferimenti storici l’archiviazione conserva la consultazione e il nodo sparisce dai selettori. |
| Codice duplicato | Due alias canonici identici nello stesso sito e namespace producono `409`, anche con richieste concorrenti. Lo stesso valore in namespace diversi è ammesso. Due asset attivi con stesso tag nel sito producono `409`. |
| Ciclo di vita asset | Installazione priva di luogo e intervallo, garanzia con date invertite o transizione invalida vengono respinti. Un trasferimento lascia un solo intervallo aperto. La sostituzione preserva documenti e seriale del predecessore. |
| Migrazione e rollback | Null, vuoti e varianti restano recuperabili. Gli omonimi ambigui restano irrisolti. Ripetere il lotto genera zero duplicati. L’annullamento preserva le modifiche manuali posteriori e i record creati durante l’adozione. |
| Compatibilità | Un client preesistente crea e mostra l’attività con `area`. Un replay ripetuto con la stessa chiave non duplica l’attività. I controlli HSE e l’accesso agli allegati continuano a funzionare con i riferimenti originari. |
| Permessi | Un viewer non può effettuare mutazioni. Un demo user non può scrivere su siti ordinari. Un utente privo di accesso al modulo d’origine non ottiene file, risultati o conteggi per vie indirette. |

Eseguire i casi di vincolo e concorrenza sia su SQLite sia su PostgreSQL. Serializzare per sito le mutazioni dell’albero nella stessa transazione che verifica eventuali cicli. Proteggere anche movimenti, archiviazioni e revisioni emesse dalle scritture concorrenti. SQLite attiva già il controllo delle chiavi esterne (`server/db.mjs:16`).

## 9. Rischi, fuori scope e decisioni dell’owner

| Rischio | Controllo previsto |
| --- | --- |
| Mappa errata o codici riutilizzati | Anteprima, conferma e provenienza per ogni collegamento. Conservazione del valore originale. |
| Confusione fra posizione attuale e posizione del fatto | Intervalli espliciti, percorso storico e perimetro congelato alla consegna. |
| Esposizione di dati da viste trasversali | Controlli per sito e modulo anche su conteggi, documenti e allegati. |
| Crescita dell’albero e ambiguità fra dialetti | Indici per sito, padre e riferimenti, controlli nell’API e vincoli equivalenti nei due database. |
| Confusione fra bene HSE, posizione funzionale e asset installato | Identificatori distinti e corrispondenze esplicite con storico. |

Fuori scope per il primo rilascio: BIM/GIS e geometrie, sincronizzazione o modifica dei sistemi sorgente, pianificazione manutentiva e ricambi, firma digitale, automazione delle scadenze di garanzia, trasferimenti fra siti e classificazione automatica delle foto.

Decisioni da approvare con l’owner:

1. Confermare livelli omissibili, un’unica posizione primaria e copertura di aree esterne, opere lineari e lavorazioni su più zone.
2. Stabilire autorità dei codici, regole per namespace e maiuscole, politica di riciclo tag e categorie con seriale obbligatorio.
3. Nominare chi approva la mappa per sito e definire la soglia operativa degli irrisolti per l’attivazione.
4. Stabilire se rilasciare per primi albero, registro, attività e allegati, e quando finanziare difetti, documenti e handover. Decidere il perimetro delle integrazioni con deviazioni e HSE.
5. Approvare permessi di editor e demo user, profondità dell’audit, conservazione dei fascicoli e vincoli contrattuali sulla garanzia.
