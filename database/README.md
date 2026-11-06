# Schema di importazione proposto

`import-schema.sql` contiene una base SQL generica, senza dati reali, mapping delle intestazioni private o configurazioni di account. È separata dalla demo nel browser e non viene applicata automaticamente.

| Schema | Responsabilità |
| --- | --- |
| `ingest` | Contesti, lotti, file, righe raw, identità e controlli |
| `source_snapshot` | Tabelle tipizzate per le famiglie di import supportate |
| `internal_work` | Annotazioni legate all'identità del record, separate dagli snapshot |
| `reporting` | Viste dell'ultimo insieme di import dichiarato completo |

Le famiglie sono anagrafiche operative, pianificazione, avanzamento, registrazioni giornaliere, presenze e deviazioni. Le righe originali sono conservate anche quando uguali tra loro. Un dato assente rimane distinto da un falso booleano o da uno zero. Le date sorgenti prive di fuso restano timestamp locali fino a una conversione esplicita.

Per un database vuoto di sviluppo, dopo aver revisionato lo script:

```sh
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f database/import-schema.sql
```

`DATABASE_URL` deve essere fornita privatamente dall'ambiente. Non eseguire il comando su un database condiviso o di produzione senza una migrazione revisionata. Lo script crea gli schemi; non è idempotente e non modifica lo schema applicativo esistente.

## Confini della base SQL

Questo è un modello d'ingestione, non un backend completo. Restano da implementare migrazioni versionate, autorizzazioni, RLS se adottata, collegamenti a organizzazioni/utenti applicativi, caricatore, profili di mapping, gestione dei conflitti, applicazione dell'immutabilità e controlli di completezza lato server. Le viste usano un indicatore di completezza che deve essere certificato dal caricatore dopo le verifiche; il flag non esegue da solo questi controlli.

I nomi dei campi sono canonici e generici. Un profilo privato versionato deve associare le colonne della sorgente ai campi canonici. Non copiare intestazioni proprietarie, etichette di organizzazioni, report o manifest reali per ricostruire il mapping pubblico. Alcuni campi opzionali sono estensioni di contratto: il loro uso effettivo dipende dal profilo confermato.

## Verifica locale

Con Node.js 24:

```sh
npm ci
npm run test:schema
```

Il test usa PostgreSQL WASM in memoria tramite PGlite e fixture interamente sintetiche. Verifica creazione dello schema, relazioni, unicità, isolamento del contesto e conservazione di più righe per giorno o di righe duplicate. Non richiede un servizio remoto. La versione PostgreSQL del deployment andrà verificata separatamente, insieme a backup e ripristino.
