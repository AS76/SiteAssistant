# Identificazione QR, stampa etichette e inventario fisico

Proposta per SiteAssistant, verificata su `origin/main` al commit `0e44e3c`. Il comportamento futuro descritto qui richiede implementazione e approvazione. Le osservazioni sullo stato attuale riportano i riferimenti al checkout. Card di riferimento: *QR Identification & Inventory* nel Workboard interno.

Questa specifica nasce da un'esigenza operativa maturata con InsiteLMS: in cantiere e in magazzino l'etichetta fisica è il modo con cui un oggetto viene ritrovato, non un accessorio grafico. La specifica **non** autorizza implementazione e **non** anticipa gli incrementi Luoghi e Asset 2a e 2b, che restano prioritari e invariati.

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
- L'estensione del principio agli asset installati richiede che `hse_assets` possa riferire un `asset_id`, simmetricamente a quanto già avviene con `tool_id`. È una modifica di schema, quindi un **incremento dedicato approvato dall'owner il 27/11/2026**, non un effetto collaterale di questa specifica.
- Finché quella modifica non esiste, un asset con verifiche HSE non può che essere registrato come bene HSE separato: il rischio di doppia etichetta è reale e va gestito con una regola operativa esplicita (l'owner indica quale dei due è autoritativo per il cantiere in corso), non ignorato.

### 3.2 Meccanismo condiviso, nessuna anagrafica universale

Ciò che si condivide è **solo il livello di identificazione**: un payload, una risoluzione, un comportamento di scansione. Non si introduce un registro centrale delle etichette né una tabella universale di oggetti.

- Il livello di identificazione non crea record in nessuna anagrafica e non duplica nome, descrizione o ubicazione: il QR punta a un record che vive nel modulo proprietario.
- Il tipo di entità è tipizzato (`asset`, `tool`, `hse_asset`, in futuro `stock_item`, `material_instance`). Chiavi e controlli seguono l'impostazione già proposta per i collegamenti di modulo in `docs/places-and-assets.md` §4: `site_id` più UUID, con vincoli che includono il sito.
- Aggiungere un tipo di entità è un'estensione dell'elenco, non la creazione di un'anagrafica.

### 3.3 Riconciliazione dei beni HSE non collegati

`tools` resta il registro autorevole delle attrezzature. Restano però record in `hse_assets` con `tool_id` nullo, creati prima che il collegamento esistesse o da flussi diversi. **Decisione dell'owner (27/11/2026): riconciliazione esplicita con verifica dell'identità fisica, nessuna associazione dedotta da nome o descrizione.**

| Passo | Regola |
| --- | --- |
| 1. Candidati | Il sistema propone possibili corrispondenze per somiglianza di nome, codice o categoria, **come suggerimento da verificare**, mai come decisione |
| 2. Verifica fisica | Chi riconcilia conferma l'identità dell'oggetto: targhetta, seriale, posizione, riscontro visivo. La somiglianza del nome non è una prova |
| 3. Collegamento | Si valorizza `hse_assets.tool_id` verso l'attrezzatura, con autore, istante e motivazione |
| 4. Nessuna fusione | Non si fondono i due record né si cancellano: il bene HSE conserva la sua storia di verifiche, l'attrezzatura la sua identità |
| 5. Etichetta | Prima della riconciliazione un bene HSE non collegato può avere una propria etichetta; dopo la riconciliazione resta **una sola etichetta autoritativa** e la seconda viene ritirata, non riassegnata |
| 6. Rifiuto esplicito | Se la verifica fisica non conferma la corrispondenza, la proposta si chiude come respinta e resta tracciata |

Un'associazione automatica basata su nomi o descrizioni è esclusa: due trapani identici dello stesso modello sono due oggetti, e solo la targa o il seriale lo dicono.

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
| Indipendente dal dominio di hosting | Nessun URL. La stessa etichetta funziona sulla demo Railway, su un'istanza self-hosted e in locale. |
| Nessun dato sensibile | Solo un identificatore opaco: nessun nome, seriale, dato personale, token, firma o URL firmata con scadenza. |

L'UUID identifica l'**oggetto fisico**, non il registro che lo descrive in quel momento. Un'istanza di materiale e il bene installato in cui si trasforma condividono lo stesso identificativo fisico: si veda §4.6. È questa scelta, e non un dettaglio implementativo, a permettere che un'etichetta stampata al ricevimento resti valida dopo l'installazione.

### 4.2 L'etichetta non è una chiave

Un identificativo è enumerabile: chi fotografa un'etichetta conosce l'UUID. Non è un segreto e non deve essere trattato come autorizzazione. La risoluzione verifica a ogni richiesta: autenticazione, appartenenza al sito, ruolo e permesso del modulo proprietario. Un QR letto da chi non ha accesso produce `404`, non un messaggio che rivela l'esistenza del record.

### 4.3 Codice breve digitabile

Il QR può essere illeggibile: graffiato, sbiadito, stampato male. Serve un fallback digitabile che **non** soffra del riciclo dei tag.

**Decisione dell'owner (27/11/2026):** un codice di 26 caratteri derivato dall'UUID non è sufficientemente ergonomico. L'UUID resta l'identificatore canonico **dentro** il QR; sotto il QR si stampa un **codice breve permanente**, con carattere di controllo e nessuna riassegnazione. La lunghezza definitiva è da validare in implementazione.

| Opzione | Come funziona | Giudizio |
| --- | --- | --- |
| **Codice breve per entità (approvato)** | Colonna dedicata sull'entità, generata alla creazione, alfabeto ristretto, carattere di controllo, univoca nel sito, mai riassegnata | Ergonomico in cantiere, richiede una migrazione per ogni anagrafica e una politica di esaurimento |
| Codice derivato dall'UUID (scartato) | base32 Crockford, 26 caratteri | **Scartato dall'owner**: troppo lungo da digitare |
| Codice = tag (escluso) | Il tag esistente | **Escluso**: il tag si ricicla e l'etichetta diventerebbe falsa |

Regole del codice breve:

- **Alfabeto ristretto** senza caratteri ambigui: base32 Crockford esclusi `I`, `L`, `O`, `U`. Il codice si legge e si detta senza confusione fra `0`/`O` e `1`/`I`/`L`.
- **Carattere di controllo** obbligatorio (algoritmo da scegliere in implementazione: Damm o modulo primo). Serve a respingere un refuso **prima** di interrogare il server, e a distinguere "ho sbagliato a digitare" da "non esiste".
- **Lunghezza provvisoria 6 caratteri di dati più 1 di controllo** (7 in totale), stampati in due gruppi (`A7K2-9F` + controllo). Valori superiori solo se la prova sul campo lo richiede. Il numero definitivo è una decisione di implementazione, validata su tastiera mobile reale.
- **Univocità e collisioni**: vincolo univoco `(site_id, entity_type, short_code)`. La generazione tenta un codice casuale e, in caso di collisione, riprova con un limite di tentativi; al superamento il criterio cambia (lunghezza maggiore), mai la riassegnazione. Una collisione è un evento atteso, non un errore da ignorare.
- **Nessuna riassegnazione**: un codice appartiene all'entità per sempre, anche dopo archiviazione o dismissione. Un codice vecchio può diventare inerte, non può diventare falso.
- **Esaurimento**: con 6 caratteri su alfabeto ristretto lo spazio per sito è ampio ma non infinito. Si monitora l'occupazione e si allunga il codice per le entità nuove; le etichette già stampate restano valide perché la lunghezza è riconoscibile dal codice stesso.
- **Risoluzione nel perimetro del sito**: il codice è risolto dentro il sito selezionato, mai globalmente, e non è mai un'autorizzazione.

Il codice breve è un'aggiunta all'identificativo, non un suo sostituto: il QR continua a contenere l'URN con l'UUID dell'§4.1.

### 4.4 Etichette con URL diretto — opzione futura

Approvata come opzione futura, **non** nel primo rilascio. Un'etichetta con URL (`https://<dominio>/e/<uuid>`) è più comoda da inquadrare con la fotocamera di sistema, ma lega l'oggetto fisico a un dominio: cambiando hosting o passando dalla demo alla produzione, le etichette stampate smettono di funzionare. È ammissibile solo per deployment con dominio stabile e dichiarato, e va emessa come variante esplicita, mai come formato predefinito. Il payload canonico resta quello dell'§4.1.

### 4.5 Risoluzione e casi limite

- **Non trovato**: payload valido ma record inesistente, archiviato o cancellato. L'interfaccia mostra "identificativo non riconosciuto" e non riassegna mai l'UUID.
- **Sito diverso**: risposta `404`, come per un record inaccessibile. Nessuna rivelazione di esistenza o di nome.
- **Payload malformato**: versione sconosciuta o UUID non valido. `422` con messaggio neutro, nessuna interpretazione creativa.
- **Mai riuso**: un UUID non viene riassegnato a un nuovo oggetto. Un'etichetta vecchia può diventare inerte, non può diventare falsa.
- **Senza registro**: un registro delle etichette inteso come seconda anagrafica sarebbe un doppione. Si registra invece l'**evento di stampa** (§5.6), che serve davvero, più il codice breve che è un attributo dell'entità e non un registro separato.

### 4.6 Continuità dell'identità fisica fra ricevimento e installazione

Un'istanza serializzata ricevuta in cantiere riceve un'etichetta. Mesi dopo la stessa istanza viene installata e diventa un asset. **L'etichetta non si ristampa e non nascono due identità.**

Come si ottiene:

1. **Un solo identificativo per oggetto fisico, dalla nascita.** L'istanza di materiale (`stock_instances`, si veda `docs/site-materials-inventory.md` §3.2) nasce con un UUID proprio e con il suo codice breve. L'etichetta stampata al ricevimento porta quell'UUID.
2. **L'installazione non crea una nuova identità: collega.** Il passaggio a bene installato produce il record in `assets` con il proprio UUID di asset, e `stock_instances.asset_id` registra il legame. La risoluzione dell'etichetta segue il legame e apre la scheda che è oggi pertinente.
3. **La risoluzione sceglie il registro, non l'identità.** Lo stesso payload può puntare a un'istanza in giacenza o a un asset installato a seconda dello stato: la risposta dichiara il tipo corrente e, quando esiste un legame, anche l'altro registro raggiungibile. Il payload non cambia e non serve alcuna ristampa.
4. **Il codice breve resta quello dell'istanza.** Se l'asset ha un proprio codice breve, entrambi restano validi e sono collegati fra loro; l'interfaccia mostra l'altro identificativo nella scheda, così chi ha in mano l'etichetta vecchia trova comunque la scheda giusta.
5. **Divieto esplicito.** Nessuna risoluzione può dedurre l'identità dal seriale, dal nome o dalla descrizione: il legame istanza→asset è un atto esplicito, tracciato e reversibile solo con un altro atto tracciato.

Conseguenza sulla stampa: chi stampa al ricevimento non deve sapere se l'oggetto sarà installato. L'etichetta è corretta in entrambi i casi, che è esattamente il motivo per cui il payload non contiene un tipo di entità immutabile ma un identificativo risolto dal server.

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
| `inventory_scans` | `id`, `session_id`, `site_id`, tipo e id dell'entità (nullo se sconosciuta), payload grezzo, `scanned_at`, autore, **luogo atteso come fotografia**, **luogo osservato dichiarato**, **contesto di scansione**, esito, `client_scan_id` per idempotenza, nota |
| `inventory_resolutions` | decisioni di riconciliazione: scansione o insieme di scansioni, esito applicato, autore, istante, motivazione |

L'esito di ogni scansione è uno fra: **corrispondente**, **duplicato**, **ubicazione discordante**, **sconosciuto**, **non atteso**. Posizione attesa e osservata sono descritte in §7.5; il contesto di scansione in §7.6.

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

### 7.5 Posizione attesa e posizione osservata

Una rilevazione registra **due** posizioni, non una:

| Campo | Significato | Fonte |
| --- | --- | --- |
| **Posizione attesa** | Dove l'oggetto dovrebbe essere secondo il sistema | Fotografia al momento della scansione, calcolata dal modello (posizione dell'asset, ubicazione della giacenza) e conservata come tale |
| **Posizione osservata** | Dove l'oggetto è stato effettivamente visto | Il contesto di scansione scelto dall'operatore al momento della lettura |

