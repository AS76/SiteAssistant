# Import di pianificazione applicativo — incremento 18

Backend implementato, senza UI. Non attiva connettori, storage esterno o deploy.
La migrazione **015**, per SQLite e PostgreSQL, aggiunge `planning_import_runs` e
`planning_import_keys`; non modifica le migrazioni precedenti o gli schemi di ingestione.
La sua presenza nel checkout non significa che sia stata applicata in produzione.

## API

Solo `owner` ed `editor` del cantiere possono usare queste route autenticate:

- `POST /api/import/preview`: JSON con `site_id`, `family`, `filename`, `data_base64`.
- `POST /api/import/apply`: stesso JSON, più `preview_token` restituito dall'anteprima.

`family` accetta `employees`, `work_days`, `time_schedule`,
`site_progress_items`, `deviations`, `daily_log`. Si legge solo il primo foglio.
Il file decodificato non può superare 20 MiB; il limite HTTP include l'espansione
base64 e un margine limitato per i metadati. Il nome file è descrittivo, mai un percorso.

L'anteprima non scrive su database. Restituisce `counts` e `samples` per
`added`, `updated`, `unchanged`, `removed`, `rejected`, al massimo 50 esempi per
categoria, oltre a `unmapped_columns`. Gli scarti contengono numero di riga,
`rejected` (codice) e `reason`. Le righe valide includono valori, chiave e warning.
Le colonne non riconosciute sono esplicitamente elencate, non interpretate.

Il token HMAC-SHA256 scade dopo 15 minuti e vincola byte del file, famiglia,
cantiere, fuso e risultato della normalizzazione. Non è un'autorizzazione: il ruolo
viene verificato nuovamente all'apply e nella transazione. Con più processi occorre
configurare lo stesso segreto casuale `planning_IMPORT_TOKEN_SECRET` (almeno 32 byte di
entropia). Senza configurazione si usa un segreto casuale di processo: un riavvio
invalida le anteprime ancora aperte.

L'apply ricalcola il diff nella transazione, serializzata sul cantiere. Le righe
rifiutate restano escluse, le altre vengono applicate. Restituisce `counts`,
`applied_keys` (solo aggiunte/aggiornate) e `import_run_id`. Il conteggio applicato
`removed` è sempre zero: nessuna riga viene cancellata. Un secondo apply dello
stesso file produce zero modifiche ai record applicativi, con una nuova ricevuta
per il tentativo. Le modifiche concorrenti avvenute dopo l'anteprima possono
cambiare i conteggi finali.

Ogni apply conserva nella nuova tabella il file originale, hash, autore, esito e
chiavi modificate. Il binding registra identità, ultimo run e timestamp. Le
relazioni applicative esistenti vengono preservate; i record aggiornati mantengono
ID e `created_at`. Le tabelle destinazione attuali non hanno `updated_at`:
l'aggiornamento è tracciato nel binding e nel run. Questi dati restano nel database
applicativo; non vengono inviati all'ingestione di snapshot.

## Contratto delle colonne

I nomi sono esatti e distinguono maiuscole/minuscole. Il contratto implementato è
esposto da `FAMILIES` in `server/planning-import.mjs`. Le intestazioni descrittive non
elencate nella richiesta originale richiedono confronto con i soli header degli
export prima dell'accettazione sull'host, soprattutto per Daily Log.

