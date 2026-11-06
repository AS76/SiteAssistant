# SiteAssistant

Prima web app per cantieri, attività e diario giornaliero, con interfaccia italiano/inglese.

## Avvio

Richiede Python 3; non servono installazione, account o chiavi API.

```sh
python3 -m http.server 8000 --bind 127.0.0.1 --directory app
```

Aprire la porta 8000 nel browser locale. I dati sono conservati nel browser per la stessa origine. Usare l'esportazione JSON per salvarne una copia. Per fermare il server: Ctrl+C.

## Funzioni

- Creazione cantieri e selezione del contesto di lavoro.
- Attività per area, impresa, esecutore e verificatore; filtri e vista board/elenco.
- Blocchi motivati, dichiarazione di completamento con evidenza testuale, verifica separata e riapertura con storico.
- Diario per giorno operativo e turno, con piano, consuntivo, scostamenti e prossimo passo.
- Indicatori coerenti con gli stati; CSV attività, stampa del diario, backup e ripristino JSON.
- Preferenza di lingua IT/EN, layout responsive e navigazione da tastiera.

## Limiti della prima versione

È una demo locale con esempi fittizi. Non inserire informazioni riservate. Il selettore di persona simula le responsabilità del flusso: non è autenticazione o protezione degli accessi. I dati non sono condivisi tra dispositivi; cancellare i dati del browser li rimuove. Niente upload foto, backend, sincronizzazione, funzionamento offline garantito o invii esterni. L'evidenza è una nota o un riferimento testuale, non un allegato verificato. La stampa usa il browser.

Nessuna dipendenza esterna, telemetria, CDN o chiamata a servizi terzi. Il cambio lingua traduce l'interfaccia, lasciando invariati i contenuti inseriti.

## Verifica

La demo statica non richiede installazione. Per eseguire anche i test dello schema SQL usare Node.js 24 e installare le dipendenze di sviluppo:

```sh
npm ci
npm test
npm run test:schema
```

Il test browser opzionale richiede Playwright e un Chromium disponibili nell'ambiente:

```sh
SITEASSISTANT_URL=http://127.0.0.1:8000 node tests/browser.cjs
```

[Requisiti e perimetro](docs/requirements.md).

[Architettura e base dati proposte per la versione multiutente](docs/architecture.md).

[Tabella e infografica dell'architettura](docs/architecture-overview.html).

[Specifica Pianificazione, layout e mappe](docs/planning-layouts.md).

[Import e archivio documenti in modalità complementare](docs/import-storage.md).

[Valutazione economica della demo multiutente](docs/cost-options.md).

[Ripresa dello sviluppo con Codex](docs/development-handoff.md).

[Schema PostgreSQL generico e test sintetici](database/README.md).