Regole:

- La posizione attesa è una **fotografia**: se in seguito l'asset si sposta, la rilevazione continua a dire dove il sistema lo collocava quel giorno. Senza questo, ogni rilettura storica sarebbe ambigua.
- La posizione osservata è **dichiarata dall'operatore**, non dedotta. Se manca, la rilevazione esiste ma la discordanza non è valutabile, e l'esito lo dice invece di inventare un luogo.
- La discordanza nasce dal **confronto** fra le due. Se l'oggetto risulta in un luogo diverso dal perimetro o dall'atteso, la sessione la registra e non corregge nulla: la posizione ufficiale cambia solo con un movimento esplicito, con motivo e intervallo, come stabilito in `places-and-assets.md` §3.
- Una scansione registra una rilevazione. Non modifica automaticamente né una quantità contabile né una posizione ufficiale. La riconciliazione propone il movimento come azione separata, autorizzata e tracciata, soggetta all'**approvazione dei movimenti** (§8).

### 7.6 Contesto di scansione e identificazione QR dei luoghi

Chi inventaria non inquadra solo oggetti: inquadra **spazi**. Depositi, container e scaffali devono poter essere identificati come un asset o un'attrezzatura.

| Elemento | Comportamento |
| --- | --- |
| Contesto di scansione | L'operatore dichiara dove si trova: un luogo, un container, uno scaffale. Il contesto vale per le rilevazioni **successive** finché non cambia |
| Codice del luogo | Stesso schema di §4: URN con UUID del luogo e codice breve stampabile e appiccabile |
| Scansione di un luogo | **Imposta il contesto** delle rilevazioni successive; non modifica le ubicazioni ufficiali e non crea movimenti |
| Cambio di contesto | Esplicito e visibile: l'interfaccia mostra sempre il contesto corrente, così una rilevazione non finisce nel posto sbagliato per distrazione |
| Fine sessione | Il contesto non sopravvive alla sessione: nessun contesto implicito ereditato da un lavoro precedente |

