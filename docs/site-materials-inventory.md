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
- Il **lotto** è nuovo e facoltativo: si attiva per gli articoli che lo richiedono (cavi, materiali con data di produzione). Un articolo senza lotto non ha un lotto fittizio.
- Il **pallet** è un raggruppamento, non un contenitore: identificato da un'etichetta logistica, contiene colli, non li possiede.
- Il formato di etichetta **logistico** di `qr-identification-inventory.md` §5.1 stampa articolo, quantità, lotto, collo e destinazione: dipende quindi da queste entità, non solo dall'anagrafica.

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

Proposta:

- Un'ubicazione di materiale è un **luogo** del sito — tipicamente una zona o un locale usato come deposito — oppure un **container** dichiarato come luogo di tipo dedicato.
- Se serve un tipo di luogo non previsto oggi (`storage_area`, `container`), si estende l'elenco dei `kind` di `places` con una migrazione, non si crea una seconda gerarchia.
- La giacenza per ubicazione si ricava dai movimenti, non da un campo "quantità attuale" aggiornato a mano. Un campo del genere è la prima fonte di disallineamento in ogni sistema di magazzino.
- Lo spostamento tra ubicazioni è un movimento, con autore, istante e motivo, esattamente come per gli asset.

## 8. Movimenti, assegnazioni, prelievi, consumo

Una sola tabella di movimenti, con tipi espliciti:

| Tipo | Significato | Effetto sulla giacenza |
| --- | --- | --- |
| `receipt` | Entrata da ricezione di spedizione | + |
| `issue` | Prelievo verso un cantiere o un'attività | − |
| `consume` | Consumo dichiarato su un'installazione o un'attività | − |
| `return` | Reso al fornitore o rientro in deposito | + / − secondo il caso |
| `transfer` | Spostamento tra ubicazioni | neutro sul totale, cambia la distribuzione |
| `adjust` | Rettifica da inventario fisico | ± con motivazione obbligatoria |

Regole non negoziabili:

- **Append-only.** Un movimento non si modifica e non si cancella. Una correzione è un movimento di segno opposto con motivazione e riferimento all'originale.
- **Idempotenza.** Ogni movimento accetta una chiave di idempotenza: un doppio invio non duplica una giacenza.
- **Assegnazione ≠ movimento.** Assegnare materiale a una WBS o a un'attività dice a cosa è destinato; il prelievo dice che è uscito dal deposito. Sono due informazioni, e possono avvenire in momenti diversi.
- **Consumo legato all'installazione.** Quando un articolo serializzato viene installato, il consumo si collega all'asset creato. Per gli articoli non serializzati il legame è per quantità, non per singolo pezzo.

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
- Chi conta non rettifica da solo: la separazione delle quattro autorizzazioni di `qr-identification-inventory.md` §8.2 vale anche qui, e l'approvazione dei movimenti è il cancello.
- La sessione chiusa è immutabile; la rettifica è un atto tracciato separato.

## 11. Permessi

Il modulo entra in `MODULES` (`server/module-access.mjs:4-7`) come `materials`, con la stessa impostazione degli altri moduli, e la decisione se sia *strict* — visibile solo su concessione esplicita — va presa con l'owner: la logistica oggi è strict, e i materiali espongono quantità e destinazioni che hanno lo stesso carattere.

| Autorizzazione | Cosa consente | Ruoli |
| --- | --- | --- |
| Consultazione anagrafica e giacenze | Vedere articoli, ubicazioni, quantità | Accesso al modulo |
| Movimenti ordinari | Entrata, prelievo, consumo, trasferimento | Owner, editor |
| Rettifiche | Movimento `adjust` | Owner; editor solo se delegato |
| Configurazione articoli e alias | Creare e correggere anagrafiche, approvare risoluzioni da righe d'ordine | Owner, editor |

Isolamento: ogni articolo, istanza, lotto e movimento appartiene a un `site_id`. Nessuna condivisione di anagrafica tra cantieri nella prima release: un articolo identico in due cantieri sono due record. La condivisione è un'ottimizzazione che apre problemi di autorizzazione, e non serve al perimetro.

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
| Giacenza negativa | Un prelievo oltre la disponibilità è respinto `409` con la quantità disponibile; la giacenza non scende sotto zero. |
| Movimento immutabile | Modificare o cancellare un movimento è respinto; la correzione è un movimento opposto con riferimento all'originale. |
| Idempotenza | Lo stesso movimento inviato due volte produce una sola riga e una sola variazione di giacenza. |
| Ricezione ≠ giacenza | Registrare una ricezione non aumenta la giacenza finché non è registrato il movimento di entrata; i due conteggi restano distinguibili. |
| Serializzato | Un'istanza serializzata non può esistere due volte con lo stesso seriale nello stesso sito; installarla crea un asset e collega l'istanza, senza duplicare l'identità. |
| Lotto | Un articolo senza lotto non produce un lotto fittizio; un articolo con lotto richiede il lotto nei movimenti. |
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

Decisioni aperte con l'owner:

1. Se il modulo `materials` debba essere *strict* come `logistics`.
2. Se servano i lotti fin dal primo rilascio o solo per categorie selezionate.
3. Se i `kind` di `places` vadano estesi con `storage_area` e `container`, o se bastino i tipi esistenti.
4. Se un articolo identico debba poter essere condiviso tra cantieri in una fase successiva.
5. Quale livello di dettaglio delle ubicazioni è sufficiente in cantiere (zona, container, scaffale) senza scivolare nel WMS.

## 15. Sequenza consigliata

| Fase | Contenuto | Prerequisiti |
| --- | --- | --- |
| M0 | Decisioni dell'§14; inventario in sola lettura dei `material_no` | — |
| M1 | Item Master, codici, alias, unità di misura | M0; nessuna dipendenza da altri moduli |
| M2 | Movimenti, giacenze derivate, ubicazioni come luoghi | M1 |
| M3 | Collegamenti a ordini, colli e ricezioni; risoluzione delle righe d'ordine | M2; procurement (032–034) |
| M4 | Lotti, istanze serializzate, collegamento agli asset installati | M3; 2b per gli asset |
| M5 | Inventario fisico e riconciliazione delle quantità | M4; sessioni di inventario da QR (Q3) |
| M6 | Etichetta logistica | M4; Q1 delle etichette |

Il modulo non ha dipendenze da 2a e 2b per i primi tre passi, ma non va avviato prima che la priorità operativa concordata lo consenta: gli incrementi 2a e 2b restano davanti.
