# Identificazione QR, stampa etichette e inventario fisico

Proposta per SiteAssistant, verificata su `origin/main` al commit `0e44e3c`. Il comportamento futuro descritto qui richiede implementazione e approvazione. Le osservazioni sullo stato attuale riportano i riferimenti al checkout. Card di riferimento: `d46007b1`.

Questa specifica nasce da un'esigenza operativa maturata con InsiteLMS: in cantiere e in magazzino l'etichetta fisica è il modo con cui un oggetto viene ritrovato, non un accessorio grafico. La specifica **non** autorizza implementazione e **non** anticipa gli incrementi Luoghi e Asset 2a (`54409604`) e 2b (`4d0094c6`), che restano prioritari e invariati.

Le decisioni di prodotto sono state approvate dall'owner il 27/11/2026 e sono recepite integralmente nel testo; quanto resta aperto è elencato in §14.

## 1. Problema e casi d'uso

Oggi un asset installato si ritrova cercando per tag, un'attrezzatura per nome o codice, un articolo di una fornitura scorrendo righe d'ordine. Funziona finché si è davanti a uno schermo. Sul posto l'oggetto è davanti e lo schermo no: la ricerca manuale introduce errori di battitura, omonimie e, nelle verifiche, contestazioni difficili da chiudere.

Gli esempi seguenti sono scenari illustrativi, senza dati o record di SiteAssistant.

| Contesto | Operazione e risultato atteso |
| --- | --- |
| Collaudo | Il tecnico inquadra l'etichetta del quadro elettrico e arriva alla scheda dell'asset, con posizione, garanzia e storico. Non digita nulla. |
| Consegna materiali | All'arrivo del bancale il caposquadra inquadra l'etichetta del collo e vede a quale ordine appartiene e cosa è già stato ricevuto. |
| Attrezzatura | Il preposto prende in carico un trapano a percussione: la scansione apre l'attrezzatura e propone la registrazione d'uso, non un modulo generico. |
| Verifica HSE | L'ispettore inquadra l'asset e arriva alla scheda, dove la storia delle verifiche HSE è un capitolo dell'asset, non un registro parallelo. |
| Inventario | A fine cantiere si percorrono le aree inquadando etichette in sequenza. Il sistema segnala ciò che non è stato visto, ciò che è stato visto due volte e ciò che si trova in un'area diversa da quella attesa. |
| Handover | Il fascicolo di consegna cita gli asset per identificativo stabile, non per nome: rinominare un locale o un articolo non rompe i riferimenti. |

## 2. Stato verificato del prodotto

Nessuna parte di questa funzionalità esiste oggi. Le fondamenta utili però sono in `main`.

| Elemento | Stato verificato | Riferimento |
| --- | --- | --- |
| Asset installati | Tabella `assets` con `id` UUID, `site_id`, `tag`, stato `planned/installed/replaced/decommissioned`, seriale, garanzia. Tag univoco nel sito **solo fra i record non archiviati**. | `server/migrations/sqlite/057_places_assets.sql` |
| Posizioni | `asset_positions` con intervalli semiaperti, un solo intervallo aperto per asset, `recorded_path` congelato. | `057_places_assets.sql` |
| Luoghi | `places` con UUID, `site_id`, padre, tipo `building/floor/zone/room`, archiviazione logica. **Nessun alias**: né tabella né colonna. | `057_places_assets.sql`; `server/places.mjs:84-102` |
| Attrezzature | Tabella `tools` con `id` UUID, `name`, `code`, `company`, stato, **`location` come testo libero**. | `server/migrations/sqlite/018_tools.sql` |
| Beni HSE | `hse_assets` con `kind` `tool/site_work/ppe`, `code`, e `tool_id` facoltativo verso `tools`. | `server/migrations/sqlite/029_hse_assets.sql` |
| Materiali | **Nessuna anagrafica.** Solo `material_no` come testo su `purchase_order_items` e `package_items`. | `032_purchase_orders.sql`, `033_packages.sql` |
| Spedizioni | `shipments`, `shipment_packages`, `shipment_receipts` con quantità ricevute per riga d'ordine. | `034_shipments.sql` |
| API esposte | `GET/POST /api/places` e `GET/POST /api/assets`. Le rotte di dettaglio, `moves`, `positions` e `transitions` mancano: sono oggetto di 2a e 2b. | `server/http.mjs:541-550` |
| Allegati | `attachmentTables` copre `task`, `diary`, `site`, `hse_event`, `hse_inspection`, `deviation`. **Non** copre `asset` né `place`. | `server/repository.mjs:680-681` |
| Moduli di accesso | `MODULES` in `server/module-access.mjs:4-7`. Non esiste un modulo per identificazione, luoghi o asset: oggi l'accesso passa dal solo ruolo di sito. | `server/module-access.mjs` |
| Dipendenze runtime | Solo `pg` e `@simplewebauthn/server`. Nessuna libreria QR, barcode, PDF o stampa. | `package.json` |
| Coda offline | Tipi `create_task`, `transition_task`, `create_diary`, `create_attachment`. Nessuna operazione di inventario. | `app/offline.mjs:6` |
| Idempotenza | Header `Idempotency-Key` già ammesso dal gateway HTTP. | `server/http.mjs:238` |

