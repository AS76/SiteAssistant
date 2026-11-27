# Site Materials & Inventory

Proposta per SiteAssistant, verificata su `origin/main` al commit `0e44e3c`. Modulo autonomo approvato dall'owner il 27/11/2026 e inserito in roadmap. **Solo specifica**: nessuna implementazione autorizzata, nessuna dipendenza installata. Card di riferimento: `853a0078`.

Perimetro dichiarato dall'owner: **logistica operativa di cantiere**. SiteAssistant non deve diventare un ERP né un WMS generalista. Questo vincolo non è una premessa retorica: è il criterio con cui, in ogni sezione, si accetta o si rifiuta un requisito.

## 1. Perché un modulo separato

Oggi i materiali esistono solo come testo. `purchase_order_items.material_no` e `package_items.material_no` sono stringhe su documenti di fornitura (`032_purchase_orders.sql`, `033_packages.sql`): descrivono ciò che è stato ordinato e imballato, non un articolo con un'identità.

Le conseguenze pratiche sono tre, e sono quelle che il modulo deve risolvere:

1. **Nessuna giacenza.** Si sa cosa è stato ordinato e cosa è arrivato, non cosa c'è in cantiere adesso.
2. **Nessuna identità.** Lo stesso articolo compare con codici diversi da fornitori diversi, e nulla dice che sono lo stesso oggetto.
3. **Nessun collegamento all'installato.** Un articolo consumato per installare un asset non lascia traccia del legame.

Il modulo colma queste tre lacune e si ferma lì. Tutto ciò che appartiene a contabilità di magazzino, valorizzazione, MRP, pianificazione della domanda o tracciabilità fiscale resta fuori.

## 2. Confine: cosa è dentro e cosa è fuori

| Dentro (logistica di cantiere) | Fuori (ERP/WMS generalista) |
| --- | --- |
| Anagrafica articoli di cantiere con codice interno | Distinte base, cicli di lavorazione, MRP |
| Unità di misura e quantità | Valorizzazione, costi di magazzino, FIFO/LIFO contabile |
| Lotti, colli, pallet | Tracciabilità fiscale e serializzazione legale |
| Ubicazioni di cantiere (area, container, scaffale) | Ottimizzazione percorsi, slotting, automazione |
| Movimenti: entrata, prelievo, consumo, reso, rettifica | Trasferimenti tra stabilimenti, dogana, Intrastat |
| Assegnazione a WBS o attività | Contratti di fornitura, aste, gestione fornitori completa |
| Inventario fisico e riconciliazione | Ciclo passivo completo, pagamenti, riconciliazione fatture |

Un requisito che non serve a sapere **dove sono i materiali e a cosa sono stati destinati** non appartiene a questo modulo.

## 3. Item Master e codici articolo

### 3.1 Entità

| Tabella | Contenuto |
| --- | --- |
| `stock_items` | `id` UUID, `site_id`, `code` (codice interno), `description`, `category`, `base_unit`, `is_serialized`, `manufacturer`, `manufacturer_code`, stato, date di creazione e modifica, `archived_at` |

Regole:

- **`code` è interno e stabile.** È l'identità dell'articolo nel cantiere: non cambia se cambia la descrizione, non si riusa dopo l'archiviazione. Univoco nel sito, anche a fronte di record archiviati.
- **Il codice del fornitore non è l'identità.** `manufacturer_code` e i codici dei fornitori vivono in una tabella di alias (`stock_item_codes`), con `namespace` della fonte — la stessa impostazione già approvata per gli alias dei luoghi in `places-and-assets.md` §2: `site_id + namespace + codice → stock_item_id`. Lo stesso codice in namespace diversi è ammesso; lo stesso codice canonico nello stesso namespace è respinto con `409`.
- **Nessuna descrizione come identità.** Due articoli con la stessa descrizione restano due articoli.
- **Archiviazione logica.** Un articolo con giacenza o movimenti non si cancella: si archivia, e resta consultabile.

### 3.2 Categorie e serializzazione

