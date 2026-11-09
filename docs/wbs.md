# Project Structure (WBS)

Incremento 9 introduce una proiezione applicativa in sola lettura del Time Schedule, le API e una vista ad albero espandibile/comprimibile con tabella piatta IT/EN. Non abilita editing, scritture verso il sistema sorgente o sincronizzazione automatica. L'avanzamento mostrato è quello importato, non una verifica interna né un valore aggregato calcolato.

## Migrazione e sorgente

`server/migrations/{pg,sqlite}/008_wbs.sql` crea `project_structure`, gli indici per padre/ordinamento e `wbs_import_sources`. Le migrazioni 001–007 restano immutate. La migrazione viene scoperta dal runner esistente; non è stata applicata a un database operativo e non attiva servizi.

L'ingestione resta un prerequisito distinto: il contratto PostgreSQL è in `database/import-schema.sql`, non nelle migrazioni applicative. `008` non crea né popola gli schemi d'ingestione. Per SQLite il chiamante deve collegare due database già preparati con `ATTACH DATABASE ? AS ingest` e `ATTACH DATABASE ? AS source_snapshot` sulla stessa connessione prima di servire gli import. Le fixture in memoria riproducono esclusivamente dati sintetici; non costituiscono un importatore di file.

La configurazione fidata `wbs_import_sources(site_id, scope_id, run_id)` associa esplicitamente il cantiere al run da promuovere. Non è dedotta da nomi/codici e non è modificabile dal corpo HTTP. Il provisioning di questa associazione e l'ingestione dei file sono esterni a questo incremento. Per un nuovo snapshot si aggiorna `run_id` mantenendo lo scope corretto, poi si invoca l'import. Non selezioniamo implicitamente un run globale o l'ultimo disponibile.

L'import accetta solo un run `ready` con `completeness_verified`, il relativo batch `time_schedule` in stato `typed` e un numero di righe uguale a `expected_rows`. Scope, run, batch e identità sono verificati insieme. Nessuno snapshot o dato raw viene modificato.

## Identità e gerarchia

- Gli ID dei nodi sorgente dipendono deterministicamente da cantiere, scope e `source_uuid`; `source_entity_key_id` conserva il riferimento all'identità d'ingestione. Identità mancanti o non riconciliate impediscono la promozione.
- Il prefisso di un codice puntato, ad esempio `2.3` per `2.3.1`, individua il padre nello stesso `project_plan`. Codici opachi senza prefisso ricostruibile restano radici, anche con livello maggiore di zero. Il solo ordine non prova la parentela.
- Un padre assente diventa un nodo sintetico con codice derivato e livello immediatamente precedente; si ricostruiscono ricorsivamente gli antenati fino al livello zero. Descrizione, date, ore, avanzamento, flag, ordine e riferimenti sorgente restano null. Non si inventano pesi.
- Ogni collegamento richiede `parent.level + 1 = child.level`, quindi non può formare cicli. Livelli incompatibili danno `409 WBS_RECONCILIATION_REQUIRED`.
- Codici duplicati restano nodi distinti se hanno UUID diversi. Se un duplicato rende ambiguo un padre nello stesso piano, l'intera promozione fallisce con `409 WBS_AMBIGUOUS_PARENT`. Piani diversi restano separati nella ricostruzione.
- Liste e fratelli sono ordinati per livello, ordine (null in fondo), codice e ID. La UI indica esplicitamente i padri sintetici e i valori assenti.

La promozione è atomica e serializzata per cantiere. Ripetere lo stesso run/batch restituisce `unchanged: true` senza cambiare nodi o timestamp. Un nuovo run sostituisce la proiezione corrente, conserva ID e `created_at` delle identità ancora presenti, rimuove i nodi non più presenti e può sostituire padri sintetici con quelli sorgente. Gli snapshot storici rimangono nell'ingestione. Run e batch completati sono trattati come immutabili: eventuali correzioni richiedono un nuovo run.

Le quattro date sorgente prive di offset vengono convertite usando esclusivamente `import_runs.source_timezone` esplicito. Un fuso mancante/invalido o un orario locale ambiguo/inesistente impedisce la promozione; non si presume UTC né il fuso della macchina. Le date già corredate da offset vengono normalizzate a UTC. Null, zero e flag sconosciuti restano distinti. I valori originali rimangono negli snapshot; la serializzazione dei timestamp PostgreSQL segue il contratto del driver già esistente.

## API e permessi

| Operazione | Contratto | Permessi |
| --- | --- | --- |
| `GET /api/wbs?site_id=…` | Array di radici, ogni nodo con `children` | Membership del cantiere, incluso viewer |
| `GET /api/wbs?site_id=…&flat=1` | Array completo con `parent_id`, `level`, `sort_order` | Membership del cantiere |
| `GET /api/wbs/:id` | Nodo con figli immediati in `children` | Membership del cantiere del nodo |
| `POST /api/wbs/import` | Corpo `{ "site_id": "UUID sintetico del cantiere" }`; risultato `{ imported, synthetic, unchanged, run_id }` | Owner del cantiere |

Il modello attuale non ha un ruolo `admin` distinto: l'amministratore di cantiere è `owner`. Un owner di un altro cantiere non è autorizzato. Tutte le route richiedono sessione. Il repository verifica autonomamente i permessi di import; come per gli altri repository, le letture interne sono fidate e le route applicano i controlli di membership.

Errori di configurazione/sorgente non pronta restituiscono `409` con codice specifico (`WBS_SOURCE_NOT_CONFIGURED`, `WBS_SOURCE_UNAVAILABLE`, `WBS_RUN_NOT_READY`, `WBS_INCOMPLETE_SNAPSHOT`); non modificano la proiezione precedente. La UI è di consultazione e non espone controlli di import o editing.

## Verifiche

`npm test` include `tests/wbs.test.mjs` tramite `tests/index.js`: migrazioni SQLite/PostgreSQL in memoria, snapshot sintetici, assenza di cicli, null/zero, duplicati, piani distinti, idempotenza, nuovi run, rollback e autorizzazioni tramite il listener HTTP reale. `npm run test:schema` verifica il contratto d'ingestione PostgreSQL. `node tests/browser.cjs` include albero, espansione/compressione, tabella, cambio cantiere, errori di rete e viewport mobile; richiede Playwright e Chromium già disponibili. I test con socket possono richiedere l'esecuzione fuori dalla sandbox.
