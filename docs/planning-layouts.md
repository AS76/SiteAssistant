# Area Pianificazione, layout e mappe

Stato: specifica funzionale proposta. Import, Gantt, viewer e aggiornamenti descritti qui non sono ancora implementati nella demo.

## Obiettivo e struttura

Un'area di progetto con due sezioni collegate:

1. **Pianificazione e avanzamento:** importare una pianificazione, visualizzarla, registrare il lavoro eseguito e confrontarlo con il piano.
2. **Layout e mappe:** conservare e visualizzare revisioni di documenti grafici, collegando aree, asset, attività e deviazioni a posizioni riconoscibili.

Il cantiere, le aree e gli asset sono condivisi dalle due sezioni. Selezionare un'attività può aprire il relativo layout; selezionare un elemento sulla mappa può mostrare attività, avanzamento e deviazioni collegati.

Il successivo modulo Engineering riutilizza gli stessi documenti e revisioni per collegare distinte e componenti; non crea una seconda copia indipendente dei layout.

Nella modalità complementare, il piano importato e gli stati del sistema sorgente restano snapshot distinti dal piano corrente e dai consuntivi interni. I file possono provenire da riferimenti autorizzati in un archivio S3 compatibile; l'acquisizione non implica copia pubblica o modifica dell'originale. Profili di export reali da validare secondo [Import e archivio documenti](import-storage.md).

## Input e modalità di gestione

| Input | Prima capacità prevista | Estensioni |
| --- | --- | --- |
| Excel XLSX | Anteprima fogli/colonne, mapping, validazione e import versionato | Profili di mapping riutilizzabili, confronto delle revisioni e altri formati di pianificazione |
| CSV | Import tabellare con separatore, codifica e mapping espliciti | Profili di esportazione/importazione |
| Excel XLS e altri formati legacy | Conversione esplicita in XLSX o adattatore da valutare | Compatibilità verificata su campioni, senza presumerla dal nome del file |
| PDF | Conservazione originale, visualizzazione per pagina, zoom e collegamenti/annotazioni separati | Ricerca e livelli quando presenti nel documento |
| Immagini ad alta risoluzione | Conservazione originale, anteprima e zoom | Rendering a tasselli/multirisoluzione per file grandi; formati e limiti da fissare su campioni |
| CAD: DWG/DXF | Conservazione originale, revisione e collegamenti; anteprima PDF o immagine fornita o generata da un convertitore supportato | Visualizzazione CAD con livelli e coordinate, dopo verifica di motore, licenze e compatibilità |

Accettare e conservare un file CAD non equivale a visualizzarlo o modificarlo nativamente nel browser. Nessun editor CAD è previsto nel primo incremento. Le conversioni sono processi separati con stato in coda/in elaborazione/pronto/errore; l'originale non viene sostituito. Servizi esterni di conversione richiedono una scelta esplicita; i file non vengono inoltrati automaticamente a terzi.

## Pianificazione: import guidato

1. Caricare il file e selezionare il foglio, la riga intestazioni e il formato delle date.
2. Mappare i campi: identificativo stabile, descrizione, gerarchia WBS, inizio/fine, dipendenze, area/asset, responsabile/impresa, metodo di misura, quantità e unità se applicabili.
3. Mostrare anteprima e righe da correggere: ID duplicati, date non valide, fine precedente all'inizio, riferimenti mancanti, dipendenze cicliche, quantità/unità incoerenti.
4. Approvare il mapping e creare una revisione importata immutabile con checksum, provenienza, autore e data di riferimento.
5. Scegliere esplicitamente quale revisione è la baseline di confronto. Le correzioni successive agiscono sul piano corrente; una nuova baseline richiede un'azione distinta.

I fogli possono contenere formule, ma il sistema non esegue macro o codice. I valori calcolati non disponibili devono essere segnalati e confermati prima dell'import. Un file incompatibile non produce righe apparentemente valide.

Il nuovo import usa identificativi stabili, non il numero di riga o il titolo, per riconoscere le voci. Mostra aggiunte, modifiche e righe mancanti; non cancella automaticamente item o consuntivi. Un file già importato viene riconosciuto. I campi autorevoli del piano e i campi consuntivi aggiornabili in app hanno regole di scrittura separate.