L'identificazione QR dei luoghi è quindi un'estensione naturale dello stesso meccanismo, non una funzionalità separata: cambia il tipo di entità risolto, non il payload né il comportamento di scansione.

La scansione di un luogo **non** è un trasferimento. Se l'operatore inquadra uno scaffale e poi un asset che non dovrebbe essere lì, il sistema registra una discordanza e propone un movimento: non sposta nulla da solo.

### 7.7 Riconciliazione, chiusura e immutabilità

La riconciliazione produce: visti, non visti, duplicati, discordanti, sconosciuti, con i rispettivi conteggi. La chiusura congela il risultato e richiede una decisione esplicita sugli irrisolti (accettati come tali, o rinviati).

La sessione chiusa è **immutabile**: non si modifica né si cancella. Una rettifica è un atto tracciato separato, che cita la sessione originale e ne conserva il contenuto. Il risultato originale resta sempre leggibile.

### 7.8 Diario probatorio

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

### 8.2 Consultazione delle sessioni senza accesso al modulo intero

**Decisione dell'owner (27/11/2026):** consultare una sessione di inventario non deve richiedere l'accesso all'intero modulo Logistics o al modulo proprietario nella sua interezza.

| Situazione | Comportamento |
| --- | --- |
| Un responsabile di area deve vedere la sessione del suo perimetro | Autorizzazione **circoscritta** al dominio e al cantiere interessati, non al modulo intero |
| L'utente non ha accesso al modulo d'origine di un'entità | Vede la riga della sessione come riferimento, **non** la scheda dell'entità né i suoi dati |
| Riepiloghi e conteggi | Calcolati **solo** su ciò che il chiamante può vedere; nessun totale che riveli l'esistenza di record esclusi |
| Perimetri sovrapposti | Ogni sessione dichiara il proprio perimetro; l'autorizzazione segue il perimetro, non la gerarchia dei moduli |

