# Application planning import — increment 18

The application provides an import dialog and authenticated API routes.
Migration **015**, for SQLite and PostgreSQL, adds `planning_import_runs` and
`planning_import_keys`; it does not change previous migrations or ingestion schemas.
Its presence in the checkout does not mean it has been applied in production.

## API

Only site `owner` and `editor` can use these authenticated routes:

- `POST /api/import/preview`: JSON with `site_id`, `family`, `filename`, `data_base64`.
- `POST /api/import/apply`: same JSON, plus `preview_token` returned by the preview.

`family` accepts `employees`, `work_days`, `time_schedule`,
`site_progress_items`, `deviations`, `daily_log`. Only the first sheet is read.
The decoded file cannot exceed 20 MiB; the HTTP limit includes base64
expansion and a limited margin for metadata. The file name is descriptive, never a path.

### Downloadable template — increment 31

`GET /api/import/template?family=<family>` returns a generic XLSX with
canonical headers and a single synthetic example row. It requires only a
valid session: viewers and verifiers can also download it through the API, without
`site_id`, site membership or a module check. It reads no site
data. Without a session it returns `401 AUTH_REQUIRED`; a missing or
unknown family returns `400 UNKNOWN_FAMILY`.

The type is `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`, the
name is `SiteAssistant-<family>-modello.xlsx` and the cache is `private, no-store`.
In the import dialog, available to owner/editor, “Scarica modello” uses the selected
family. Fill in rows keeping the headers; the example row is
an importable record and must be replaced or removed before uploading your own data.
For attendance, the `EMP-001` example requires a matching employee in the
site, like any other import of this family.

`canonicalHeaders` reads the headers from `FAMILIES` in definition order.
Each template includes one synthetic record. Site-level aliases apply to
uploads and leave the public template unchanged.

The `server/xlsx-write.mjs` writer generates five deflated ZIP parts with CRC32:
`[Content_Types].xml`, `_rels/.rels`, `xl/workbook.xml`,
`xl/_rels/workbook.xml.rels` and `xl/worksheets/sheet1.xml`. The single sheet
`Sheet1` contains only inline strings, without styles, formulas or shared
strings. XML special characters are escaped; TAB, LF and CR are preserved in
text. Characters forbidden by XML 1.0, which cannot be represented even
as numeric references, cause an explicit error rather than silent data
loss.

Preview does not write to the database. It returns `counts` and `samples` for
`added`, `updated`, `unchanged`, `removed`, `rejected`, at most 50 examples per
category, plus `unmapped_columns`. Rejections contain the row number,
`rejected` (code) and `reason`. Valid rows include values, key and warnings.
Unrecognized columns are explicitly listed, not interpreted.

The HMAC-SHA256 token expires after 15 minutes and binds file bytes, family,
site, time zone and normalization result. It is not authorization: the role
is checked again on apply and within the transaction. Multiple processes require
configuring the same random secret `PLANNING_IMPORT_TOKEN_SECRET` (at least 32 bytes of
entropy). Without configuration, a random process secret is used: a restart
invalidates previews still open.

Apply recalculates the diff within the transaction, serialized on the site. Rejected
rows remain excluded; the others are applied. It returns `counts`,
`applied_keys` (only added/updated) and `import_run_id`. The applied
`removed` count is always zero: no rows are deleted. A second apply of the
same file produces zero changes to application records, with a new receipt
for the attempt. Concurrent changes made after preview may
change the final counts.

Each apply preserves the original file, hash, author, outcome and
modified keys in the new table. The binding records identity, latest run and timestamp. Existing
application relationships are preserved; updated records retain
IDs and `created_at`. Current destination tables have no `updated_at`:
the update is tracked in the binding and run. This data remains in the application
database; it is not sent to snapshot ingestion.

## Column contract

Headers are case-sensitive and listed in `FAMILIES` in `server/planning-import.mjs`.