## Visualizzazioni

| Vista | Uso | Aggiornamenti |
| --- | --- | --- |
| Gantt | Date, durata, gerarchia, dipendenze, milestone; confronto baseline/piano corrente | Aprire la voce e aggiornare avanzamento; le modifiche alle date sono registrate separatamente |
| Tabella WBS | Struttura e dati di tutte le voci, con filtri e raggruppamenti | Aggiornamento puntuale o inserimento guidato di consuntivi; validazione lato server |
| Board / lookahead | Lavoro imminente per area, impresa, responsabile e stato | Coordinamento operativo collegato alle stesse voci |
| Curve e riepiloghi | Piano e consuntivo nel tempo | Disponibili quando esistono misura, pesi e storico sufficienti |

Il Gantt non coincide con l'intero modulo di pianificazione: le viste usano gli stessi dati. Calendario di lavoro, giorni non lavorativi, fuso del cantiere e significato delle date devono essere dichiarati. Il primo incremento non promette ottimizzazione delle risorse o un motore completo di critical path. Eventuali spostamenti trascinando le barre richiedono validazione e anteprima degli impatti prima di modificare dipendenze o date collegate.

## Tre metodi di avanzamento

Ogni voce elementare ha un metodo esplicito. Il metodo può cambiare solo con migrazione dei valori e storico, non reinterpretando silenziosamente i consuntivi.

| Metodo | Dato pianificato | Aggiornamento operativo | Percentuale risultante |
| --- | --- | --- | --- |
| Percentuale | Target 100%, criteri di valutazione e peso | Registrare una percentuale assoluta tra 0 e 100 con data e nota | Percentuale registrata |
| Quantità | Totale positivo e unità: pezzi, metri o altra unità definita | Aggiungere quantità installata per periodo, con autore e riferimenti | Somma quantità valide / totale pianificato × 100 |
| Azione sì/no | Una singola azione e relativo criterio di completamento | Dichiarare sì oppure no, conservando ciascuna variazione | No = 0%; sì = 100% di quella voce |

Esempi interamente sintetici: 45%; 24 pezzi installati su 80 = 30%; controllo eseguito = sì. Il valore sì indica l'esecuzione della singola azione, senza implicare automaticamente verifica accettata o accettazione di un'intera area.

### Regole di aggiornamento

- Registrare data operativa, momento di inserimento, autore, nota ed eventuale evidenza; possibilità di collegare l'aggiornamento al diario e al turno.
- **Dichiarato** e **verificato** restano due misure distinguibili. La dashboard etichetta chiaramente quale sta mostrando. Un avanzamento dichiarato non chiude automaticamente deviazioni o verifiche.
- Per le percentuali, i valori sono assoluti e non si sommano tra giorni. Una rettifica mantiene valore precedente e motivazione. Registrazioni retrodatate non alterano il dato corrente fuori ordine senza un confronto esplicito.
- Per le quantità, le registrazioni sono incrementi; correzioni/storni rimandano alla registrazione originaria. Controllare unità e precisione; i pezzi richiedono interi. Le verifiche riguardano quantità effettivamente dichiarate, senza doppio conteggio.
- Totale pianificato maggiore di zero obbligatorio per il metodo quantità. Superamenti del totale vengono segnalati e richiedono un'eccezione o revisione esplicita; nessun taglio silenzioso al 100%.
- Lo stato no può essere esplicito; l'assenza di un aggiornamento rimane “non rilevato”, distinta da una dichiarazione no o 0%.
- Identificativi delle operazioni rendono idempotenti ritentativi e import; il controllo di versione impedisce sovrascritture concorrenti silenziose.
- Consuntivi e verifiche sono registrati dal server con autorizzazioni e transazioni, conservando gli eventi precedenti.

### Aggregazioni