Il rischio da evitare è l'esposizione indiretta: un conteggio che dice "47 articoli non visti" rivela l'esistenza di materiale che l'utente non può consultare. La regola è quindi che **il riepilogo non è un canale laterale**: se il dettaglio è negato, anche il numero aggregato che lo rivela è negato o viene mostrato in forma non riconducibile.

### 8.3 Quattro autorizzazioni distinte per l'inventario

| Autorizzazione | Cosa consente | Ruoli |
| --- | --- | --- |
| Apertura e chiusura sessione | Dichiarare perimetro, aprire, chiudere, decidere sugli irrisolti | Owner; editor se assegnato responsabile |
| Registrazione rilevazioni | Scansionare e registrare, anche offline | Owner, editor, verifier abilitato |
| Riconciliazione delle discrepanze | Proporre associazioni e classificare gli esiti | Owner, editor |
| Approvazione dei movimenti | Applicare il movimento di posizione proposto | Owner; editor solo se esplicitamente delegato |

Separare queste quattro cose è deliberato: chi conta gli oggetti in magazzino non è necessariamente chi decide che un asset si è spostato, e chi riconcilia non deve poter riscrivere una posizione ufficiale da solo.

### 8.4 Isolamento tra cantieri

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
| Nessun `asset_id` in `hse_assets` | Il principio non è ancora esteso agli asset installati | **Lacuna nota**, incremento dedicato **approvato** il 27/11/2026 |
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
| POST | `/inventory-sessions/:id/scans` | Registrare una scansione con **posizione attesa fotografata**, **posizione osservata** e **contesto di scansione**; idempotente su `client_scan_id` |
| PUT | `/inventory-sessions/:id/context` | Impostare il contesto di scansione corrente (luogo, container, scaffale). Non crea movimenti |
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
| Codice breve | Il codice dell'§4.3 risolve l'entità corretta ed è stabile dopo rinomina, trasferimento e riuso del tag. Un codice con un carattere sbagliato è respinto dal carattere di controllo **prima** dell'interrogazione. |
| Collisione | Due entità non ottengono mai lo stesso codice breve nello stesso sito, anche sotto creazione concorrente; al superamento dei tentativi il codice si allunga, non si riassegna. |
| Codice non riassegnato | Archiviare o dismettere un'entità non libera il suo codice per una nuova entità. |
| Cross-site | Un identificativo di un altro sito restituisce `404` senza rivelare nome o esistenza; nessun conteggio lo espone. |
| Identità unica | Un bene presente in `tools` e `hse_assets` produce una sola etichetta autoritativa; un tentativo di stamparne due è segnalato. |
| Riconciliazione HSE | Un bene HSE con `tool_id` nullo non viene collegato automaticamente: la proposta richiede conferma dell'identità fisica, resta tracciata e, se respinta, non cambia nulla. Dopo il collegamento esiste una sola etichetta autoritativa. |
| Continuità dell'identità fisica | L'etichetta stampata su un'istanza al ricevimento continua a risolvere lo stesso oggetto dopo l'installazione: nessuna ristampa, nessuna seconda identità, e il legame istanza→asset è esplicito e tracciato. |
| Stampa | Selezionare cento entità produce cento etichette e nessun record in più; la ristampa non duplica; l'anteprima riporta i conteggi corretti. |
| Dimensioni | Un profilo 50×25 mm produce un SVG con quelle dimensioni fisiche e un QR sopra il modulo minimo leggibile. |
| Permessi di stampa | Un viewer non può avviare una stampa massiva; un utente senza accesso al modulo non ottiene etichette e, se invoca la rotta, è respinto. |
| Scansione reale | **Safari/iPhone e Chrome/Android su dispositivo fisico** leggono un'etichetta stampata e aprono la scheda corretta. Con l'API nativa assente, il decoder di riserva funziona. |
| Duplicati in sessione | Due scansioni dello stesso asset producono un duplicato segnalato, non una quantità 2. |
| Sconosciuto | Un payload non risolto non crea entità; resta irrisolto e la sessione può chiudersi conservandolo. |
| Ubicazione discordante | Una scansione fuori perimetro non modifica `asset_positions`; senza approvazione del movimento la posizione resta invariata. |
| Posizione attesa e osservata | La rilevazione conserva entrambe; se l'asset si sposta dopo, la posizione attesa registrata non cambia. Una rilevazione senza posizione osservata non produce una discordanza inventata. |
| Contesto di scansione | Inquadrare un luogo imposta il contesto delle rilevazioni successive senza creare movimenti né modificare ubicazioni ufficiali; il contesto non sopravvive alla sessione. |
| Visibilità circoscritta | Un utente senza accesso al modulo d'origine vede la riga della sessione ma non la scheda né i dati dell'entità; i riepiloghi contano solo ciò che può vedere e non rivelano record esclusi. |
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

