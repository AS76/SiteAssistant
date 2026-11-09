import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { SqliteStorage } from '../../server/storage/sqlite.mjs';
import { translatePlaceholders } from '../../server/storage/pg.mjs';
import { migrate } from '../../server/migrations/index.mjs';

export async function wbsDatabase(t, driver) {
  let db;
  if (driver === 'sqlite') {
    db = new SqliteStorage(':memory:');
    t.after(() => db.close());
    await db.exec('PRAGMA foreign_keys = ON');
  } else {
    const pg = new PGlite();
    t.after(() => pg.close());
    const adapt = connection => ({
      exec: sql => connection.exec(sql),
      all: async (sql, ...values) => (await connection.query(translatePlaceholders(sql), values)).rows,
      get: async (sql, ...values) => (await connection.query(translatePlaceholders(sql), values)).rows[0],
      run: async (sql, ...values) => ({ rowCount: (await connection.query(translatePlaceholders(sql), values)).affectedRows }),
      isUniqueViolation: error => error.code === '23505',
    });
    db = { ...adapt(pg), transaction: fn => pg.transaction(tx => fn(adapt(tx))) };
  }
  await migrate(db, { driver });
  if (driver === 'pg') await db.exec(await readFile(new URL('../../database/import-schema.sql', import.meta.url), 'utf8'));
  else await attachSyntheticIngestion(db);
  return db;
}

// Test-only SQLite equivalent of the relevant canonical ingestion tables.
// Runtime databases attach separately prepared ingestion files under these names.
export async function attachSyntheticIngestion(db) {
  await db.exec(`ATTACH DATABASE ':memory:' AS ingest; ATTACH DATABASE ':memory:' AS source_snapshot;
    CREATE TABLE ingest.scopes (id TEXT PRIMARY KEY, organization_id TEXT, source_system_key TEXT, project_reference TEXT);
    CREATE TABLE ingest.import_runs (id TEXT PRIMARY KEY, scope_id TEXT, status TEXT, completeness_verified BOOLEAN,
      source_timezone TEXT, declared_export_date TEXT);
    CREATE TABLE ingest.import_batches (id TEXT PRIMARY KEY, scope_id TEXT, family TEXT, profile_version TEXT,
      source_file_name TEXT, content_sha256 TEXT, file_size_bytes INTEGER, source_sheet TEXT, source_headers TEXT,
      expected_rows INTEGER, status TEXT);
    CREATE TABLE ingest.run_batches (run_id TEXT, batch_id TEXT, scope_id TEXT, family TEXT, PRIMARY KEY (run_id, family));
    CREATE TABLE ingest.entity_keys (id TEXT PRIMARY KEY, scope_id TEXT, family TEXT, external_key TEXT, identity_state TEXT);
    CREATE TABLE ingest.raw_rows (batch_id TEXT, scope_id TEXT, source_row INTEGER, payload TEXT, row_fingerprint TEXT);
    CREATE TABLE source_snapshot.time_schedule (_batch_id TEXT, _scope_id TEXT, _source_row INTEGER, _identity_key TEXT,
      source_uuid TEXT, project_plan TEXT, wbs_code TEXT, description TEXT, level INTEGER, sort_order INTEGER,
      summary_task BOOLEAN, progress_pct NUMERIC, planned_start TEXT, planned_finish TEXT, actual_start TEXT,
      actual_finish TEXT, planned_hours NUMERIC, section TEXT, plc_area TEXT, assigned_to TEXT);`);
}

export const syntheticWbs = () => [
  { wbs_code: '1', level: 0, sort_order: 1, description: 'Synthetic root', summary_task: true },
  { wbs_code: '1.1', level: 1, sort_order: 4, description: 'Synthetic work', summary_task: false, progress_pct: 0,
    planned_start: '2026-01-15 08:30:00', planned_finish: '2026-01-16 16:30:00', planned_hours: 0 },
  { wbs_code: '1.2', level: 1, sort_order: 2 },
  { wbs_code: '1.1.1', level: 2, sort_order: 5 },
  { wbs_code: '4.2.1', level: 2, sort_order: 9 },
  { wbs_code: 'ORPHAN', level: 3, sort_order: null },
];

export async function wbsSource(db, site, rows = syntheticWbs(), { scopeId = randomUUID(), zone = 'Europe/Rome' } = {}) {
  const runId = randomUUID(), batchId = randomUUID();
  if (!await db.get('SELECT id FROM ingest.scopes WHERE id = ?', scopeId)) {
    await db.run('INSERT INTO ingest.scopes (id, organization_id, source_system_key, project_reference) VALUES (?, ?, ?, ?)',
      scopeId, randomUUID(), 'synthetic-source', randomUUID());
  }
  await db.run(`INSERT INTO ingest.import_runs (id, scope_id, status, completeness_verified, source_timezone, declared_export_date)
    VALUES (?, ?, 'ready', TRUE, ?, '2026-01-15')`, runId, scopeId, zone);
  await db.run(`INSERT INTO ingest.import_batches (id, scope_id, family, profile_version, source_file_name, content_sha256,
    file_size_bytes, source_sheet, source_headers, expected_rows, status)
    VALUES (?, ?, 'time_schedule', 'synthetic-v1', 'synthetic.json', ?, 0, 'Synthetic', '[]', ?, 'typed')`,
  batchId, scopeId, batchId.replaceAll('-', '').repeat(2), rows.length);
  await db.run("INSERT INTO ingest.run_batches VALUES (?, ?, ?, 'time_schedule')", runId, batchId, scopeId);
  const stored = [];
  for (const [index, input] of rows.entries()) {
    const row = { ...input, source_uuid: input.source_uuid ?? randomUUID() };
    const identity = await db.get("SELECT id FROM ingest.entity_keys WHERE scope_id = ? AND family = 'time_schedule' AND external_key = ?", scopeId, row.source_uuid);
    if (!identity) await db.run("INSERT INTO ingest.entity_keys VALUES (?, ?, 'time_schedule', ?, 'observed')", randomUUID(), scopeId, row.source_uuid);
    await db.run("INSERT INTO ingest.raw_rows (batch_id, scope_id, source_row, payload, row_fingerprint) VALUES (?, ?, ?, '{}', 'synthetic')", batchId, scopeId, index + 2);
    const keys = ['source_uuid', 'project_plan', 'wbs_code', 'description', 'level', 'sort_order', 'progress_pct',
      'planned_start', 'planned_finish', 'actual_start', 'actual_finish', 'planned_hours', 'section', 'plc_area', 'assigned_to'];
    await db.run(`INSERT INTO source_snapshot.time_schedule (_batch_id, _scope_id, _source_row, _identity_key,
      ${keys.join(', ')}, summary_task) VALUES (?, ?, ?, ?, ${keys.map(() => '?').join(', ')}, ${row.summary_task == null ? 'NULL' : row.summary_task ? 'TRUE' : 'FALSE'})`,
    batchId, scopeId, index + 2, row.source_uuid, ...keys.map(key => row[key] ?? null));
    stored.push(row);
  }
  await db.run(`INSERT INTO wbs_import_sources (site_id, scope_id, run_id) VALUES (?, ?, ?)
    ON CONFLICT (site_id) DO UPDATE SET scope_id = excluded.scope_id, run_id = excluded.run_id`, site.id, scopeId, runId);
  return { scopeId, runId, batchId, rows: stored };
}
