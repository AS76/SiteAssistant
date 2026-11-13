# Application planning import — increment 18

Backend implemented, without UI. Does not activate connectors, external storage or deployment.
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

`canonicalHeaders` derives from `FAMILIES` the first name of each destination field,
in definition order: for example `Progress`, `PLC-Area`, `Planned Hours`,
`Deviation Status`, `Activities` and `Delays`. Site-specific custom aliases
do not change this template; they remain accepted by import as before. Example
values are associated with destination fields, with identifiers such as
`EMP-001`, `DEV-001`, `AREA-001`, ISO dates and the text “Lavorazione di esempio”.

The `server/xlsx-write.mjs` writer generates five deflated ZIP parts with CRC32:
`[Content_Types].xml`, `_rels/.rels`, `xl/workbook.xml`,
`xl/_rels/workbook.xml.rels` and `xl/worksheets/sheet1.xml`. The single sheet
`Sheet1` contains only inline strings, without styles, formulas or shared
strings. XML special characters are escaped; TAB, LF and CR are preserved in
text. Characters forbidden by XML 1.0, which cannot be represented even
as numeric references, cause an explicit error rather than silent data
loss. The reader and import rules do not change.

Preview does not write to the database. It returns `counts` and `samples` for
`added`, `updated`, `unchanged`, `removed`, `rejected`, at most 50 examples per
category, plus `unmapped_columns`. Rejections contain the row number,
`rejected` (code) and `reason`. Valid rows include values, key and warnings.
Unrecognized columns are explicitly listed, not interpreted.

The HMAC-SHA256 token expires after 15 minutes and binds file bytes, family,
site, time zone and normalization result. It is not authorization: the role
is checked again on apply and within the transaction. Multiple processes require
configuring the same random secret `planning_IMPORT_TOKEN_SECRET` (at least 32 bytes of
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

Names are exact and case-sensitive. The implemented contract is
exposed by `FAMILIES` in `server/planning-import.mjs`. Descriptive headers not
listed in the original request require comparison with only the export headers
before acceptance on the host, especially for Daily Log.

| Family | Required columns | Other recognized columns |
| --- | --- | --- |
| Employees | Employee No | First Name, Last Name, Company, Qualification, Supervisor, Team, Hire Date, Expire Date |
| Work Days | Date, Employee No | Start Time, Finish Time, Work Time, Open Hours, Booked Hours, Status |
| Time Schedule | Time Schedule Item No | Description, PLC-Area, Section, Assigned To, Planned Start, Planned Finish, Actual Start, Actual Finish, Progress %, Sort Order, Summary Task, Planned Hours |
| Site Progress Items | Description, Planned Start, Planned Finish, PLC-Area, Section | Assigned To, Actual Start, Progress %, Planned Progress %, Delta Progress, Expected Delay, Has Files, Has Notes, Has Deviations |
| Deviations | Deviation No, Status | Title, Problem Description, Priority, Author, Assigned To, PLC-Area, Creation Date, Due Date, Approved Date, Closed Date, Actual Cost, Claim Quantity, Labor Hours, Completed Tasks % |
| Daily Log | Date | Plan, Actual, Impediments, Next Step |

Cells in required columns must be filled in, except for the optional dimensions
of the progress composite key: here only Description must be
non-empty. Other dimensions may be NULL, but headers must be present.
An absent optional column does not clear the existing field; an empty cell in a
present column produces NULL. Attendance statuses retain their original text.

Calendar dates (`hire_date`, `expire_date`, `operational_date`) and attendance
times remain DATE/TIME. Timestamps are converted to UTC from the
`Europe/Rome` time zone, the current application default: `sites` has no time-zone column.
The parsing function also accepts an explicit time zone. Ambiguous or
nonexistent DST times are rejected; fractional seconds are preserved up to six
digits. Decimal numbers with commas become Number; empty means NULL.

Progress keys normalize Unicode NFKC, spaces, case and timestamps;
the occurrence is 1-based. Subsequent occurrences have `identity_state=unresolved`
in the binding and a “Da confermare” warning, and are still imported. No
key is invented in `ingest.entity_keys`. The application `source_row` is
assigned without collisions and remains stable; the row number in the new export is
shown in preview and recoverable from the archived file.

Time Schedule derives parent and level from the code, ignores Level and imports
children without a parent in the export as roots. An ambiguous key already in the DB
requires reconciliation (`AMBIGUOUS_KEY`); children of an ambiguous parent are also
rejected. Work Days requires an employee already present in the same site:
this endpoint imports only one family at a time, so Employees must be applied
first. Daily Log always uses the day shift and rejects duplicate dates. Accepted
Deviation statuses are only 01, 03, 04, 05, 06 with the expected labels; 02 remains
`UNKNOWN_STATUS`.

## Verification and limits

Test XLSX fixtures are built in memory with synthetic data. Tests
include SQLite, in-memory PostgreSQL (PGlite), the pg driver when configured,
HTTP listeners and a test with a real socket. A socket EPERM error in the sandbox
is a failed test to rerun on the host, not a reason to skip it.

The existing XLSX reader remains unchanged and reads the workbook in memory.
The parser replaces read rows with normalized ones, without creating a
second complete collection; the diff reads the DB in pages of 500 and keeps only
keys, IDs and hashes, with limited examples. This is not full ZIP/XML streaming:
the 20 MiB limit concerns the compressed file and the reader imposes no limit
on ZIP expansion. Performance and memory on large exports
must also be verified on the host. Applies archive the file in the DB and involve
per-row writes; archive capacity and retention require operational
assessment, without introducing automatic deletions.

Acceptance still requires comparison with authorized headers and samples
on the host, the full suite and the test on real PostgreSQL. No real sample
is included or searched for in the checkout.