Decisioni **chiuse** dall'owner il 27/11/2026: identità unica con Attrezzature autorevole; tre formati di etichetta; stampa con driver di sistema; permessi dei moduli esistenti con quattro autorizzazioni distinte per l'inventario; `qrcode` (soldair) come candidato con verifica in implementazione; SVG prioritario; URL come opzione futura; scansione reale su entrambe le piattaforme come criterio di prima release; offline in seconda fase con cache circoscritta; diario alimentato solo da sessioni chiuse; allegati come dipendenza documentale e non dell'identificazione.

Decisioni **chiuse nella revisione del 27/11/2026** (secondo giro):

1. **`asset_id` in `hse_assets` è approvato** come incremento dedicato, per evitare identità duplicate degli asset sottoposti a verifiche HSE (§3.1).
2. **Il codice breve permanente è la scelta**, al posto del codice derivato di 26 caratteri: carattere di controllo, collisioni gestite, nessuna riassegnazione, lunghezza validata in implementazione (§4.3).
3. **`tools` resta il registro autorevole** delle attrezzature; per i beni HSE non collegati serve riconciliazione esplicita con verifica dell'identità fisica, mai associazione dedotta da nome o descrizione (§3.3).
4. **La consultazione delle sessioni non dipende dall'accesso al modulo intero**: autorizzazioni circoscritte al dominio e al cantiere, senza esposizione indiretta tramite riepiloghi e conteggi (§8.2).

