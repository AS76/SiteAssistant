# SiteAssistant

Prima web app per cantieri, attività e diario giornaliero, con interfaccia italiano/inglese.

Documentazione utente e tecnica (IT/EN): <https://as76.github.io/SiteAssistant/>. Sorgente in `docs-site/`, pubblicata automaticamente da GitHub Actions a ogni modifica su `main`.

## Avvio

Il frontend statico legge e salva cantieri, attività e diario tramite la REST API. La base URL predefinita è `https://api.siteassistant.asassi.cloud`; non usa localStorage, dati di ripiego o backup JSON.

Per servire i file statici:

```sh
python3 -m http.server 8000 --bind 127.0.0.1 --directory app
```

Per configurare un'altra API, aggiungere in `app/index.html`, prima dello script modulo:

```html
<meta name="siteassistant-api-base" content="https://api.example.com">
```

Con `content="/"` il client usa la **stessa origine** che serve i file statici, quindi l'app deve essere pubblicata dall'API (stesso host, stesso schema). Il valore vuoto risultante dalla rimozione degli slash finali produce chiamate relative come `/api/sites`.

Il client aggiunge `/api/sites`, `/api/tasks` e `/api/diary` alla base URL. È anche disponibile `createApi({ baseUrl })` in `app/api.mjs`. L'API deve consentire l'origine del frontend: il CORS del server autorizza `https://siteassistant.asassi.cloud`. Un frontend locale richiede un proxy della stessa origine o un'API di sviluppo con CORS appropriato; servire i soli file su localhost non abilita l'accesso cross-origin.

Per avviare il backend di sviluppo con Node.js 24, seguire [Backend incremento 1](docs/backend-increment-1.md). Nessuna configurazione o migrazione di produzione viene applicata dall'avvio del frontend.

Le migrazioni applicative versionate, il calcolo del giorno operativo e l'header opzionale `Idempotency-Key` sono descritti nel [riferimento tecnico dell'incremento 4](docs/backend-increment-4.md).

## Funzioni

- Creazione cantieri e selezione del contesto di lavoro.
- Attività per area, impresa, esecutore e verificatore; filtri e vista board/elenco.
- Blocchi motivati, dichiarazione di completamento con evidenza testuale, verifica separata e riapertura con storico.
- Diario per giorno operativo e turno, con piano, consuntivo, scostamenti e prossimo passo.
- Indicatori coerenti con gli stati; CSV sulle attività caricate e filtrate, stampa del diario.
- Interfaccia IT/EN, layout responsive e navigazione da tastiera; lingua e cantiere selezionato rimangono in memoria fino al ricaricamento.

## Limiti della prima versione

Il backend conserva i dati condivisi; il frontend non contiene autenticazione. Esecutore, verificatore e persona che registra una transizione sono testi liberi. La chiusura richiede il verificatore assegnato e una nota; dichiarare l'esecuzione richiede una nota, bloccare o riaprire richiede una motivazione.

La UI segue le transizioni del backend: `todo → in_progress / blocked`, `in_progress → to_verify / blocked`, `to_verify → closed / blocked`, `closed → in_progress`. `blocked` non ha transizioni in uscita. Non sono disponibili modifica attività, criteri di accettazione, descrizioni o ripristino JSON. Il diario accetta un contributo per cantiere, giorno operativo e turno, senza autore né collegamento attività.

Non inserire informazioni riservate. Upload, connettori e funzionamento offline non sono implementati. L'evidenza è una nota testuale; la stampa usa il browser. Il cambio lingua traduce l'interfaccia, lasciando invariati i contenuti inseriti. Questa modifica collega il frontend all'API e non avvia deploy o attiva nuovi servizi. I documenti di architettura descrivono anche funzionalità proposte e il precedente stato della demo locale.

## Verifica

Per i test usare Node.js 24 e installare le dipendenze:

```sh
npm ci
npm test
npm run test:schema
```

Il test browser opzionale richiede Playwright e Chromium disponibili nell'ambiente. Avvia un backend SQLite isolato in memoria e intercetta le richieste con Playwright: usa i file locali con l'origine frontend autorizzata, senza scrivere sul servizio pubblico. Non richiede un server statico separato. Configurare `CHROMIUM_PATH` se necessario:

```sh
node tests/browser.cjs
```

[Requisiti e perimetro](docs/requirements.md).

[Architettura e base dati proposte per la versione multiutente](docs/architecture.md).

[Tabella e infografica dell'architettura](docs/architecture-overview.html).

[Specifica Pianificazione, layout e mappe](docs/planning-layouts.md).

[Import e archivio documenti in modalità complementare](docs/import-storage.md).

[Valutazione economica della demo multiutente](docs/cost-options.md).

[Ripresa dello sviluppo con Codex](docs/development-handoff.md).

[Schema PostgreSQL generico e test sintetici](database/README.md).
