# SiteAssistant — Panoramica Architetturale

## 1. Topologia di Sistema

SiteAssistant è progettato come un'applicazione a livelli disaccoppiati, composta da:
1. **Frontend statico (`app/`):** interfaccia utente responsive implementata in HTML5, CSS moderno e JavaScript nativo a moduli (ESM). Non richiede server Node per la distribuzione dei file statici.
2. **Backend API REST (`server/`):** servizio HTTP leggero Node.js (Node 24) privo di framework pesanti, con routing nativo e gestione asincrona delle transazioni.
3. **Database Relazionale (`database/` e `server/storage/`):** strato di persistenza con doppia implementazione driver:
   - **PostgreSQL (target primario e produzione):** istanza PostgreSQL self-hosted (cluster PostgreSQL 18 locale), con schema relazionale dedicato (`app`), vincoli di integrità e supporto transazionale.
   - **SQLite (sviluppo locale e test leggeri):** driver basato su `node:sqlite` (`DatabaseSync`) per esecuzione immediata senza dipendenze esterne.

---

## 2. Struttura dei Moduli nel Repository

L'organizzazione dei sorgenti riflette rigorosamente la separazione delle responsabilità:

```text
SiteAssistant/
├── app/                  # Frontend statico (UI)
│   ├── index.html        # Struttura e configurazione base URL API
│   ├── app.mjs           # Controller dell'interfaccia e rendering
│   ├── domain.mjs        # Logica pura di dominio, validazione e transizioni
│   ├── api.mjs           # Client HTTP per comunicazione con la REST API
│   ├── i18n.mjs          # Dizionario e traduzioni dinamiche IT / EN
│   └── styles.css        # Layout responsive, stili board e regole di stampa
├── server/               # Backend API REST
│   ├── index.mjs         # Entrypoint del server HTTP e gestione pool DB
│   ├── http.mjs          # Router HTTP, parsing JSON, CORS e gestione errori
│   ├── repository.mjs    # Validazioni di business, query SQL e transazioni
│   ├── db.mjs            # Factory del database e DDL idempotente
│   ├── seed.mjs          # Inserimento atomico dei dati sintetici iniziali
│   └── storage/          # Astrazione dello strato di persistenza
│       ├── index.mjs     # Interfaccia comune Storage
│       ├── pg.mjs        # Driver PostgreSQL (pg Pool asincrono)
│       └── sqlite.mjs    # Driver SQLite nativo (node:sqlite)
├── database/             # Schemi e specifiche dati d'ingestione
│   ├── import-schema.sql # DDL per schemi ingest, source_snapshot, internal_work, reporting
│   └── README.md         # Documentazione dello schema d'importazione
└── tests/                # Suite di collaudo automatizzata
    ├── api.test.mjs      # Test dei contratti e dell'integrazione del client API
    ├── browser.cjs       # Test end-to-end del flusso browser (Playwright)
    ├── domain.test.mjs   # Test isolati su validazioni e logica pura del client
    ├── helpers/          # Utilità e fixture per i test (setup database)
    ├── index.js          # Runner principale della suite (`node --test tests/`)
    ├── parity.test.mjs   # Test di parità e conformità tra driver SQLite e PostgreSQL
    ├── pg-storage.test.mjs # Test specifici del driver e del pool PostgreSQL
    ├── repository.test.mjs # Test del repository, concorrenza e transazioni
    ├── schema.test.mjs   # Test di integrità dello schema d'ingestione su PGlite WASM
    └── server.test.mjs   # Test end-to-end HTTP API e routing
```

---

## 3. Scelte Architetturali Chiave

Tutte le decisioni architetturali implementate o formalizzate nei documenti di progetto rispondono a principi operativi precisi e verificabili nel codice:

### 3.1 Astrazione Storage e Doppia Compatibilità (SQLite / PostgreSQL)
- L'accesso al database è mediato dalla classe astratta `Storage` (`server/storage/index.mjs`), che espone metodi standardizzati: `get`, `all`, `run`, `exec`, `transaction` e `isUniqueViolation`.
- **Parità dei tipi JSON:** per garantire che la serializzazione JSON rimanga identica tra i driver, la chiave `task_events.id` utilizza in PostgreSQL `INTEGER GENERATED ALWAYS AS IDENTITY` (tipo `int4`), convertito da `node-postgres` come numero JavaScript (evitando la conversione a stringa tipica di `BIGINT`).
- I controlli di unicità intercettano nativamente il codice errore PostgreSQL `23505` e l'errcode SQLite `2067`.

### 3.2 Immutabilità dei Dati d'Importazione (Raw & Snapshot)
- Il modello d'importazione definito in `database/import-schema.sql` prescrive che i dati sorgente esterni (es. export di cronoprogrammi o presenze) siano conservati in modo append-only.
- La riga originaria viene salvata integralmente nella tabella `ingest.raw_rows` come oggetto `JSONB` corredato da fingerprint di riga (`content_sha256`).
- Le tabelle tipizzate in `source_snapshot` non subiscono mai `UPDATE` o `DELETE`: un nuovo invio genera un nuovo batch di caricamento.
- Le annotazioni e le integrazioni operative interne vivono nello schema `internal_work` (o collegate tramite `entity_keys`), garantendo che l'identità del dato interno persista a prescindere dalle re-estrazioni dei file sorgente.

### 3.3 Regola del Giorno Operativo con Cutoff alle 06:00
- Nei contesti di cantiere industriale e montaggio, le attività non si arrestano alla mezzanotte di calendario: il turno serale o notturno rappresenta una continuità lavorativa.
- **Definizione formale:** il giorno operativo $D$ convenzionale ha inizio alle ore `06:00:00` locali e termina alle `05:59:59` del giorno solare successivo ($D+1$).
- **Attribuzione dei turni:**
  - Qualsiasi evento o registrazione effettuata tra le `00:00:00` e le `05:59:59` appartiene al giorno operativo precedente ($D-1$).
  - I turni notturni (es. 22:00–06:00) sono attribuiti interamente al giorno operativo in cui il turno ha avuto inizio.
- Il database applicativo memorizza il diario con chiave `(site_id, operational_date, shift)`, rendendo il giornale dei lavori indipendente dalle fluttuazioni di calendario civile.
- La specifica prevede `day_cutoff_time` configurabile per cantiere (con default a `06:00` Europe/Rome).

### 3.4 Separazione tra Stati Ufficiali e Aggiornamenti Interni
- SiteAssistant adotta il principio fondamentale di **strumento complementare non invasivo**: non tenta una sincronizzazione bidirezionale opaca con i sistemi informativi centrali (ERP, P6 o portali clienti).
- Gli stati o avanzamenti provenienti dagli export esterni risiedono negli snapshot sorgente immutabili.
- Lo stato delle attività in SiteAssistant (`todo`, `in_progress`, `to_verify`, `closed`, `blocked`) governa esclusivamente la gestione operativa interna e le verifiche in campo del Site Manager.

### 3.5 Separazione dei Ruoli Esecutore / Verificatore
- Il modello dati applicativo e la logica di transizione impongono che chi realizza un'attività (`executor`) non possa assumere il ruolo di verificatore (`verifier`) per la medesima voce.
- La chiusura dell'attività (`to_verify` $\rightarrow$ `closed`) è rifiutata a livello di backend con codice di errore `409` (`VERIFIER_REQUIRED`) se l'attore che sottomette la richiesta non corrisponde al verificatore designato.