| Family | Required headers | Optional headers |
| --- | --- | --- |
| `employees` | `employee_id` | `given_name`, `family_name`, `organisation`, `role`, `supervisor_id`, `team`, `start_date`, `end_date` |
| `work_days` | `work_date`, `employee_id` | `start_time`, `end_time`, `hours_worked`, `hours_open`, `hours_booked`, `attendance_status` |
| `time_schedule` | `item_id` | `title`, `area_code`, `section`, `assignee`, `planned_start`, `planned_finish`, `actual_start`, `actual_finish`, `progress_percent`, `order_index`, `is_summary`, `planned_hours` |
| `site_progress_items` | `title`, `planned_start`, `planned_finish`, `area_code`, `section` | `assignee`, `actual_start`, `progress_percent`, `planned_progress_percent`, `progress_delta`, `expected_delay_days`, `has_files`, `has_notes`, `has_deviations`, `planned_hours` |
| `deviations` | `deviation_id`, `status` | `title`, `description`, `priority`, `author`, `assignee`, `area_code`, `created_at`, `due_at`, `approved_at`, `closed_at`, `actual_cost`, `claim_quantity`, `labour_hours`, `completed_percent` |
| `daily_log` | `log_date` | `plan`, `actual`, `impediments`, `next_step` |

The required headers define the default identity in the order shown, except
that the deviation identity uses only `deviation_id`. Required cells must
be filled in. For progress, only `title` must have a value and the other key
components may be null. An absent optional column leaves the stored value
unchanged. An empty cell in a present optional column sets the field to null.

- Dates use `YYYY-MM-DD`. Attendance times use `HH:MM` or `HH:MM:SS`.
- Timestamps use ISO 8601 with seconds and an explicit offset, for example
  `2026-11-01T08:00:00+01:00` or `2026-11-01T07:00:00Z`. The importer
  normalizes them to UTC and retains up to six fractional digits.
- Decimals accept a point or comma. `expected_delay_days` is a decimal
  number in days. `order_index` is a nonnegative 32-bit integer.
- Boolean cells accept `true`/`false`, `yes`/`no`, or `1`/`0`, irrespective of case.
- Text is trimmed. Blank values become null. `attendance_status` is free text.
- Deviation `status` accepts `open`, `in_progress`, `completed`, `closed`, and
  `rejected` after trimming and lowercasing. Other values produce `UNKNOWN_STATUS`.
  `completed` is stored using the existing internal state `work_completed`.

Owners and editors can configure aliases and an ordered row identity at runtime
for each site and family. Mapping API keys identify destination fields.
Canonical headers remain available with a saved mapping. Conflicting nonempty
values for one field yield `AMBIGUOUS_COLUMNS`. A change to the effective
mapping invalidates the preview token. The default alias list is empty.

The deviation evidence upload at `POST /api/deviations/import` uses the same
deviation fields and adds the `source_id` metadata column for stable historical
tracking. The ordinary six-family template is for preview/apply.

Progress keys normalize Unicode NFKC, spaces, case and timestamps;
the occurrence is 1-based. Subsequent occurrences have `identity_state=unresolved`
in the binding and a “Da confermare” warning, and are still imported. No
key is invented in `ingest.entity_keys`. The application `source_row` is
assigned without collisions and remains stable; the row number in the new export is
shown in preview and recoverable from the archived file while its payload is retained.

Time Schedule derives parent and level from the dotted `item_id` and imports
children without a known parent as roots. An ambiguous key already in the DB
requires reconciliation (`AMBIGUOUS_KEY`); children of an ambiguous parent are also
rejected. Work Days requires an employee already present in the same site:
this endpoint imports only one family at a time, so Employees must be applied
first. Daily Log always uses the day shift and rejects duplicate dates.

## Verification and limits

Test XLSX fixtures are built in memory with synthetic data. Tests
include SQLite, the PostgreSQL driver when configured,
HTTP listeners and a test with a real socket. A socket EPERM error in the sandbox
is a failed test to rerun on the host, not a reason to skip it.

The existing XLSX reader remains unchanged and reads the workbook in memory.
The parser replaces read rows with normalized ones, without creating a
second complete collection; the diff reads the DB in pages of 500 and keeps only
keys, IDs and hashes, with limited examples. This is not full ZIP/XML streaming:
the 20 MiB limit concerns the compressed file and the reader imposes no limit
on ZIP expansion. Performance and memory on large exports
must also be verified on the host. Applies archive the file in the DB and involve
per-row writes; archive capacity still requires operational assessment.

