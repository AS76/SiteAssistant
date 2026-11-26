# Roadmap SiteAssistant

Documento **derivato**. Le fonti autorevoli sono le card del board `siteassistant`; questo file ne è la rappresentazione leggibile e va aggiornato al merge di ogni incremento. In caso di divergenza vale la card.

## Sequenza HSE concordata

| Ordine | Fase | Stato | Riferimenti |
| --- | --- | --- | --- |
| 1 | Safety hardening ispezioni (Fase 0) | **fatto**, in `main` con `d9beec3` | card `e9de7824`; migrazione 056; criteri F0-01…F0-10 formalizzati nel commento della PR #62 |
| 2 | Foundations | da aprire | dipende da luoghi/asset e persone/imprese |
| 3 | Audit e ispezioni | backlog | card C-03…C-13 (`97ff1bf2`, `28904028`, `9f7b11c1`, `a9ba3ce1`, `55fe68fc`, `d3b14a5e`, `af8eb9fc`, `85eec013`, `0f3ddb35`, `d37e10c2`) |
| 4 | Handover | backlog | card `7ea1b288`, `a9ba3ce1` |
| 5 | Permit to Work | backlog, non attivo | card `aad85095` (design separato) |

## Flussi funzionali

### 1. Luoghi e asset installati — primo incremento funzionale
Card `40d387ab`. Specifica in `docs/places-and-assets.md` (PR #58). Gerarchia sito → edificio → piano → zona → locale, registro asset con ciclo di vita e garanzia, intervalli di posizione. Sblocca diario probatorio, qualità, documenti e handover.

### 2. Persone, imprese e partecipazione esterna
Card `d3f7014a`. Specifica in `docs/people-and-companies.md` (PR #59). Da costruire insieme ai luoghi per evitare anagrafiche duplicate: un asset ha un installatore, un luogo ha un responsabile, un'attività ha esecutore e verificatore.

### 3. Diario probatorio e archivio visivo
Card `ecd1b366`. Specifica in `docs/evidentiary-diary.md` (PR #60). Dipende da luoghi (dove) e persone (chi firma), e dagli allegati esistenti.

### 4. Ciclo dell'impegno settimanale
Card `0060050b`. Specifica in `docs/weekly-commitment-cycle.md` (PR #61). Dipende da attività e squadre; alimenta il diario con gli impegni mantenuti o mancati.

### 5. Moduli paese e lingua dei contenuti
Card `f50678aa`. Specifica in `docs/country-modules.md` (PR #61). Trasversale: tocca documenti, HSE, unità e formati. Le fixture Northline IT/UK (`d8dc3cb`) sono la base di prova.

### 6. Altri flussi, non ancora specificati
Qualità e accettazione `b27d6ec0`, registro documenti `daf4fd9d`, attenzione ed escalation `b98b2b00`, misura e valore `505c32cd`, chiusura e handover `7ea1b288`, pilot Northline `022fa182`, collaudo di comprensione della demo `c6c1f2df`.

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
| Prova D3 di ripristino | owner | card `93ccb9ae`, non blocca lo sviluppo |
| Rilascio del database legacy | owner | conservazione minima 7 giorni, nessuna cancellazione autorizzata |
| Validità legale della firma nel diario | owner | dichiarata in `docs/evidentiary-diary.md` §10 |
| Durata e creatori dei link esterni | owner | dichiarata in `docs/people-and-companies.md` §9 |
