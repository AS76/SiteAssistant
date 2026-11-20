import { randomUUID } from 'node:crypto';
import { wbsDatabase } from './wbs.mjs';

export async function deviationsDatabase(t, driver) {
  const db = await wbsDatabase(t, driver);
  if (driver === 'sqlite') await db.exec(`CREATE TABLE source_snapshot.deviations (
    _batch_id TEXT, _scope_id TEXT, _source_row INTEGER, _identity_key TEXT,
    source_uuid TEXT, deviation_no TEXT, title TEXT, problem_description TEXT, source_status TEXT,
    priority TEXT, author TEXT, assigned_to TEXT, plc_area TEXT,
    creation_date TEXT, due_date TEXT, approved_date TEXT, closed_date TEXT,
    actual_cost NUMERIC, claim_quantity NUMERIC, labor_hours NUMERIC, completed_tasks_pct NUMERIC,
    PRIMARY KEY (_batch_id, _source_row));`);
  return db;
}

export const syntheticDeviations = () => [
  ' Open ', 'APPROVED', 'in_progress', 'work_completed', 'closed', 'rejected',
  ' Work In Progress ', 'work completed', 'completed', 'refused', 'in progress',
  'unmapped synthetic state', '', null,
].map((source_status, index) => ({
  deviation_no: `SYN-${String(index + 1).padStart(2, '0')}`, title: 'Synthetic deviation', source_status,
  priority: index % 2 ? 'normal' : 'high',
  ...(index === 0 ? { problem_description: 'Synthetic description', author: 'Example author',
    assigned_to: 'Example team', plc_area: 'Area A', creation_date: '2026-01-15 08:30:00',
    due_date: '2026-07-15 16:30:00', approved_date: '2026-01-16 09:00:00',
    closed_date: '2026-07-16 16:30:00', actual_cost: 0, claim_quantity: 2.5,
    labor_hours: 7.25, completed_tasks_pct: 100 } : {}),
}));

export async function deviationsSource(db, site, rows = syntheticDeviations(), { scopeId = randomUUID(), zone = 'Europe/Rome' } = {}) {
  const runId = randomUUID(), batchId = randomUUID();
  if (!await db.get('SELECT id FROM ingest.scopes WHERE id = ?', scopeId)) await db.run(
    'INSERT INTO ingest.scopes (id, organization_id, source_system_key, project_reference) VALUES (?, ?, ?, ?)',
    scopeId, randomUUID(), 'synthetic-source', randomUUID());
  await db.run(`INSERT INTO ingest.import_runs (id, scope_id, status, completeness_verified, source_timezone, declared_export_date)
    VALUES (?, ?, 'ready', TRUE, ?, '2026-01-15')`, runId, scopeId, zone);
  await db.run(`INSERT INTO ingest.import_batches (id, scope_id, family, profile_version, source_file_name, content_sha256,
    file_size_bytes, source_sheet, source_headers, expected_rows, status)
    VALUES (?, ?, 'deviations', 'synthetic-v1', 'synthetic.json', ?, 0, 'Synthetic', '[]', ?, 'typed')`,
  batchId, scopeId, batchId.replaceAll('-', '').repeat(2), rows.length);
  await db.run("INSERT INTO ingest.run_batches VALUES (?, ?, ?, 'deviations')", runId, batchId, scopeId);
  const fields = ['source_uuid', 'deviation_no', 'title', 'problem_description', 'source_status', 'priority',
    'author', 'assigned_to', 'plc_area', 'creation_date', 'due_date', 'approved_date', 'closed_date',
    'actual_cost', 'claim_quantity', 'labor_hours', 'completed_tasks_pct'];
  const stored = [];
  for (const [index, input] of rows.entries()) {
    const row = { ...input, source_uuid: input.source_uuid ?? randomUUID(), source_row: input.source_row ?? index + 2 };
    const key = await db.get("SELECT id FROM ingest.entity_keys WHERE scope_id = ? AND family = 'deviations' AND external_key = ?", scopeId, row.source_uuid);
    if (!key) await db.run("INSERT INTO ingest.entity_keys VALUES (?, ?, 'deviations', ?, ?)",
      randomUUID(), scopeId, row.source_uuid, row.identity_state ?? 'observed');
    await db.run("INSERT INTO ingest.raw_rows (batch_id, scope_id, source_row, payload, row_fingerprint) VALUES (?, ?, ?, '{}', 'synthetic')", batchId, scopeId, row.source_row);
    await db.run(`INSERT INTO source_snapshot.deviations (_batch_id, _scope_id, _source_row, _identity_key,
      ${fields.join(', ')}) VALUES (?, ?, ?, ?, ${fields.map(() => '?').join(', ')})`,
    batchId, scopeId, row.source_row, row.source_uuid, ...fields.map(field => row[field] ?? null));
    stored.push(row);
  }
  await db.run(`INSERT INTO deviation_import_sources (site_id, scope_id, run_id) VALUES (?, ?, ?)
    ON CONFLICT (site_id) DO UPDATE SET scope_id = excluded.scope_id, run_id = excluded.run_id,
      updated_at = CURRENT_TIMESTAMP`, site.id, scopeId, runId);
  return { scopeId, runId, batchId, rows: stored };
}