## Payload retention — increment 31

Conservare il file originale è una **capacità forense, non una dipendenza funzionale**
dell'import: per riapplicarlo il client deve inviare di nuovo il file; il token HMAC
vincola i byte, la famiglia, il cantiere e le righe, e l'apply ricalcola il diff
nella transazione. Dopo la rimozione del payload restano `file_sha256`, `filename`,
`family`, `site_id`, `created_by`, `created_at`, `counts_json`, `applied_keys_json`,
le righe di ricevuta e i binding. **Hash e metadati non permettono di ricostruire il file.**

La policy versionata è in `config/import-retention.json`: default globale 90 giorni,
`employees` e `work_days` 30 giorni, nessun minimo di import recenti da conservare.
La finestra effettiva è il minimo tra default globale, override di cantiere
(`site_overrides`, con UUID, `days` e `reason`) se presente e override di famiglia
se presente. Una finestra più specifica non può allungare quella più restrittiva:
un override di cantiere a 90 giorni lascia `employees` e `work_days` a 30 giorni.
I giorni sono interi da 1 al `max_days`, che non può superare il massimo ordinario
di 90 giorni.

Solo un'eccezione motivata e approvata può proteggere oltre la finestra ordinaria:
ogni elemento di `exceptions` richiede `site_id`, `until` (data ISO),
`reason` e `approved_by` non vuoti. `family` è facoltativa: se assente protegge
tutte le famiglie del cantiere; se presente deve essere nota e limita la protezione
alla coppia cantiere/famiglia. Più motivazioni attive applicabili sono riportate
insieme. `until` è esclusivo, alle 00:00 UTC del giorno indicato. Un'eccezione
formalmente valida con `until <= now` è scaduta: resta valida ma non protegge.
Date assenti o illeggibili, motivazioni o approvazioni vuote, famiglie sconosciute
e campi non riconosciuti bloccano l'operazione. Solo un file di policy assente
usa i default in codice (90/30).

La classificazione considera solo le ricevute con `file_data IS NOT NULL`:

- `expired`: età strettamente maggiore della finestra di policy;
- `deletable`: scadute senza eccezione attiva;
- `excluded`: scadute protette da eccezione, stampate con ID e motivo.

Quindi `expired = deletable + excluded`: scaduto non significa cancellabile.
Il risultato include `exceptionCounts` con `active`, `expired` e `malformed`,
contati sull'intera policy, anche senza ricevute corrispondenti. `malformed` è
sempre zero nei risultati: la validazione blocca le eccezioni malformate prima
della transazione e di qualsiasi `UPDATE`.
Una finestra è un numero di periodi di 24 ore dall'istante `created_at`; al limite
esatto il file non è ancora scaduto. I timestamp devono avere un fuso esplicito.

Il comando è esclusivamente manuale, senza scheduler, timer o hook automatici:

```sh
npm run retention -- --dry-run --from 2026-11-26
```

Il dry-run è il default. `--from YYYY-MM-DD` fissa il riferimento alle 00:00 UTC
della data indicata. Se omesso, vale l'istante di avvio del comando. Il comando
richiede un database già predisposto, indicato da `DATA_DIR` per SQLite oppure
da `DB_DRIVER=pg` e `DATABASE_URL` per PostgreSQL.

**Sui dati reali serve l'approvazione del Product Owner prima di usare `--apply`.**

```sh
npm run retention -- --apply --from 2026-11-26
```

L'apply esegue esclusivamente `UPDATE planning_import_runs SET file_data = NULL`
sui `deletable`, in transazione e con `RETURNING`. Ricevute, metadati e binding
restano disponibili. Entrambe le modalità riportano il riferimento UTC, i conteggi
complessivi, quelli per famiglia e il dettaglio per finestra se la famiglia ne
usa più di una. Il report dell'apply viene stampato dopo il commit e riporta i
candidati classificati nella stessa transazione. `bytesFreed` conta i byte dei
payload azzerati ed è zero nel dry-run. `--json` aggiunge una riga finale JSON
con gli stessi contatori e l'elenco `excluded: [{id, reason}]`. Le esecuzioni
successive esaminano solo le ricevute che contengono ancora un payload.
