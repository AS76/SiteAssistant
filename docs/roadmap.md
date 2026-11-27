# Roadmap SiteAssistant

Documento **derivato**. Le fonti autorevoli sono le card del board `siteassistant`; questo file ne è la rappresentazione leggibile e va aggiornato al merge di ogni incremento. In caso di divergenza vale la card.

## Visione di prodotto

Direzione confermata dall'owner il 27/11/2026, documento `docs/product-vision.md`.

Tre pilastri — **Site Execution** (WBS, attività, avanzamento, risorse, impegni, deviazioni), **Site Logistics** (procurement, spedizioni, materiali, inventario, asset, attrezzature) e **Site Assurance** (HSE, qualità, ispezioni, evidenze, verifiche, handover, Permit to Work) — su fondamenta condivise: luoghi, persone, imprese, identità, permessi, diario probatorio, giurisdizioni, documenti, audit trail.

Serve a stabilire dove vive un requisito e a prevenire duplicazioni tra moduli. Non è un mandato di refactoring né un cambio di priorità: Luoghi e Asset 2a e 2b restano davanti.

## Sequenza HSE concordata

| Ordine | Fase | Stato | Riferimenti |
| --- | --- | --- | --- |
| 1 | Safety hardening ispezioni (Fase 0) | **fatto**, in `main` con `d9beec3` | card della Fase 0; migrazione 056; criteri F0-01…F0-10 formalizzati nel commento della PR #62 |
| 2 | Foundations | da aprire | dipende da luoghi/asset e persone/imprese |
| 3 | Audit e ispezioni | backlog | card C-03…C-13 |
| 4 | Handover | backlog | card Handover |
| 5 | Permit to Work | backlog, non attivo | card Permit to Work (design separato) |

## Flussi funzionali

