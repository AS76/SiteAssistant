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
In the import dialog, which owners and editors can use, the “Scarica modello” button (download template) uses the selected
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
unrecognised columns are explicitly listed, not interpreted.

The HMAC-SHA256 token expires after 15 minutes and binds file bytes, family,
site, time zone and normalisation result. It is not authorisation: the role
is checked again on apply and within the transaction. Multiple processes require
configuring the same random secret `PLANNING_IMPORT_TOKEN_SECRET` (at least 32 bytes of
entropy). Without configuration, a random process secret is used: a restart
invalidates previews still open.

Apply recalculates the diff within the transaction, serialised on the site. Rejected
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
  normalises them to UTC and retains up to six fractional digits.
- Decimals accept a point or comma. `expected_delay_days` is a decimal
  number in days. `order_index` is a nonnegative 32-bit integer.
- Boolean cells accept `true`/`false`, `yes`/`no`, or `1`/`0`, regardless of case.
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

Progress keys normalise Unicode NFKC, spaces, case and timestamps;
the occurrence is 1-based. Subsequent occurrences have `identity_state=unresolved`
in the binding and a “Da confermare” (to be confirmed) warning, and are still imported. No
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
The parser replaces read rows with normalised ones, without creating a
second complete collection; the diff reads the DB in pages of 500 and keeps only
keys, IDs and hashes, with limited examples. This is not full ZIP/XML streaming:
the 20 MiB limit concerns the compressed file and the reader imposes no limit
on ZIP expansion. Performance and memory on large exports
must also be verified on the host. Applies archive the file in the DB and involve
per-row writes; archive capacity still requires operational assessment.

## Payload retention — increment 31

Keeping the original file is a **forensic capability, not a functional dependency**
of the import: to reapply it, the client must send the file again; the HMAC token
binds the bytes, the family, the site and the rows, and apply recalculates the diff
within the transaction. After the payload is removed, `file_sha256`, `filename`,
`family`, `site_id`, `created_by`, `created_at`, `counts_json`, `applied_keys_json`,
the receipt rows and the bindings remain. **Hash and metadata do not allow the file to be reconstructed.**

The versioned policy is in `config/import-retention.json`: global default 90 days,
`employees` and `work_days` 30 days, no minimum number of recent imports to keep.
The effective window is the minimum between the global default, the site override
(`site_overrides`, with UUID, `days` and `reason`) if present, and the family override
if present. A more specific window cannot extend the more restrictive one:
a site override of 90 days leaves `employees` and `work_days` at 30 days.
Days are whole numbers from 1 to `max_days`, which cannot exceed the ordinary
maximum of 90 days.

Only a justified and approved exception can protect data beyond the ordinary window:
each item in `exceptions` requires a non-empty `site_id`, `until` (ISO date),
`reason` and `approved_by`. `family` is optional: if absent it protects
all families of the site; if present it must be known and limits the protection
to the site/family pair. Several applicable active reasons are reported together.
`until` is exclusive, at 00:00 UTC of the stated day. A formally valid exception
with `until <= now` is expired: it remains valid but does not protect.
Missing or unreadable dates, empty reasons or approvals, unknown families
and unrecognised fields block the operation. Only a missing policy file
uses the code defaults (90/30).

Classification considers only receipts with `file_data IS NOT NULL`:

- `expired`: age strictly greater than the policy window;
- `deletable`: expired without an active exception;
- `excluded`: expired but protected by an exception, printed with ID and reason.

So `expired = deletable + excluded`: expired does not mean deletable.
The result includes `exceptionCounts` with `active`, `expired` and `malformed`,
counted across the whole policy, even without matching receipts. `malformed` is
always zero in results: validation blocks malformed exceptions before the transaction
and any `UPDATE`.
A window is a number of 24-hour periods from the `created_at` instant; at the exact
limit the file is not yet expired. Timestamps must have an explicit time zone.

The command is manual only, with no scheduler, timer or automatic hooks:

```sh
npm run retention -- --dry-run --from 2026-11-26
```

The dry run is the default. `--from YYYY-MM-DD` fixes the reference at 00:00 UTC
on the given date. If omitted, the start instant of the command applies. The command
requires an already prepared database, indicated by `DATA_DIR` for SQLite or by
`DB_DRIVER=pg` and `DATABASE_URL` for PostgreSQL.

**On real data, Product Owner approval is required before using `--apply`.**

```sh
npm run retention -- --apply --from 2026-11-26
```

The apply runs exclusively `UPDATE planning_import_runs SET file_data = NULL`
on the `deletable` receipts, within a transaction and with `RETURNING`. Receipts,
metadata and bindings remain available. Both modes report the UTC reference, the
overall counts, the counts per family and the detail per window if the family uses
more than one. The apply report is printed after commit and reports the candidates
classified in the same transaction. `bytesFreed` counts the bytes of the zeroed
payloads and is zero in the dry run. `--json` adds a final JSON line with the same
counters and the list `excluded: [{id, reason}]`. Subsequent runs examine only
receipts that still contain a payload.