Le voci riassuntive WBS derivano dalle voci elementari. Per sommare quantità occorrono unità e significato compatibili; per aggregare metodi o lavorazioni differenti occorrono pesi espliciti. Formula proposta: `somma(peso × avanzamento) / somma(pesi)`, con pesi positivi e popolazione dichiarata. Il peso può rappresentare quantità comparabili, ore previste o un peso tecnico concordato. Non si assume che una media semplice rappresenti la percentuale del progetto. I dati mancanti devono essere visibili e l'aggregato segnalato come incompleto.

## Layout e mappe

- Conservare originale, versione, data, autore, area coperta, formato, pagine e stato della derivazione grafica.
- Selezionare la revisione attiva senza perdere i riferimenti alle revisioni precedenti.
- Collegare attività, deviazioni e voci di avanzamento a una pagina/area o a un punto/poligono. Coordinate sempre associate alla revisione del documento.
- Per PDF e immagini usare coordinate della pagina/immagine, normalizzate o in un riferimento dichiarato. Le coordinate CAD o geografiche richiedono unità, sistema e trasformazioni espliciti: una pianta caricata non diventa automaticamente una mappa georeferenziata.
- Le annotazioni restano in un livello separato dall'originale. Una revisione nuova richiede verifica dei collegamenti, senza spostare automaticamente i pin su una geometria differente.
- Per immagini grandi, generare anteprime e tasselli con limiti su dimensioni/pixel e risorse, caricando solo ciò che serve alla vista. L'originale ad alta risoluzione rimane disponibile agli utenti autorizzati.

## Modello dati proposto

| Gruppo | Entità e campi principali |
| --- | --- |
| Import | import_batches, source_mappings: checksum, mapping/versione, fonte, esito e righe respinte |
| Piano | schedules, schedule_revisions, schedule_items, schedule_item_revisions: chiave esterna stabile, WBS, area/asset, baseline, date e calendario |
| Collegamenti | schedule_dependencies, task_schedule_links: dipendenze e lavoro operativo associato |
| Misura | progress_items: metodo, unità, target, peso e criterio di accettazione; collegamento alla voce di piano |
| Consuntivi | progress_entries, progress_verifications: valore, natura assoluta/incrementale, data operativa, autore, rettifica, evidenza, stato della verifica e idempotency key |
| Layout | layouts, layout_revisions: document_version_id, formato, pagina, dimensioni, unità e riferimento coordinate |
| Derivati | document_derivatives: anteprima, tasselli o conversione, stato, checksum e parametri |
| Annotazioni | map_annotations e collegamenti tipizzati a task/deviation/progress_item, con foreign key e stesso cantiere |

Originali e derivati binari nello storage privato; struttura, coordinate, relazioni, progressi e storico in PostgreSQL. Elaborazioni CAD e immagini grandi possono richiedere un processo worker separato: risorse e costo su Railway vanno verificati prima di introdurlo. L'assetto iniziale app + database resta il primo nucleo.

## Sequenza proposta e accettazione

1. **Primo incremento:** XLSX con mapping, baseline e piano corrente, tabella WBS/Gantt, tre metodi di avanzamento e relativi eventi. Verificare il round-trip piano → aggiornamento → ricaricamento e separazione dichiarato/verificato.
2. **Viewer iniziale:** PDF e immagini con originali revisionati e collegamenti ad attività/aree. File CAD conservati con anteprima caricata, stato di compatibilità esplicito e nessuna promessa di rendering nativo.
3. **Estensioni:** conversioni CAD supportate, livelli/coordinate, tasselli per grandi immagini, dipendenze e analisi più avanzate; prova su campioni sintetici e verifica di licenze/risorse.

Test significativi: reimport senza duplicati né perdita di consuntivi; baseline invariata dopo aggiornamenti; 24/80 = 30%; azione sì/no con storico; dato mancante distinto da zero; rettifiche e superamenti; autorizzazioni; aggiornamenti concorrenti; separazione tra pin di revisioni diverse; errore di conversione che lascia intatto l'originale.

Restano da concordare profili Excel rappresentativi, tipologia di Gantt/calendario, pesi, policy di verifica e formati CAD prioritari. I campioni per sviluppo e repository sono sintetici.