### 1. Luoghi e asset installati — primo incremento funzionale
Specifica in `docs/places-and-assets.md` (PR #58). Gerarchia sito → edificio → piano → zona → locale, registro asset con ciclo di vita e garanzia, intervalli di posizione. Sblocca diario probatorio, qualità, documenti e handover.

### 2. Persone, imprese e partecipazione esterna
Specifica in `docs/people-and-companies.md` (PR #59). Da costruire insieme ai luoghi per evitare anagrafiche duplicate: un asset ha un installatore, un luogo ha un responsabile, un'attività ha esecutore e verificatore.

### 3. Diario probatorio e archivio visivo
Specifica in `docs/evidentiary-diary.md` (PR #60). Dipende da luoghi (dove) e persone (chi firma), e dagli allegati esistenti.

### 4. Ciclo dell'impegno settimanale
Specifica in `docs/weekly-commitment-cycle.md` (PR #61). Dipende da attività e squadre; alimenta il diario con gli impegni mantenuti o mancati.

### 5. Moduli paese e lingua dei contenuti
Specifica in `docs/country-modules.md` (PR #61). Trasversale: tocca documenti, HSE, unità e formati. Le fixture Northline IT/UK (`d8dc3cb`) sono la base di prova.

### 6. Identificazione QR, etichette e inventario fisico
Specifica in `docs/qr-identification-inventory.md`. Nasce dall'esperienza operativa con InsiteLMS. Copre identificazione QR di asset installati, attrezzature e — quando esisterà il modulo materiali — articoli di magazzino; etichette in tre formati (compatto, descrittivo, logistico); stampa singola, massiva, ristampa, anteprima e dimensioni personalizzabili su A4 e con driver di sistema; scansione mobile con apertura della scheda e azioni contestuali; sessioni di inventario con duplicati, sconosciuti, ubicazioni discordanti e riconciliazione. **Solo specifica**: nessuna implementazione autorizzata, nessuna dipendenza installata.

Decisioni approvate dall'owner il 27/11/2026: identità unica per oggetto fisico con Attrezzature autorevole e HSE che non duplica l'identità; payload canonico URN versionato con UUID, indipendente da tag, posizione e dominio; codice digitabile non basato sul tag; `qrcode` (soldair) come candidato, con SVG prioritario e PNG alternativo, approvazione subordinata alla verifica in implementazione; scansione reale su Safari/iPhone e Chrome/Android come criterio di prima release con decoder di riserva caricato su richiesta; permessi dei moduli esistenti più quattro autorizzazioni distinte per l'inventario (apertura/chiusura, rilevazioni, riconciliazione, approvazione movimenti); diario alimentato solo da sessioni chiuse con rettifiche tracciate; offline in seconda fase con cache circoscritta, scadenza e invalidazione.

Dipendenze: 2a e 2b merged (API e scheda asset); modulo Site Materials & Inventory per articoli e formato logistico; estensione degli allegati a Luoghi e Asset come dipendenza dei flussi documentali, **non** dell'identificazione. Le scelte della 057 non precludono la funzionalità: il QR veicola l'UUID e non il tag, e l'inventario propone i movimenti senza applicarli.

Secondo giro di decisioni (27/11/2026, revisione delle specifiche): **codice breve permanente** al posto del codice derivato di 26 caratteri, con carattere di controllo, collisioni gestite e nessuna riassegnazione; **`asset_id` in `hse_assets` approvato** come incremento dedicato; **`tools` autorevole** con riconciliazione esplicita e verifica fisica per i beni HSE non collegati, mai associazioni dedotte; **sessioni consultabili con autorizzazioni circoscritte** al dominio e al cantiere, senza esposizione indiretta tramite conteggi. Integrazioni recepite: continuità dell'identità fisica fra ricevimento e installazione (nessuna ristampa, nessuna doppia identità); posizione **attesa e osservata** in ogni rilevazione, con contesto di scansione e QR dei luoghi che imposta il contesto senza spostare nulla.

### 7. Site Materials & Inventory
Specifica in `docs/site-materials-inventory.md`. Modulo autonomo per la logistica operativa di cantiere: anagrafica articoli con codici e alias, unità di misura e quantità, articoli serializzati e non, lotti dal primo rilascio della movimentazione con obbligatorietà configurabile, colli e pallet, collegamenti a ordini e ricevimenti, ubicazioni come luoghi con granularità flessibile, movimenti append-only con **stati della quantità e custodia**, collegamento agli asset installati, inventario fisico e riconciliazione delle quantità. **Solo specifica**: implementazione non autorizzata.

Semantica dei movimenti approvata il 27/11/2026: cinque stati distinti (deposito, custodia, assegnato, consumato, reso) invece di una giacenza unica. Il prelievo è neutro sul presente fisico e il consumo sottrae una volta sola: con una giacenza unica, prelievo più consumo sottrarrebbero due volte lo stesso oggetto. Modulo `materials` **strict**, come `logistics`. Anagrafiche separate per cantiere nella prima release.

Confine dichiarato: SiteAssistant non diventa un ERP né un WMS generalista. Fuori scope distinte base, cicli, MRP, valorizzazione, FIFO/LIFO contabile e tracciabilità fiscale. Oggi i materiali esistono solo come `material_no` testuale su righe d'ordine e colli (032–034): non c'è giacenza, non c'è identità di articolo, non c'è legame con l'installato.

### 8. Altri flussi, non ancora specificati
Qualità e accettazione, registro documenti, attenzione ed escalation, misura e valore, chiusura e handover, pilot Northline, collaudo di comprensione della demo.

## Base tecnica già consolidata

- Migrazioni resilienti: manifest con checksum, tracciamento dell'ordine, snapshot di catalogo SQLite e PostgreSQL 16 (`674143e`).
- `demo_seed_records` nello schema, migrazione 054 (`3979020`).
- Guardie di sicurezza su seed e reset demo, migrazione 055 (`f262e61`).
- Fixture Northline deterministiche (`d8dc3cb`).
- `demo_user` automatico all'approvazione del visitatore (`3313f4e`).
- Demo riconciliata su database nuovo, percorso A, con vecchio database conservato come `siteassistant_legacy`.

## Governance

- **Coordinamento unico**: Cleo, indipendentemente da sessione o canale. Le sessioni non operano come coordinatori indipendenti.
- **Assegnazione**: ogni card ha un responsabile operativo identificato prima dell'avvio.
- **Migrazioni**: numerazione riservata centralmente; ultima pubblicata 056. Una nuova migrazione prende il numero successivo solo dopo il merge della precedente.
- **Branch**: perimetri non sovrapposti; dichiarare i file toccati nella card o nel commento di presa in carico.
- **Ordine di merge**: dipendenze esplicite nella card; chi mergia verifica che i prerequisiti siano già in `main`.
- **Decisioni**: ogni decisione presa in una sessione va scritta nella card relativa, così le altre sessioni la vedono.

## Decisioni aperte

| Tema | Chi decide | Stato |
| --- | --- | --- |
| Riattivazione del reset notturno della demo | owner | nessun cron o timer attivo; ultima esecuzione schedulata 26/11 04:00 |
| Etichetta QR: soggetto autoritativo quando `tools` e `hse_assets` descrivono lo stesso oggetto | owner | chiusa il 27/11: `tools` autorevole, riconciliazione esplicita con verifica fisica; aperto il momento dell'incremento `asset_id` (`docs/qr-identification-inventory.md` §14) |
| Modulo `materials`: visibilità *strict* come `logistics` | owner | chiusa il 27/11: strict approvato; restano cinque decisioni in `docs/site-materials-inventory.md` §14 |
| Container mobili e noleggiati: luogo del sito o oggetto tracciato a sé | owner | `docs/site-materials-inventory.md` §14 |
| Prova D3 di ripristino | owner | card dell'owner, non blocca lo sviluppo |
| Rilascio del database legacy | owner | conservazione minima 7 giorni, nessuna cancellazione autorizzata |
| Validità legale della firma nel diario | owner | dichiarata in `docs/evidentiary-diary.md` §10 |
| Durata e creatori dei link esterni | owner | dichiarata in `docs/people-and-companies.md` §9 |
