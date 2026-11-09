import { randomUUID } from 'node:crypto';
import { wbsDatabase } from './wbs.mjs';

export async function siteProgressDatabase(t, driver) {
  const db = await wbsDatabase(t, driver);
  if (driver === 'sqlite') await db.exec(`
    CREATE TABLE source_snapshot.site_progress_items (
      _batch_id TEXT, _source_row INTEGER, _scope_id TEXT, _family TEXT DEFAULT 'site_progress_items', _identity_key TEXT,
      has_files INTEGER, has_notes INTEGER, delta_progress_source NUMERIC, has_deviations INTEGER,
      plc_area TEXT, section TEXT, description TEXT, progress_pct NUMERIC, planned_progress_pct NUMERIC,
      assigned_to TEXT, planned_start TEXT, planned_finish TEXT, actual_start TEXT, expected_delay_raw TEXT,
      PRIMARY KEY (_batch_id, _source_row));
    ATTACH DATABASE ':memory:' AS internal_work;
    CREATE TABLE internal_work.record_annotations (
      id TEXT PRIMARY KEY, scope_id TEXT NOT NULL, entity_key_id TEXT NOT NULL, author_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, note_text TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0));`);
  return db;
}

export const syntheticSiteProgress = () => [
  { description: 'Synthetic unique work', section: 'Unique', plc_area: 'Area A', progress_pct: 0,
    planned_progress_pct: 25, delta_progress_source: -25, assigned_to: 'Synthetic team',
    planned_start: '2026-01-15 08:30:00', planned_finish: '2026-07-15 16:30:00',
    actual_start: '2026-01-15 09:00:00', expected_delay_raw: 'Synthetic delay text',
    has_files: true, has_notes: false, has_deviations: true },
  { description: 'Synthetic missing work', section: 'Missing', progress_pct: 100,
    has_files: false, has_notes: true, has_deviations: false },
  { description: 'Synthetic ambiguous work', section: 'Ambiguous' },
  { description: 'Synthetic unclassified work' },
  { description: 'Synthetic ancestor only', section: 'Synthetic only', plc_area: 'Area S' },
  { description: 'Synthetic area only', plc_area: 'Area A' },
  { description: 'Synthetic section only', section: 'Unique' },
  { description: 'Synthetic conflicting dimensions', section: 'Unique', plc_area: 'Area B' },
];

// These exports have no stable identity: fixture creation deliberately creates no entity keys.
export async function siteProgressSource(db, site, rows = syntheticSiteProgress(), { scopeId = randomUUID(), zone = 'Europe/Rome' } = {}) {
  const runId = randomUUID(), batchId = randomUUID();
  if (!await db.get('SELECT id FROM ingest.scopes WHERE id = ?', scopeId)) await db.run(
    'INSERT INTO ingest.scopes (id, organization_id, source_system_key, project_reference) VALUES (?, ?, ?, ?)',
    scopeId, randomUUID(), 'synthetic-source', randomUUID());
  await db.run(`INSERT INTO ingest.import_runs (id, scope_id, status, completeness_verified, source_timezone, declared_export_date)
    VALUES (?, ?, 'ready', TRUE, ?, '2026-01-15')`, runId, scopeId, zone);
  await db.run(`INSERT INTO ingest.import_batches (id, scope_id, family, profile_version, source_file_name, content_sha256,
    file_size_bytes, source_sheet, source_headers, expected_rows, status)
    VALUES (?, ?, 'site_progress_items', 'synthetic-v1', 'synthetic.json', ?, 0, 'Synthetic', '[]', ?, 'typed')`,
  batchId, scopeId, batchId.replaceAll('-', '').repeat(2), rows.length);
  await db.run("INSERT INTO ingest.run_batches VALUES (?, ?, ?, 'site_progress_items')", runId, batchId, scopeId);
  const fields = ['description', 'plc_area', 'section', 'progress_pct', 'planned_progress_pct', 'delta_progress_source',
    'assigned_to', 'planned_start', 'planned_finish', 'actual_start', 'expected_delay_raw'];
  const flags = ['has_files', 'has_notes', 'has_deviations'];
  for (const [index, row] of rows.entries()) {
    const sourceRow = row.source_row ?? index + 2;
    await db.run("INSERT INTO ingest.raw_rows (batch_id, scope_id, source_row, payload, row_fingerprint) VALUES (?, ?, ?, '{}', 'synthetic')", batchId, scopeId, sourceRow);
    await db.run(`INSERT INTO source_snapshot.site_progress_items (_batch_id, _scope_id, _source_row, _identity_key,
      ${fields.join(', ')}, ${flags.join(', ')}) VALUES (?, ?, ?, NULL, ${fields.map(() => '?').join(', ')},
      ${flags.map(field => row[field] == null ? 'NULL' : row[field] ? 'TRUE' : 'FALSE').join(', ')})`,
    batchId, scopeId, sourceRow, ...fields.map(field => row[field] ?? null));
  }
  await db.run(`INSERT INTO site_progress_import_sources (site_id, scope_id, run_id) VALUES (?, ?, ?)
    ON CONFLICT (site_id) DO UPDATE SET scope_id = excluded.scope_id, run_id = excluded.run_id`, site.id, scopeId, runId);
  return { scopeId, runId, batchId, rows };
}