Decisioni **ancora aperte**:

1. **Momento dell'incremento `asset_id`**: se prima o dopo la prima release QR, e se richieda un backfill dei beni HSE già registrati.
2. **Lunghezza definitiva del codice breve**: 7 caratteri (6+1) come ipotesi di lavoro, da validare su tastiera mobile reale.
3. **Custodia della verifica fisica**: chi è abilitato a confermare l'identità di un bene HSE non collegato, e con quale prova minima accettabile.
4. **Perimetro delle sessioni visibili**: se un responsabile di area debba vedere tutte le sessioni del proprio cantiere o solo quelle del proprio sottoalbero di luoghi.

## 15. Sequenza consigliata

| Fase | Contenuto | Prerequisiti |
| --- | --- | --- |
| Q0 | Prerequisiti: 2a e 2b merged; verifica della dipendenza QR. L'incremento `asset_id` in `hse_assets` è approvato ma non blocca Q1: entra quando l'owner ne fissa la precedenza | 2a, 2b |
| Q1 | Identificatore, codice digitabile, risoluzione, etichette compatta e descrittiva, stampa singola, massiva, ristampa, anteprima, profili di dimensione, A4 | Q0; migrazione per gli eventi di stampa |
| Q2 | Scansione mobile con decoder di riserva, apertura scheda, azioni contestuali, prova su iPhone e Android | Q1 |
| Q3 | Sessioni di inventario, duplicati, sconosciuti, discordanze, riconciliazione, quattro autorizzazioni, riepilogo nel diario | Q2; coppia di migrazioni |
| Q4 | Acquisizione offline con cache circoscritta, scadenza, invalidazione, verifica permessi alla sincronizzazione | Q3 |
| Q5 | Etichetta logistica e articoli | **Site Materials & Inventory** implementato |
| Q6 | Etichette con URL per domini stabili | Q1; decisione sull'elenco dei domini ammessi |

Nessuna fase richiede modifiche agli incrementi 2a e 2b.