| Famiglia | Colonne obbligatorie | Altre colonne riconosciute |
| --- | --- | --- |
| Employees | Employee No | First Name, Last Name, Company, Qualification, Supervisor, Team, Hire Date, Expire Date |
| Work Days | Date, Employee No | Start Time, Finish Time, Work Time, Open Hours, Booked Hours, Status |
| Time Schedule | Time Schedule Item No | Description, PLC-Area, Section, Assigned To, Planned Start, Planned Finish, Actual Start, Actual Finish, Progress %, Sort Order, Summary Task, Planned Hours |
| Site Progress Items | Description, Planned Start, Planned Finish, PLC-Area, Section | Assigned To, Actual Start, Progress %, Planned Progress %, Delta Progress, Expected Delay, Has Files, Has Notes, Has Deviations |
| Deviations | Deviation No, Status | Title, Problem Description, Priority, Author, Assigned To, PLC-Area, Creation Date, Due Date, Approved Date, Closed Date, Actual Cost, Claim Quantity, Labor Hours, Completed Tasks % |
| Daily Log | Date | Plan, Actual, Impediments, Next Step |

Le celle delle colonne obbligatorie devono essere compilate, salvo le dimensioni
opzionali della chiave composita progressi: qui solo Description deve essere non
vuota. Le altre dimensioni possono essere NULL, ma le intestazioni devono esserci.
Una colonna opzionale assente non azzera il campo esistente; una cella vuota in una
colonna presente produce NULL. Gli stati presenze mantengono il testo originale.

Date calendario (`hire_date`, `expire_date`, `operational_date`) e orari delle
presenze restano DATE/TIME. I timestamp vengono convertiti in UTC dal fuso
`Europe/Rome`, attuale default applicativo: `sites` non ha una colonna fuso.
La funzione di parsing accetta anche un fuso esplicito. Orari DST ambigui o
inesistenti vengono rifiutati; le frazioni di secondo sono preservate fino a sei
cifre. Numeri decimali con virgola diventano Number; vuoto significa NULL.

Le chiavi progressi normalizzano Unicode NFKC, spazi, maiuscole e timestamp;
l'occorrenza è 1-based. Le occorrenze successive hanno `identity_state=unresolved`
nel binding e un warning «Da confermare», e vengono comunque importate. Nessuna
chiave viene inventata in `ingest.entity_keys`. Il `source_row` applicativo è
assegnato senza collisioni e resta stabile; il numero di riga del nuovo export è
mostrato nell'anteprima e recuperabile dal file archiviato.

Time Schedule ricava padre e livello dal codice, ignora Level e importa come
radici i figli senza padre nell'export. Una chiave ambigua già presente nel DB
richiede riconciliazione (`AMBIGUOUS_KEY`); anche i figli di un padre ambiguo sono
rifiutati. Work Days richiede un dipendente già presente nello stesso cantiere:
questo endpoint importa una sola famiglia per volta, quindi Employees va applicato
prima. Daily Log usa sempre il turno day e rifiuta date duplicate. Gli stati
Deviation accettati sono solo 01, 03, 04, 05, 06 con le etichette previste; 02 resta
`UNKNOWN_STATUS`.

## Verifica e limiti

Le fixture XLSX dei test sono costruite in memoria con dati sintetici. I test
comprendono SQLite, PostgreSQL in memoria (PGlite), il driver pg quando configurato,
listener HTTP e un test con socket reale. Un errore EPERM sul socket nella sandbox
è un test fallito da ripetere sull'host, non un motivo per saltarlo.

Il lettore XLSX esistente rimane invariato e legge il workbook in memoria.
Il parser sostituisce le righe lette con quelle normalizzate, senza creare una
seconda collezione completa; il diff legge il DB a pagine di 500 e conserva solo
chiavi, ID e hash, con esempi limitati. Non si tratta di streaming ZIP/XML completo:
il limite di 20 MiB riguarda il file compresso e il lettore non impone un limite
all'espansione ZIP. Anche prestazioni e memoria su export di grandi dimensioni
vanno verificate sull'host. Gli apply archiviano il file nel DB e comportano
scritture per riga; capacità e conservazione degli archivi richiedono valutazione
operativa, senza introdurre cancellazioni automatiche.

L'accettazione richiede ancora il confronto con gli header e i campioni autorizzati
sull'host, la suite completa e il test sul vero PostgreSQL. Nessun campione reale
è incluso o cercato nel checkout.