Conseguenza diretta: la funzionalità QR si può progettare e, per asset e attrezzature, implementare appena 2a e 2b sono in `main`. L'identificazione dei **materiali** dipende invece dal modulo Site Materials & Inventory, specificato separatamente in `docs/site-materials-inventory.md`.

## 3. Identità degli oggetti

### 3.1 Regola dell'identità unica

Un singolo oggetto fisico ha **una** identità permanente e **un solo** identificativo QR canonico. Due registri possono descrivere lo stesso oggetto, ma non possono possederne due identità.

| Dominio | Registro autorevole | Ruolo degli altri registri | Identità QR |
| --- | --- | --- | --- |
| Attrezzature e utensili | **`tools` (018)** | `hse_assets` gestisce verifiche, idoneità e informazioni di sicurezza, senza duplicare l'identità; il collegamento esiste già come `hse_assets.tool_id` | Sull'UUID di `tools` |
| Asset installati | **`assets` (057)** | Se un asset è soggetto a verifiche HSE, il bene HSE referenzia l'asset e ne gestisce i controlli, senza nuova identità | Sull'UUID di `assets` |
| Articoli e materiali | **`stock_items` / istanze** del modulo Site Materials & Inventory (non ancora esistente) | `purchase_order_items` e `package_items` restano righe documentali, non anagrafiche | Sull'UUID dell'articolo o dell'istanza |
| Beni HSE senza controparte | **`hse_assets`** | — | Sull'UUID di `hse_assets` |

Conseguenze operative:

- L'etichetta si applica al registro autorevole. Se lo stesso trapano compare in `tools` e in `hse_assets`, l'unica etichetta porta l'UUID di `tools`; la scheda HSE si raggiunge dalla scheda dell'attrezzatura, non da una seconda etichetta.
- L'estensione del principio agli asset installati richiede che `hse_assets` possa riferire un `asset_id`, simmetricamente a quanto già avviene con `tool_id`. È una modifica di schema, quindi un incremento dedicato, non un effetto collaterale di questa specifica.
- Finché quella modifica non esiste, un asset con verifiche HSE non può che essere registrato come bene HSE separato: il rischio di doppia etichetta è reale e va gestito con una regola operativa esplicita (l'owner indica quale dei due è autoritativo per il cantiere in corso), non ignorato.

### 3.2 Meccanismo condiviso, nessuna anagrafica universale

Ciò che si condivide è **solo il livello di identificazione**: un payload, una risoluzione, un comportamento di scansione. Non si introduce un registro centrale delle etichette né una tabella universale di oggetti.

- Il livello di identificazione non crea record in nessuna anagrafica e non duplica nome, descrizione o ubicazione: il QR punta a un record che vive nel modulo proprietario.
- Il tipo di entità è tipizzato (`asset`, `tool`, `hse_asset`, in futuro `stock_item`, `material_instance`). Chiavi e controlli seguono l'impostazione già proposta per i collegamenti di modulo in `docs/places-and-assets.md` §4: `site_id` più UUID, con vincoli che includono il sito.
- Aggiungere un tipo di entità è un'estensione dell'elenco, non la creazione di un'anagrafica.

## 4. Identificatore permanente

### 4.1 Payload canonico

Il payload è un URN versionato, leggibile e autosufficiente:

```
urn:siteassistant:entity:1:<uuid>
```

| Requisito dell'owner | Come è soddisfatto |
| --- | --- |
| Identificativo permanente e versionato | Il numero di versione sta nel payload: una futura versione 2 resta distinguibile senza registro centrale né migrazione delle etichette già stampate. |
| Indipendente dal tag | Il payload non contiene il tag, che è univoco solo fra i record attivi e quindi riciclabile dopo la dismissione. |
| Indipendente dalla posizione | Nessun percorso, nessun `place_id`, nessun testo di ubicazione. Lo spostamento non invalida l'etichetta. |
| Indipendente dal dominio di hosting | Nessun URL. La stessa etichetta funziona su demo Railway, su istanza `asassi.cloud` e in locale. |
| Nessun dato sensibile | Solo un identificatore opaco: nessun nome, seriale, dato personale, token, firma o URL firmata con scadenza. |

### 4.2 L'etichetta non è una chiave

Un identificativo è enumerabile: chi fotografa un'etichetta conosce l'UUID. Non è un segreto e non deve essere trattato come autorizzazione. La risoluzione verifica a ogni richiesta: autenticazione, appartenenza al sito, ruolo e permesso del modulo proprietario. Un QR letto da chi non ha accesso produce `404`, non un messaggio che rivela l'esistenza del record.

### 4.3 Codice leggibile e digitabile

Il QR può essere illeggibile: graffiato, sbiadito, stampato male. Serve un fallback digitabile che **non** soffra del riciclo dei tag.

| Opzione | Come funziona | Valutazione |
| --- | --- | --- |
| Codice canonico derivato (raccomandato) | L'UUID codificato in base32 Crockford, 26 caratteri, stampato in gruppi di quattro (`A7K2-9FQD-…`). Reversibile, nessuno spazio di nomi nuovo, nessuna tabella, nessun riciclo possibile | Onesto e senza debito, ma lungo da digitare in cantiere |
| Codice corto per entità (rinviato) | Colonna dedicata sull'entità con contatore per sito, 6-8 caratteri, mai riassegnato | Più ergonomico, richiede una migrazione per ogni anagrafica e una politica di esaurimento |
| Codice = tag (escluso) | Il tag esistente | **Escluso dall'owner**: il tag si ricicla e l'etichetta diventerebbe falsa |

Si parte dal codice derivato. Se la prova sul campo mostra che 26 caratteri sono inutilizzabili, si valuta il codice corto come incremento separato, con la sua politica di non riassegnazione. In entrambi i casi il fallback è risolto **dentro il sito selezionato** e non è mai un'autorizzazione.

### 4.4 Etichette con URL diretto — opzione futura

Approvata come opzione futura, **non** nel primo rilascio. Un'etichetta con URL (`https://<dominio>/e/<uuid>`) è più comoda da inquadrare con la fotocamera di sistema, ma lega l'oggetto fisico a un dominio: cambiando hosting o passando dalla demo alla produzione, le etichette stampate smettono di funzionare. È ammissibile solo per deployment con dominio stabile e dichiarato, e va emessa come variante esplicita, mai come formato predefinito. Il payload canonico resta quello dell'§4.1.

### 4.5 Risoluzione e casi limite

- **Non trovato**: payload valido ma record inesistente, archiviato o cancellato. L'interfaccia mostra "identificativo non riconosciuto" e non riassegna mai l'UUID.
- **Sito diverso**: risposta `404`, come per un record inaccessibile. Nessuna rivelazione di esistenza o di nome.
- **Payload malformato**: versione sconosciuta o UUID non valido. `422` con messaggio neutro, nessuna interpretazione creativa.
- **Mai riuso**: un UUID non viene riassegnato a un nuovo oggetto. Un'etichetta vecchia può diventare inerte, non può diventare falsa.
- **Senza registro**: il payload è derivabile dall'UUID, quindi un registro delle etichette sarebbe un doppione. Si registra invece l'**evento di stampa** (§5.6), che serve davvero.

## 5. Etichette e stampa

### 5.1 Tre formati

| Formato | Contenuto | Uso | Dipendenza |
| --- | --- | --- | --- |
| **Compatto** | QR e identificativo leggibile | Oggetti piccoli, etichette durevoli, inventario | Nessuna |
| **Descrittivo** | QR, tag, denominazione, modello, seriale e altri dati configurabili | Quadri, attrezzature, colli, fascicoli | Nessuna |
| **Logistico** | Articolo, quantità, lotto, collo, destinazione | Ricevimento, movimentazione, inventario di magazzino | **Subordinato** al modulo Site Materials & Inventory |

Regole comuni:

- I campi del formato descrittivo sono configurabili per sito e per tipo di entità; il set predefinito è QR, tag, denominazione, modello, seriale.
- Le informazioni variabili — posizione, fornitore, ubicazione corrente — sono **facoltative** e, quando incluse, accompagnate dalla **data di stampa** e dalla dicitura che i dati sono quelli di quella data.
- Il formato compatto non contiene nulla che possa diventare falso: solo l'identificativo, che per costruzione non cambia.
- Il formato logistico non può esistere prima dell'anagrafica articoli: senza articolo e lotto non ci sarebbe nulla da stampare che non sia già sulla riga d'ordine, e stamparla sarebbe fuorviante.

### 5.2 Stampa: singola, massiva, ristampa, anteprima

- **Singola**: dalla scheda dell'entità.
- **Massiva**: da una selezione esplicita (risultati di ricerca, sottoalbero di luoghi, righe di un ordine). Mai "tutto il sito" senza conferma con conteggio.
- **Anteprima** obbligatoria per la stampa massiva: quante etichette, quali formati, quali entità prive di un codice digitabile.
- **Ristampa**: rieseguibile dalla cronologia delle stampe, con motivo facoltativo. Ripetere una stampa non duplica record.
- **Dimensioni personalizzabili**: larghezza, altezza, margini, passo della griglia e modulo del QR, con profili salvati per sito.

### 5.3 Fogli A4

Impaginazione a griglia su A4 con margini e passo configurabili, per adattarsi a fogli di etichette adesive commerciali. Composizione lato server (SVG embeddato in HTML) e stampa dal browser con CSS `@page`: nessuna libreria PDF.

Accorgimenti obbligatori: disattivare l'adattamento automatico della stampante, offrire un foglio di calibrazione con righelli per allineare il passo, non fidarsi delle dimensioni nominali del foglio adesivo.

### 5.4 Stampanti termiche

Approvato l'uso iniziale dei **driver di stampa di sistema**: il browser stampa su una pagina di dimensioni fisiche fisse dichiarate con `@page size` (per esempio 50×25 mm). Nessun invio di comandi raw.

Il **comando diretto ESC/POS resta fuori scope**: richiederebbe un percorso di rete o un agente locale, con implicazioni di sicurezza e supporto non giustificate oggi.

La compatibilità va verificata su almeno due modelli reali: il modulo minimo del QR leggibile in stampa termica a bassa risoluzione è un limite fisico, non software. Sotto una certa dimensione l'etichetta si stampa ma non si legge.

### 5.5 Generazione: `qrcode` (soldair), SVG prioritario

| Voce | Stato |
| --- | --- |
| Candidato | **`qrcode`**, repository `soldair/node-qrcode` |
| Versione dichiarata dal repository | 1.5.4 |
| Licenza | MIT |
| Dipendenze dirette dichiarate | `dijkstrajs`, `pngjs`, `yargs` |
| Pacchetto omonimo da escludere | **`node-qrcode`** (npm): ultima pubblicazione 2015, versione `0.0.4`, dipendenze `debug ^2.2.0`, `get-port ^2.1.0`, `decompress ~3.0.0`, `node-browser`. Non è la libreria intesa e non va usato. |
| Formato di generazione | **SVG prioritario**, PNG come alternativo |
| Approvazione definitiva | **Subordinata** alla verifica in fase di implementazione di sicurezza, manutenzione, licenze transitive e compatibilità |

L'adozione avviene **solo lato server**: il client riceve SVG già pronto, nessun codice di codifica nel browser, un solo punto da verificare. Il PNG resta disponibile per usi dove l'SVG non è gestito.

La verifica di implementazione deve produrre, prima del merge: versione fissata, hash di integrità, albero delle dipendenze transitive con licenze, data dell'ultima pubblicazione, numero di manutentori, vulnerabilità note. Se una di queste voci è insoddisfacente, si cambia candidato invece di accettare il rischio in silenzio.

### 5.6 Tracciamento delle stampe

Tabella di eventi di stampa con `site_id`, tipo e id dell'entità, versione del payload, formato, dimensioni, quantità, autore, istante e identificativo del lotto. Serve per ristampe e per ricostruire la provenienza di un'etichetta trovata in cantiere.

Durabilità fisica (materiale, laminazione, resistenza agli agenti) è una scelta di approvvigionamento: va documentata come raccomandazione, non implementata.

## 6. Scansione mobile e azioni contestuali

### 6.1 Acquisizione: nativa più decoder di riserva

| Percorso | Ruolo | Vincolo |
| --- | --- | --- |
| `BarcodeDetector` nativo | Prima scelta, nessun byte aggiunto al progetto | Richiede contesto sicuro (HTTPS); supporto variabile per browser e piattaforma |
| Decoder alternativo caricato **su richiesta** | Garanzia di compatibilità dove l'API nativa non c'è | Dipendenza separata, scaricata solo quando serve e solo se l'utente accetta |
| Digitazione del codice | Fallback universale | Il codice dell'§4.3 |

Regola esplicita: la **Barcode Detection API nativa non è l'unico sistema di scansione**. Non è accettabile che la funzionalità dipenda da un'API la cui disponibilità non controlliamo.

Criterio di accettazione della **prima release**, non rinviabile: scansione reale verificata su **Safari/iPhone** e **Chrome/Android**, su dispositivo fisico, con etichetta stampata e non con un'immagine sintetica a schermo. Se il percorso nativo non copre una delle due piattaforme, il decoder di riserva deve essere già integrato.

Altri vincoli: la fotocamera si apre solo su azione esplicita, con messaggio chiaro su cosa viene inquadrato; il codice letto è risolto dal server e il client non interpreta il payload per dedurre l'entità.

### 6.2 Apertura diretta della scheda

La scansione porta alla scheda dell'entità nel modulo proprietario, con breadcrumb di provenienza ("aperto da scansione") e ritorno alla sessione di inventario se esiste. Un payload che punta a un'entità di un modulo non concesso produce un rifiuto esplicito, non una schermata vuota.

### 6.3 Azioni contestuali

Le azioni dipendono dal tipo di entità e dai permessi, e sono sempre eseguite dal modulo proprietario: l'identificazione non introduce scritture proprie sulle anagrafiche.

| Entità | Azioni contestuali | Chi |
| --- | --- | --- |
| Asset installato | Apri scheda, registra trasferimento, transizione di stato, allega documento, aggiungi a sessione di inventario | Ruoli del modulo secondo `places-and-assets.md` §7 |
| Attrezzatura | Apri scheda, registra uso o manutenzione, **apri la scheda HSE collegata** | Ruoli del modulo `tools` |
| Bene HSE | Apri scheda, avvia ispezione dal template | Ruoli HSE |
| Riga d'ordine o collo | Apri ordine o spedizione, registra ricezione | Ruoli `logistics` |
| Entità sconosciuta | Segnala come sconosciuta nella sessione, richiedi associazione | Ruoli della sessione di inventario |

Nessuna azione distruttiva dalla scansione. La dismissione resta un'operazione con motivo e conferma nella scheda.

## 7. Sessioni di inventario

### 7.1 Modello

Una sessione è un lavoro delimitato nel tempo e nello spazio, con perimetro dichiarato: un sottoalbero di luoghi, un magazzino, o l'intero sito. Ha un responsabile, uno stato (aperta, chiusa) e un risultato conservato.

| Tabella | Contenuto |
| --- | --- |
| `inventory_sessions` | `id`, `site_id`, perimetro, stato, apertura e chiusura, autore, note |
| `inventory_scans` | `id`, `session_id`, `site_id`, tipo e id dell'entità (nullo se sconosciuta), payload grezzo, `scanned_at`, autore, luogo atteso come fotografia, esito, `client_scan_id` per idempotenza, nota |
| `inventory_resolutions` | decisioni di riconciliazione: scansione o insieme di scansioni, esito applicato, autore, istante, motivazione |

L'esito di ogni scansione è uno fra: **corrispondente**, **duplicato**, **ubicazione discordante**, **sconosciuto**, **non atteso**.

### 7.2 Scansioni consecutive

La schermata resta aperta e acquisisce in sequenza, senza conferma per ogni lettura: un tocco, un oggetto, un esito immediato visivo e sonoro breve. Il conteggio è sempre visibile.

Ogni scansione porta un `client_scan_id` generato dal dispositivo. Il server è idempotente su quella chiave: un doppio invio di rete non produce due righe.

### 7.3 Duplicati

Comportamento distinto per dominio, perché "due volte lo stesso oggetto" significa cose diverse:

- Asset e attrezzature: la seconda lettura è un **duplicato** da segnalare, non un incremento di quantità. Serve a scoprire etichette doppie o oggetti spostati.
- Materiali e articoli: la lettura ripetuta può essere legittima e incrementare una quantità, se il dominio lo prevede.

La regola è per tipo di entità, esplicita e verificabile, non configurabile a runtime nella prima release.

### 7.4 Articoli sconosciuti

Un payload non risolto non crea automaticamente nulla. Diventa una riga "sconosciuta" con il payload grezzo, e resta tale finché un utente autorizzato non decide: associarla a un'entità esistente, oppure avviare la creazione nel modulo proprietario con il flusso normale. La sessione chiusa conserva le righe irrisolte come parte del risultato.

### 7.5 Ubicazioni discordanti

Se l'oggetto risulta in un luogo diverso dal perimetro o dal luogo atteso, la sessione registra la **discordanza**. Non corregge la posizione: la posizione fisica di un asset cambia solo con un movimento esplicito, con motivo e intervallo, come stabilito in `places-and-assets.md` §3.

Una scansione registra una rilevazione. Non modifica automaticamente né una quantità contabile né una posizione ufficiale. La riconciliazione propone il movimento come azione separata, autorizzata e tracciata, soggetta all'**approvazione dei movimenti** (§8).

### 7.6 Riconciliazione, chiusura e immutabilità

La riconciliazione produce: visti, non visti, duplicati, discordanti, sconosciuti, con i rispettivi conteggi. La chiusura congela il risultato e richiede una decisione esplicita sugli irrisolti (accettati come tali, o rinviati).

La sessione chiusa è **immutabile**: non si modifica né si cancella. Una rettifica è un atto tracciato separato, che cita la sessione originale e ne conserva il contenuto. Il risultato originale resta sempre leggibile.

### 7.7 Diario probatorio

Una sessione **conclusa** può alimentare il diario con un **riepilogo tracciabile**: perimetro, conteggi, esito, irrisolti, autore, riferimento alla sessione. Il diario riceve un evento, non un flusso.

- **Nessuna voce di diario per singola scansione.** Il diario è un registro di fatti significativi, non un log tecnico.
- Il riepilogo cita la sessione per identificativo, così che il fatto resti verificabile anche a distanza di tempo.
- Un riepilogo già inserito non si riscrive: una rettifica è una nuova voce che cita la precedente.

## 8. Permessi, autorizzazioni distinte e isolamento

### 8.1 Consultazione e stampa

Si usano i **permessi dei moduli esistenti**, senza introdurre un modulo nuovo per l'identificazione:

| Operazione | Autorizzazione |
| --- | --- |
| Risolvere un identificativo, aprire la scheda | Accesso al modulo proprietario, secondo le regole già in vigore |
| Stampare etichette | Stesso diritto della consultazione: chi può vedere l'entità può stamparne l'etichetta |
| Stampare in massa | Consultazione del modulo **più** ruolo di modifica o owner, per evitare ristampe massive involontarie |

Dove un modulo non esiste — oggi per luoghi e asset l'accesso passa dal solo ruolo di sito — vale la regola vigente, e la lacuna è annotata come tale, non mascherata da un permesso che non c'è.

**La scansione non conferisce autorizzazioni aggiuntive.** Leggere un'etichetta non aggiunge diritti: apre ciò che l'utente poteva già aprire e nulla di più.

### 8.2 Quattro autorizzazioni distinte per l'inventario

| Autorizzazione | Cosa consente | Ruoli |
| --- | --- | --- |
| Apertura e chiusura sessione | Dichiarare perimetro, aprire, chiudere, decidere sugli irrisolti | Owner; editor se assegnato responsabile |
| Registrazione rilevazioni | Scansionare e registrare, anche offline | Owner, editor, verifier abilitato |
| Riconciliazione delle discrepanze | Proporre associazioni e classificare gli esiti | Owner, editor |
| Approvazione dei movimenti | Applicare il movimento di posizione proposto | Owner; editor solo se esplicitamente delegato |

Separare queste quattro cose è deliberato: chi conta gli oggetti in magazzino non è necessariamente chi decide che un asset si è spostato, e chi riconcilia non deve poter riscrivere una posizione ufficiale da solo.

### 8.3 Isolamento tra cantieri

Ogni risoluzione, etichetta e sessione è legata a un `site_id`. Un identificativo di un altro sito è indistinguibile da uno inesistente. Nessun conteggio aggregato cross-site espone l'esistenza di record altrui. Un'etichetta stampata per un sito sandbox non è valida su un sito ordinario anche se l'UUID fosse noto.

| Ruolo | Identificare e stampare | Sessione | Riconciliare | Approvare movimenti |
| --- | --- | --- | --- | --- |
| Owner | Sì, su tutto il sito | Apre, conduce, chiude | Sì, incluse associazioni di sconosciuti | Sì |
| Editor | Sì, per i moduli in cui scrive | Conduce una sessione assegnata | Sì | Solo se delegato |
| Verifier | Sì in lettura secondo i moduli | Registra rilevazioni se abilitato | No | No |
| Viewer | Solo apertura scheda | No | No | No |
| Demo user | Solo su siti sandbox, dati sintetici | Su dati sintetici | No | No |

## 9. Offline — seconda fase approvata

Prima release **online**. La seconda fase è approvata nella progettazione, con questi vincoli non negoziabili.

| Capacità | Fase | Regola |
| --- | --- | --- |
| Elenco atteso in sessione | Fase 2 | Cache circoscritta ai **cantieri autorizzati** dell'utente, non all'archivio |
| Registrazione rilevazioni offline | Fase 2 | Coda dedicata con `client_scan_id`, deduplica deterministica, riordino al ritorno in rete |
| Cache dell'indice identificativi | Fase 2, con decisione esplicita | **Minimizzazione**: solo codice e tipo, nessun dato personale, nessun documento; **scadenza** breve e rinnovabile; **invalidazione** immediata al cambio di permessi, alla rimozione dal sito e al logout |
| Riconciliazione offline | **Mai** | Richiede la vista completa e una decisione di responsabilità: resta server-side |
| Creazione di anagrafiche offline | **Mai** | Le anagrafiche si validano sul server; un oggetto nuovo nasce online |

Le rilevazioni raccolte offline sono **sottoposte a verifica dei permessi e a riconciliazione al momento della sincronizzazione**. Una coda non è una scorciatoia: se al ritorno in rete l'utente non ha più il permesso, la rilevazione viene respinta e conservata come rifiutata, non applicata.

## 10. Dipendenze dai moduli esistenti

| Modulo | Cosa fornisce | Dipendenza | Rischio se cambia |
| --- | --- | --- | --- |
| Luoghi e Asset 2a | Rotte di luogo, spostamento, archivio, storico | **Bloccante** per il perimetro della sessione e il luogo atteso | Basso sull'identificativo: nessuna etichetta dipende dal percorso |
| Luoghi e Asset 2b | Ricerca per tag, scheda asset, posizioni, transizioni | **Bloccante** per la destinazione della scansione e per i movimenti | Basso sull'identificativo, alto sull'esperienza |
| Attrezzature (`tools`) | Anagrafica autorevole, stato, `location` testuale | Necessaria | `location` testuale non è un luogo: non usarla come ubicazione attendibile |
| Beni HSE (`hse_assets`) | Verifiche, idoneità, sicurezza; `tool_id` verso `tools` | Necessaria; serve un `asset_id` simmetrico per gli asset installati | Doppia etichetta sullo stesso oggetto fisico |
| Ordini, colli, spedizioni (032–034) | Riga d'ordine, collo, ricezione | Parziale: identifica la riga, non l'oggetto fisico | Presentare una riga d'ordine come "materiale" sarebbe fuorviante |
| **Site Materials & Inventory** | Anagrafica articoli, lotti, ubicazioni, movimenti | **Bloccante** per articoli di magazzino e formato logistico | Senza di esso, nessuna etichetta di articolo |
| Allegati | Documenti per entità | **Dipendenza dei flussi documentali**, non dell'identificazione | Oggi `asset` e `place` non sono coperti; la scheda può identificare ma non allegare |
| Audit (`audit_events`) | Traccia delle mutazioni, con `place`, `asset`, `tool` già ammessi | Necessaria per stampa e riconciliazione | — |
| Accesso per modulo | `MODULES`, moduli strict | Si ereditano i permessi esistenti | Un modulo nuovo non serve; le lacune vanno dichiarate |

Sugli allegati la decisione è esplicita: l'estensione a Luoghi e Asset è **dipendenza dei rispettivi sviluppi documentali**, non prerequisito della semplice identificazione QR. Un'etichetta che apre una scheda senza allegati è utile; una scheda con allegati è più utile, ma non è la stessa cosa e non va confusa.

## 11. Verifica di non preclusione architetturale

| Scelta attuale | Effetto sull'identificazione | Giudizio |
| --- | --- | --- |
| UUID immutabili per asset e luoghi (057) | È esattamente il supporto richiesto: indipendenza da posizione e nome | **Già conforme** |
| Tag univoco solo fra record non archiviati | Impedisce di usare il tag come identità | **Già conforme**, a condizione di scegliere l'UUID |
| Posizioni a intervalli semiaperti, un solo intervallo aperto | Distingue "dove dovrebbe essere" da "dove è stato visto" senza ambiguità | **Già conforme** |
| `recorded_path` congelato | L'etichetta descrittiva mostra il percorso storico corretto | **Già conforme** |
| `hse_assets.tool_id` | Il principio dell'identità unica è già realizzato per le attrezzature | **Già conforme** |
| Nessun `asset_id` in `hse_assets` | Il principio non è ancora esteso agli asset installati | **Lacuna nota**, incremento dedicato |
| `material_no` testuale su righe d'ordine | Nessuna identità di articolo | **Lacuna**, richiede Site Materials & Inventory |
| Allegati non estesi ad asset e luogo | La scheda non può allegare manuali e verbali | **Da colmare nei flussi documentali**, non bloccante |
| Nessuna dipendenza oltre `pg` e WebAuthn | L'encoder QR è la prima dipendenza non infrastrutturale | **Decisione approvata**, verifica in implementazione |
| Coda offline limitata a quattro tipi | L'inventario offline richiede un tipo nuovo | **Estendibile**, meccanismo già parametrico |

Conclusione: **nessuna scelta attuale preclude la funzionalità**, e non serve modificare 2a o 2b per prepararla. Le due cose che sarebbe costoso correggere dopo sono evitate per costruzione: il QR contiene l'UUID e non il tag; l'inventario non scrive mai la posizione di un asset.

## 12. API proposte

Prefisso `/api/sites/:siteId`. Operazioni con effetto storico transazionali; creazioni ritentabili con `Idempotency-Key`.

| Metodo | Percorso | Scopo |
| --- | --- | --- |
| GET | `/identifiers/:payload` | Risolvere un payload in tipo e id di entità, con i permessi del chiamante. `404` se non accessibile o inesistente. |
| GET | `/identifiers/code/:code` | Risolvere il codice digitabile dell'§4.3 nel perimetro del sito |
| GET | `/labels?entityType=&ids=&format=&width=&height=` | Restituire le etichette in SVG (PNG su richiesta) |
| POST | `/label-batches` | Registrare un lotto di stampa e restituire il documento (singolo, A4 multiplo) |
| GET | `/label-batches` | Cronologia delle stampe, per la ristampa |
| GET | `/label-profiles` `POST` `PATCH` | Profili di formato e dimensioni per sito |
| GET | `/inventory-sessions` | Elenco con stato e conteggi |
| POST | `/inventory-sessions` | Aprire una sessione con perimetro dichiarato |
| GET | `/inventory-sessions/:id` | Dettaglio con attesi, visti, discordanze, irrisolti |
| POST | `/inventory-sessions/:id/scans` | Registrare una scansione, idempotente su `client_scan_id` |
| POST | `/inventory-sessions/:id/resolutions` | Registrare una decisione di riconciliazione |
| POST | `/inventory-sessions/:id/close` | Chiudere congelando il risultato |
| POST | `/inventory-sessions/:id/amendments` | Rettifica tracciata di una sessione chiusa |

Nessuna rotta di scrittura sulle anagrafiche: le azioni contestuali usano le rotte dei moduli proprietari.

## 13. Criteri di accettazione e test negativi

| Prova | Esito verificabile |
| --- | --- |
| Indipendenza dalla posizione | Spostare un asset non cambia il payload risolto dall'etichetta già stampata. |
| Indipendenza dal nome | Rinominare non cambia la risoluzione; l'etichetta descrittiva vecchia resta leggibile come dato alla data di stampa. |
| Indipendenza dal dominio | Lo stesso payload si risolve su due ambienti distinti. Nessun URL nel payload canonico. |
| Nessun dato sensibile | Il payload contiene solo schema URN e UUID: nessun nome, seriale, token, data o URL firmata. Un payload manomesso che finge dati aggiuntivi è respinto. |
| Non riciclo | Dismettere un asset e riusarne il tag non rende l'etichetta vecchia risolvibile al nuovo asset. |
| Codice digitabile | Il codice dell'§4.3 risolve l'entità corretta ed è stabile dopo rinomina, trasferimento e riuso del tag. |
| Cross-site | Un identificativo di un altro sito restituisce `404` senza rivelare nome o esistenza; nessun conteggio lo espone. |
| Identità unica | Un bene presente in `tools` e `hse_assets` produce una sola etichetta autoritativa; un tentativo di stamparne due è segnalato. |
| Stampa | Selezionare cento entità produce cento etichette e nessun record in più; la ristampa non duplica; l'anteprima riporta i conteggi corretti. |
| Dimensioni | Un profilo 50×25 mm produce un SVG con quelle dimensioni fisiche e un QR sopra il modulo minimo leggibile. |
| Permessi di stampa | Un viewer non può avviare una stampa massiva; un utente senza accesso al modulo non ottiene etichette e, se invoca la rotta, è respinto. |
| Scansione reale | **Safari/iPhone e Chrome/Android su dispositivo fisico** leggono un'etichetta stampata e aprono la scheda corretta. Con l'API nativa assente, il decoder di riserva funziona. |
| Duplicati in sessione | Due scansioni dello stesso asset producono un duplicato segnalato, non una quantità 2. |
| Sconosciuto | Un payload non risolto non crea entità; resta irrisolto e la sessione può chiudersi conservandolo. |
| Ubicazione discordante | Una scansione fuori perimetro non modifica `asset_positions`; senza approvazione del movimento la posizione resta invariata. |
| Quattro permessi | Chi registra rilevazioni ma non ha l'approvazione dei movimenti non riesce ad applicare un movimento, né direttamente né tramite la riconciliazione. |
| Idempotenza | Lo stesso `client_scan_id` inviato due volte produce una sola riga. |
| Sessione chiusa | Modificare una sessione chiusa è respinto; la rettifica produce un atto separato e l'originale resta leggibile. |
| Diario | Una sessione chiusa genera **una** voce di riepilogo, non una per scansione; la voce cita la sessione. |
| Offline (fase 2) | Con rete assente l'interfaccia non finge di aver registrato una scansione non in coda; al ritorno in rete un utente senza permesso vede la rilevazione respinta, non applicata; la cache scade e si invalida al logout. |

I casi di vincolo e concorrenza vanno eseguiti su SQLite e PostgreSQL.

## 14. Rischi, fuori scope e decisioni ancora aperte

| Rischio | Controllo previsto |
| --- | --- |
| Etichetta illeggibile dopo mesi | QR sopra il modulo minimo verificato su stampa reale; prova su supporto invecchiato |
| Etichetta obsoleta ma non inerte | Risoluzione che distingue inesistente, archiviato e cancellato; nessun riuso di UUID |
| Doppia identità sullo stesso oggetto | Registro autorevole per dominio; `asset_id` in `hse_assets` come incremento dedicato |
| Inventario percepito come correzione automatica | La riconciliazione propone; il movimento richiede approvazione |
| Dipendenza QR non presidiata | Versione fissata, hash, licenze transitive verificate, debito dichiarato |
| Dati di sito copiati sul dispositivo | Cache minimizzata, con scadenza e invalidazione, solo cantieri autorizzati |

Fuori scope: barcode lineari oltre al QR, RFID, stampa ESC/POS diretta, etichette con URL nel primo rilascio, gestione giacenze e valorizzazione (che appartiene a Site Materials & Inventory), app native, firma digitale delle etichette.

Decisioni **chiuse** dall'owner il 27/11/2026: identità unica con Attrezzature autorevole; tre formati di etichetta; stampa con driver di sistema; permessi dei moduli esistenti con quattro autorizzazioni distinte per l'inventario; `qrcode` (soldair) come candidato con verifica in implementazione; SVG prioritario; codice digitabile non basato sul tag; URL come opzione futura; scansione reale su entrambe le piattaforme come criterio di prima release; offline in seconda fase con cache circoscritta; diario alimentato solo da sessioni chiuse; allegati come dipendenza documentale e non dell'identificazione.

Decisioni **ancora aperte**:

1. Se e quando introdurre `asset_id` in `hse_assets` per estendere l'identità unica agli asset installati soggetti a verifiche.
2. Se il codice digitabile derivato (26 caratteri) sia accettabile sul campo, o se serva il codice corto per entità.
3. Quale registro è autoritativo, per un cantiere già avviato, quando lo stesso oggetto è registrato sia in `tools` sia in `hse_assets` in assenza di collegamento.
4. Se le sessioni di inventario debbano essere visibili anche a chi non ha accesso alla logistica.

## 15. Sequenza consigliata

| Fase | Contenuto | Prerequisiti |
| --- | --- | --- |
| Q0 | Prerequisiti: 2a e 2b merged; decisione su `asset_id` HSE; verifica della dipendenza QR | 2a, 2b |
| Q1 | Identificatore, codice digitabile, risoluzione, etichette compatta e descrittiva, stampa singola, massiva, ristampa, anteprima, profili di dimensione, A4 | Q0; migrazione per gli eventi di stampa |
| Q2 | Scansione mobile con decoder di riserva, apertura scheda, azioni contestuali, prova su iPhone e Android | Q1 |
| Q3 | Sessioni di inventario, duplicati, sconosciuti, discordanze, riconciliazione, quattro autorizzazioni, riepilogo nel diario | Q2; coppia di migrazioni |
| Q4 | Acquisizione offline con cache circoscritta, scadenza, invalidazione, verifica permessi alla sincronizzazione | Q3 |
| Q5 | Etichetta logistica e articoli | **Site Materials & Inventory** implementato |
| Q6 | Etichette con URL per domini stabili | Q1; decisione sull'elenco dei domini ammessi |

Nessuna fase richiede modifiche agli incrementi 2a e 2b.