`is_serialized` distingue due nature che vanno trattate diversamente in tutto il modulo:

| Tipo | Identità | Giacenza | Esempio |
| --- | --- | --- | --- |
| Non serializzato | L'articolo, contato in unità | Quantità aggregata | Viti, guaine, cavo a metro |
| Serializzato | L'**istanza fisica**, con seriale proprio | Una unità per istanza | Quadro, motore, trasponder |

Per gli articoli serializzati serve la tabella delle istanze (`stock_instances`) con `id` UUID, `stock_item_id`, `serial_number`, stato, ubicazione corrente e collegamento all'asset installato quando avviene l'installazione. Il seriale non identifica da solo: l'identità è l'UUID dell'istanza.

Il legame con il modulo QR è diretto: **un'istanza serializzata è un oggetto fisico con un'identità permanente**, quindi riceve un'etichetta propria secondo `docs/qr-identification-inventory.md`.

## 4. Unità di misura e quantità

- Ogni articolo ha un'**unità di base** (`base_unit`) in cui si tiene la giacenza: `pz`, `m`, `m2`, `m3`, `kg`, `lt`, `conf`.
- Le unità alternative di acquisto e di consumo (confenzione, pallet, bobina) si dichiarano con un fattore di conversione verso l'unità di base, conservato per articolo.
- **La quantità si conserva sempre nell'unità di base.** Le conversioni avvengono in lettura, non in scrittura: così una conversione sbagliata non corrompe lo storico.
- Arrotondamenti: si conservano almeno tre decimali, come già fanno `package_items` e `shipment_receipts` (`NUMERIC(12,3)`). Nessun arrotondamento silenzioso in giacenza.
- Quantità negative non ammesse come stato finale della giacenza; un prelievo che le produrrebbe è respinto con `409` e un messaggio che dice quanto è disponibile.

## 5. Lotti, colli e pallet

Tre livelli distinti, spesso confusi e che vanno tenuti separati:

| Livello | Cos'è | Identità | Esistente oggi |
| --- | --- | --- | --- |
| **Lotto** | Insieme di materiale con la stessa provenienza o lo stesso numero di produzione | `stock_lots` con `lot_no` per articolo e sito | No |
| **Collo** | Unità fisica imballata e movimentabile, già modellata | `packages` (033) | **Sì** |
| **Pallet** | Aggregazione di colli per il trasporto | Relazione tra colli e unità di movimentazione | No |

Decisioni di progetto:

- Il **collo non si duplica**: `packages` esiste e resta il riferimento. Il modulo materiali lo estende con il contenuto di articoli reali (`stock_item_id`), invece di introdurre un secondo concetto di collo.
- **Il lotto entra dal primo rilascio della movimentazione** (decisione dell'owner, 27/11/2026). Non è una funzione differita: i movimenti nascono già con il lotto previsto.
- **Obbligatorietà configurata, non universale.** Il lotto è obbligatorio per categoria o per singolo articolo, secondo una configurazione esplicita (`lot_required`). Per gli articoli che lo richiedono — cavi, materiali con data di produzione, componenti soggetti a richiami — un movimento senza lotto è respinto con `422`. Per gli altri il lotto resta facoltativo.
- **Nessun lotto fittizio.** Un articolo non soggetto a lotti non riceve un lotto segnaposto tipo `N/A` o `DEFAULT`: un valore inventato inquina i raggruppamenti e rende impossibile distinguere il tracciato dal non tracciato. Se il lotto manca, il campo è nullo.
- Il **pallet** è un raggruppamento, non un contenitore: identificato da un'etichetta logistica, contiene colli, non li possiede.
- Il formato di etichetta **logistico** di `qr-identification-inventory.md` §5.1 stampa articolo, quantità, lotto, collo e destinazione: dipende quindi da queste entità, non solo dall'anagrafica.

Una conseguenza da mettere in chiaro: con il lotto obbligatorio per categoria, **attivare quella configurazione su un articolo che ha già movimenti senza lotto** è un cambio che va gestito. La configurazione vale per i movimenti successivi; i movimenti storici restano senza lotto e non si riscrivono. L'interfaccia dichiara quanti movimenti esistenti ne sono privi prima di applicare la modifica.

## 6. Collegamenti a ordini, spedizioni e ricevimento

Il modulo **non riscrive** procurement: si innesta su ciò che esiste.

| Collegamento | Da | A | Regola |
| --- | --- | --- | --- |
| Riga d'ordine → articolo | `purchase_order_items.material_no` | `stock_item_id` | Risoluzione esplicita e approvata, mai dedotta dal testo. Restano visibili codice originale, fonte e stato della risoluzione. |
| Collo → articoli | `package_items` | `stock_item_id`, `stock_lot_id`, quantità | Aggiunta di riferimenti; il collo resta la stessa entità |
| Ricezione → movimento | `shipment_receipts` | movimento di entrata | La ricezione registra la quantità ricevuta; il movimento la traduce in giacenza. **Sono due atti, non uno.** |
| Ordine → assegnazione | `purchase_order_items.wbs_id` | WBS o attività | Già esistente; il modulo la eredita e non la reimplementa |

Il punto delicato è l'ultimo della tabella dei movimenti: **la ricezione non è la giacenza**. Oggi `shipment_receipts` dice quanto è arrivato. Se il materiale arriva in cantiere e viene subito portato al piano, la giacenza cambia ancora. Tenere distinti i due atti evita che una ricezione diventi per magia un giacimento.

## 7. Ubicazioni di magazzino

Qui la tentazione di allargare il perimetro è massima, e va respinta.

**Non** si introduce una gerarchia di magazzino separata e completa (corsie, scaffali, contenitori con coordinate). Si usa ciò che esiste: i **luoghi** (`places`, 057) con il tipo che serve.

Decisioni dell'owner (27/11/2026):

- **`storage_area` e `container` sono estensioni ammesse** dei tipi di luogo, previa verifica di due cose in implementazione: la coerenza con la gerarchia esistente (`building/floor/zone/room`) e il caso dei **container mobili**, che possono cambiare sito o essere noleggiati a breve termine. Un container che si sposta è un luogo che si sposta: ammesso solo con regole esplicite, altrimenti diventa un alias del camion.
- **Granularità flessibile, non gerarchia rigida.** Zona, container, scaffale ed eventuale posizione sono livelli utilizzabili **senza obbligo di completezza**: un deposito può fermarsi alla zona, un magazzino organizzato può arrivare allo scaffale. Nessun livello è obbligatorio oltre a quello che identifica il posto.
- La flessibilità non è licenza per un WMS: niente corsie con coordinate, niente mappe di magazzino, niente percorsi ottimizzati. La granularità serve a **ritrovare** la roba, non a pianificarne la movimentazione.

Regole di progetto:

- Un'ubicazione di materiale è un **luogo** del sito — tipicamente una zona o un locale usato come deposito — oppure un **container** dichiarato come luogo di tipo dedicato.
- I tipi nuovi si aggiungono estendendo i `kind` di `places` con una migrazione, non creando una seconda gerarchia.
- La giacenza per ubicazione si ricava dai movimenti, non da un campo "quantità attuale" aggiornato a mano. Un campo del genere è la prima fonte di disallineamento in ogni sistema di magazzino.
- Lo spostamento tra ubicazioni è un movimento, con autore, istante e motivo, esattamente come per gli asset.
- Ogni ubicazione è identificabile con un QR, come ogni altro luogo: si veda `qr-identification-inventory.md` §7.6. Inquadrare uno scaffale imposta il contesto delle rilevazioni, non sposta nulla.

## 8. Movimenti, stati della quantità e custodia

### 8.1 Il problema da evitare

Con un solo tipo di movimento "prelievo" che sottrae, il percorso reale — deposito → squadra → installazione → consumo — produce **due sottrazioni per un solo oggetto**: una al prelievo, una al consumo. La giacenza crolla a metà della realtà e nessuno sa se il materiale è in deposito, in mano alla squadra o già montato.

Decisione dell'owner (27/11/2026): la semantica va distinta. Il prelievo **non è** un consumo, e il consumo non deve sottrarre una seconda volta.

### 8.2 Cinque stati della quantità

La quantità di un articolo non è un numero unico, ma una ripartizione fra stati. Per ogni combinazione di articolo, lotto e ubicazione:

| Stato | Significato | È ancora fisicamente in cantiere |
| --- | --- | --- |
| **`depot`** | Disponibile in deposito, non impegnato | Sì |
| **`custody`** | Uscito dal deposito, in custodia presso una squadra, un'area o un'attività | Sì |
| **`consumed`** | Consumato: installato, incorporato o distrutto nell'uso | **No** |
| **`returned`** | Reso al fornitore o rientrato e chiuso | **No** (se al fornitore) |
| **`assigned`** | Impegnato per una WBS o un'attività, **non ancora** uscito dal deposito | Sì, ma riservato |

Due grandezze derivate, che non sono stati ma letture:

- **Disponibile** = `depot` − `assigned`. È ciò che si può ancora prelevare.
- **Presente fisico** = `depot` + `custody`. È ciò che esiste in cantiere, comunque collocato.

`assigned` è una **prenotazione**, non un movimento fisico: non sposta nulla e non riduce il presente. Serve a rispondere a "quanto posso ancora prelevare senza rubare materiale a un'altra attività".

### 8.3 Tipi di movimento e transizioni

| Tipo | Da | A | Effetto |
| --- | --- | --- | --- |
| `receipt` | — | `depot` | + presente, + deposito |
| `issue` | `depot` | `custody` | **neutro sul presente**, − deposito, + custodia |
| `consume` | `custody` | `consumed` | − presente, − custodia (terminale) |
| `return_to_depot` | `custody` | `depot` | neutro sul presente, − custodia, + deposito |
| `return_to_supplier` | `depot` | `returned` | − presente, − deposito (terminale) |
| `transfer` | ubicazione A | ubicazione B, stesso stato | neutro su tutto tranne la distribuzione |
| `reserve` | — | `assigned` | neutro sul presente, riduce il disponibile |
| `release` | `assigned` | — | neutro sul presente, restituisce disponibilità |
| `adjust` | qualsiasi | qualsiasi | ± con motivazione obbligatoria e autorizzazione dedicata |

Il punto centrale: **`issue` non sottrae dal presente e `consume` non tocca il deposito**. Un oggetto prelevato e poi consumato passa per due stati e viene sottratto **una volta sola**, alla fine.

### 8.4 Invarianti di conservazione

Valgono per ogni articolo, lotto e ubicazione, e devono reggere sotto scritture concorrenti:

1. **Non negatività.** Nessuno stato scende sotto zero. Un'operazione che lo produrrebbe è respinta, non arrotondata a zero.
2. **Conservazione del presente.** Per ogni movimento non terminale (`issue`, `return_to_depot`, `transfer`, `reserve`, `release`), la somma algebrica delle variazioni di presente fisico è **zero**.
3. **Terminalità.** Solo `consume` e `return_to_supplier` riducono il presente, e lo riducono esattamente della quantità mossa. Nessun altro tipo può farlo.
4. **Somma degli stati.** Per ogni combinazione: `depot + custody + consumed + returned` = totale entrato meno totale uscito dal sistema, e la somma delle variazioni dei quattro stati per ogni movimento è zero, salvo i movimenti che attraversano il confine del sistema (`receipt`, `return_to_supplier`).
5. **Custodia limitata al detentore.** La custodia è intestata a un detentore (squadra, area, attività). Non si consuma né si restituisce più di quanto quel detentore ha in custodia.
6. **Disponibile non negativo.** `depot − assigned ≥ 0`. Non si prenota materiale che non c'è.
7. **Un solo consumo per istanza serializzata.** Un'istanza consumata non torna disponibile: la sua quantità è 1 e la transizione è terminale.
8. **Tracciabilità del legame.** Ogni `consume` cita la custodia da cui proviene, oppure l'operazione composta che l'ha creata (§8.5). Non esistono consumi orfani.

Queste invarianti vanno verificate **nello stesso transaction che scrive il movimento**: il controllo di disponibilità e la scrittura non possono essere separati, altrimenti due richieste concorrenti passano entrambe il controllo e una lascia la giacenza negativa.

### 8.5 Consumo diretto dal deposito

Un operatore che prende una scatola di viti e la usa subito non deve compiere due passaggi con due schermate. Ma la scorciatoia non deve rompere il modello.

Regola: il consumo diretto dal deposito è ammesso come **operazione composta atomica**, che scrive in un'unica transazione due movimenti distinti e li lega:

1. `issue` da `depot` a `custody` verso un detentore dichiarato (la squadra o l'attività);
2. `consume` da quella custodia a `consumed`, con riferimento al primo movimento.

La storia risultante è onesta: si vede il passaggio in custodia, chi l'ha avuto e il consumo. La giacenza è sottratta **una volta sola**, perché l'`issue` è neutro sul presente. Se una delle due scritture fallisce, nessuna delle due viene registrata.

Non è ammesso invece un `consume` che salti la custodia senza traccia: sarebbe indistinguibile da una rettifica e nasconderebbe chi ha avuto il materiale.

### 8.6 Prelievo verso squadra o area di installazione

- Il prelievo richiede un **detentore**: una squadra, un'area di installazione o un'attività. Un prelievo "a nessuno" non esiste, perché non sarebbe riconciliabile.
- Il materiale in custodia resta **presente** in cantiere: chi guarda la disponibilità in deposito vede meno, chi guarda il presente fisico vede lo stesso totale. È la lettura corretta in entrambi i casi.
- La custodia **non scade da sola**. Un cantiere che finisce con materiale in custodia a una squadra deve chiudere quella custodia con un consumo o un rientro: non esiste un aggiustamento silenzioso a fine progetto.
- Alla chiusura di un'attività con custodia residua, il sistema **segnala** e chiede una decisione. Non consuma e non restituisce d'ufficio.

### 8.7 Assegnazione (prenotazione)

- Assegnare materiale a una WBS o a un'attività **non è un movimento fisico**: riduce il disponibile e basta.
- L'assegnazione si riferisce a una quantità di `depot`. Se il materiale è già in custodia, l'assegnazione non ha senso: è già impegnato di fatto, e il sistema lo dice invece di accettare un dato contraddittorio.
- Rilasciare un'assegnazione restituisce disponibilità, senza mai toccare il presente.
- Un'assegnazione non impedisce un prelievo da parte di un altro detentore, ma il prelievo consuma disponibilità e quindi può ridurre il materiale riservato. La politica — blocco o avviso — è una decisione aperta (§14).

### 8.8 Casi negativi

| Caso | Esito |
| --- | --- |
| Prelievo superiore al deposito | `409`, con la quantità disponibile nel messaggio |
| Consumo superiore alla custodia del detentore | `409`; chi consuma non può usare materiale in custodia di un altro |
| Prenotazione oltre il disponibile | `409` |
| Rientro in deposito di più di quanto in custodia | `409` |
| Secondo consumo della stessa istanza serializzata | `409`, l'istanza è terminale |
| Consumo senza detentore né operazione composta | `422`, manca la traccia della custodia |
| Trasferimento fra stati incompatibili (per esempio custodia → `consumed` con tipo `transfer`) | `422`, il tipo di movimento non ammette quella transizione |
| Rettifica senza motivazione | `422` |
| Rettifica da utente senza l'autorizzazione dedicata | `403` |
| Chiusura di attività con custodia residua | Segnalazione bloccante che richiede una decisione; nessun automatismo |

### 8.9 Altre regole

- **Append-only.** Un movimento non si modifica e non si cancella. Una correzione è un movimento di segno opposto con motivazione e riferimento all'originale.
- **Idempotenza.** Ogni movimento accetta una chiave di idempotenza: un doppio invio non duplica una giacenza.
- **Consumo legato all'installazione.** Quando un articolo serializzato viene installato, il consumo si collega all'asset creato e l'istanza conserva il proprio identificativo fisico: si veda `qr-identification-inventory.md` §4.6. Per gli articoli non serializzati il legame è per quantità, non per singolo pezzo.
- **Letture sempre derivate.** Disponibilità, presente fisico e ripartizione per stato si calcolano dai movimenti. Nessun campo di quantità aggiornato a mano.

## 9. Collegamento con gli asset installati

Il modulo non crea asset: gli asset vivono in `assets` (057) e quel registro resta autorevole per la loro identità.

| Situazione | Comportamento |
| --- | --- |
| Istanza serializzata installata | L'istanza diventa un asset: si crea il record in `assets`, si collega `stock_instances.asset_id`, si registra il consumo. Un solo oggetto fisico, una sola identità. |
| Materiale di consumo per installare | Movimento di consumo collegato all'asset o all'attività, senza creare un asset |
| Componente sostituito | Nuova istanza collegata al nuovo asset; la vecchia resta nello storico con il suo seriale |
| Articolo non installato | Resta in giacenza: nessun asset finché non viene installato |

Il criterio: **un'istanza fisica diventa un asset solo quando viene installata.** Prima è materiale. Dopo è un asset. L'identità dell'istanza non cambia nel passaggio: cambia il registro che la descrive, e il collegamento lo dice.

## 10. Inventari fisici e riconciliazione

L'inventario fisico è il punto di contatto con `qr-identification-inventory.md` §7: le sessioni, le scansioni, i duplicati, gli sconosciuti e le discordanze sono specificati là. Qui si dichiara solo ciò che riguarda le quantità.

- Una sessione di inventario su materiali confronta **atteso** e **rilevato** per articolo, lotto e ubicazione.
- La differenza genera una **proposta di rettifica**, non una rettifica. L'applicazione è un movimento `adjust`, con motivazione obbligatoria e autorizzazione distinta.
- Chi conta non rettifica da solo: la separazione delle quattro autorizzazioni di `qr-identification-inventory.md` §8.3 vale anche qui, e l'approvazione dei movimenti è il cancello.
- La sessione chiusa è immutabile; la rettifica è un atto tracciato separato.

## 11. Permessi

**Decisione dell'owner (27/11/2026): `materials` è un modulo *strict*, come `logistics`.**

Il modulo entra in `MODULES` (`server/module-access.mjs:4-7`) e va aggiunto all'insieme `strictModules` con la stessa impostazione di `logistics`: nessuno lo vede se non per concessione esplicita. La ragione è che quantità, destinazioni e detentori hanno lo stesso carattere riservato della logistica già strict.

| Autorizzazione | Cosa consente | Ruoli |
| --- | --- | --- |
| Consultazione anagrafica e disponibilità | Vedere articoli, ubicazioni, quantità | Accesso al modulo |
| Movimenti ordinari | Entrata, prelievo, rientro, trasferimento, assegnazione | Owner, editor |
| Consumo | Dichiarare il consumo su un'installazione o un'attività | Owner, editor |
| Rettifiche | Movimento `adjust` | Owner; editor solo se delegato |
| Configurazione articoli e alias | Creare e correggere anagrafiche, approvare risoluzioni da righe d'ordine | Owner, editor |

**Anagrafiche separate per cantiere nella prima release** (decisione dell'owner). Un articolo identico in due cantieri è due record. Un catalogo aziendale condiviso è un'evoluzione futura, non un'ipotesi da preparare oggi con chiavi globali: la condivisione apre problemi di autorizzazione e di proprietà del dato che vanno affrontati quando esisterà un bisogno reale.

Isolamento: ogni articolo, istanza, lotto, detentore e movimento appartiene a un `site_id`. Un identificativo di un altro sito è `404`, indistinguibile da inesistente. I conteggi aggregati non rivelano l'esistenza di record esclusi: la regola di `qr-identification-inventory.md` §8.2 vale anche qui.

## 12. Migrazione e convivenza con l'esistente

1. **Inventario in sola lettura** dei `material_no` distinti per sito, con conteggi e varianti, per capire cosa esiste davvero prima di proporre un'anagrafica.
2. **Nessun backfill automatico.** Le righe d'ordine restano come sono finché una risoluzione esplicita non le collega a un articolo. Un `material_no` non diventa un articolo per deduzione.
3. **Coppia di migrazioni** SQLite e PostgreSQL, numero successivo al 057 dopo il merge. Estensione di `packages` e `package_items` con riferimenti facoltativi; nessuna riscrittura delle colonne esistenti.
4. **Client esistenti intatti**: procurement continua a funzionare senza il modulo materiali. Il modulo aggiunge rotte, non ne cambia.
5. **Rollback operativo**: disattivare il modulo per sito, lasciando procurement intatto; i record creati restano consultabili.

## 13. Criteri di accettazione e test negativi

| Prova | Esito verificabile |
| --- | --- |
| Codice articolo | Due articoli con lo stesso codice nel sito sono respinti `409`, anche con richieste concorrenti; lo stesso codice in siti diversi è ammesso. |
| Riuso del codice | Archiviare un articolo non libera il codice per un nuovo articolo. |
| Alias | Lo stesso codice fornitore in namespace diversi è ammesso; lo stesso codice canonico nello stesso namespace è respinto `409`. |
| Unità | Una quantità inserita in unità alternativa è conservata nell'unità di base con il fattore corretto; nessun arrotondamento perde i decimali. |
| Giacenza negativa | Un prelievo oltre la disponibilità è respinto `409` con la quantità disponibile; nessuno stato scende sotto zero. |
| **Nessuna doppia sottrazione** | Prenotare, prelevare e poi consumare la stessa quantità lascia il presente fisico diminuito **di una sola volta**, della quantità consumata. Il caso è la prova centrale della semantica di §8. |
| **Prelievo neutro** | Un `issue` da deposito a custodia non cambia il presente fisico: diminuisce il deposito, aumenta la custodia, il totale resta identico. |
| **Custodia del detentore** | Il detentore A non può consumare né restituire più di quanto ha in custodia; il tentativo con materiale in custodia di B è respinto `409`. |
| **Consumo composto** | Il consumo diretto dal deposito registra due movimenti legati nella stessa transazione; se il secondo fallisce, il primo non resta scritto. Un `consume` senza custodia né operazione composta è respinto `422`. |
| **Prenotazione** | Assegnare non cambia il presente fisico; `disponibile = depot − assigned` non scende sotto zero; rilasciare restituisce disponibilità senza movimenti fisici. |
| **Custodia residua** | Chiudere un'attività con custodia residua produce una segnalazione bloccante; nessun consumo e nessun rientro vengono registrati d'ufficio. |
| **Concorrenza** | Due prelievi concorrenti che insieme superano il deposito: uno passa, l'altro è respinto `409`; il controllo e la scrittura avvengono nella stessa transazione. |
| Movimento immutabile | Modificare o cancellare un movimento è respinto; la correzione è un movimento opposto con riferimento all'originale. |
| Idempotenza | Lo stesso movimento inviato due volte produce una sola riga e una sola variazione di quantità. |
| Ricezione ≠ giacenza | Registrare una ricezione non aumenta la disponibilità finché non è registrato il movimento di entrata; i due conteggi restano distinguibili. |
| Serializzato | Un'istanza serializzata non può esistere due volte con lo stesso seriale nello stesso sito; il secondo consumo della stessa istanza è respinto `409`. |
| Lotto obbligatorio | Su un articolo con `lot_required`, un movimento senza lotto è respinto `422`; su un articolo senza obbligo il lotto resta nullo, mai un valore segnaposto. |
| Lotto attivato a posteriori | Attivare l'obbligo su un articolo con movimenti storici non riscrive lo storico e dichiara quanti movimenti ne sono privi. |
| Inventario | Una sessione produce una proposta di rettifica, non una rettifica; senza autorizzazione alle rettifiche il movimento `adjust` è respinto. |
| Isolamento | Un articolo o un movimento di un altro sito è `404`; nessun conteggio aggregato lo espone. |
| Convivenza | Procurement funziona senza il modulo; con il modulo attivo le rotte preesistenti si comportano come prima. |

## 14. Rischi, fuori scope e decisioni aperte

| Rischio | Controllo previsto |
| --- | --- |
| Il modulo scivola verso l'ERP | Confine dichiarato in §2; un requisito che non riguarda dove sono i materiali e a cosa servono è fuori |
| Doppia anagrafica con il testo delle righe d'ordine | Risoluzione esplicita, nessun backfill dedotto; testo originale conservato |
| Giacenza che diverge dalla realtà | Giacenza derivata dai movimenti, mai un campo aggiornato a mano; inventario periodico |
| Secondo concetto di collo | `packages` resta l'unico; il modulo lo estende |
| Ubicazioni come gerarchia parallela | Si usano i luoghi; nessuna seconda gerarchia |
| Anagrafica condivisa tra cantieri | Esclusa nella prima release |

Fuori scope: distinte base, cicli, MRP, valorizzazione e costi, FIFO/LIFO contabile, tracciabilità fiscale, trasferimenti tra stabilimenti, dogana, gestione fornitori completa, pagamenti, integrazione con sistemi esterni, app native.

Decisioni **chiuse** dall'owner il 27/11/2026:

1. `materials` è un modulo **strict**, come `logistics` (§11).
2. I **lotti entrano dal primo rilascio della movimentazione**, con obbligatorietà configurata per categoria o articolo e nessun lotto fittizio (§5).
3. **`storage_area` e `container` sono estensioni ammesse** dei tipi di luogo, previa verifica della coerenza gerarchica e del caso dei container mobili (§7).
4. Le **anagrafiche restano separate per cantiere** nella prima release; il catalogo aziendale condiviso è evoluzione futura (§11).
5. **Granularità flessibile** delle ubicazioni — zona, container, scaffale, posizione facoltativa — senza gerarchia rigida e senza WMS (§7).

Decisioni **ancora aperte**:

1. **Container mobili**: se un container noleggiato e spostabile sia un luogo del sito o un oggetto tracciato a sé. Cambia il modello, non solo l'etichetta (§7).
2. **Politica di prenotazione**: se un prelievo che intacca materiale assegnato a un'altra attività debba essere bloccato o solo segnalato (§8.7).
3. **Detentore della custodia**: se possa essere una persona oltre a squadra, area o attività. Una persona è più preciso e più fragile (turnover, ferie, contestazioni).
4. **Chiusura attività con custodia residua**: se la segnalazione debba essere bloccante o solo un avviso persistente (§8.6).
5. **Granularità minima obbligatoria**: se ogni movimento debba dichiarare l'ubicazione fino allo scaffale, o se la zona basti come default.

## 15. Sequenza consigliata

| Fase | Contenuto | Prerequisiti |
| --- | --- | --- |
| M0 | Decisioni dell'§14; inventario in sola lettura dei `material_no` | — |
| M1 | Item Master, codici, alias, unità di misura, **lotti con obbligatorietà configurabile** | M0; nessuna dipendenza da altri moduli |
| M2 | Movimenti con **stati della quantità e custodia** (deposito, custodia, assegnazione, consumo, resi), disponibilità derivate, ubicazioni come luoghi | M1 |
| M3 | Collegamenti a ordini, colli e ricezioni; risoluzione delle righe d'ordine | M2; procurement (032–034) |
| M4 | Istanze serializzate e collegamento agli asset installati | M3; 2b per gli asset |
| M5 | Inventario fisico e riconciliazione delle quantità, con posizione attesa e osservata | M4; sessioni di inventario da QR (Q3) |
| M6 | Etichetta logistica | M4; Q1 delle etichette |

Il modulo non ha dipendenze da 2a e 2b per i primi tre passi, ma non va avviato prima che la priorità operativa concordata lo consenta: gli incrementi 2a e 2b restano davanti.
