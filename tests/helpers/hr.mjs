import { randomUUID } from 'node:crypto';
import { wbsDatabase } from './wbs.mjs';

export async function hrDatabase(t, driver) {
  const db = await wbsDatabase(t, driver);
  if (driver === 'sqlite') await db.exec(`
    CREATE TABLE source_snapshot.employees (_batch_id TEXT, _scope_id TEXT, _source_row INTEGER, _identity_key TEXT,
      employee_no TEXT, first_name TEXT, last_name TEXT, company TEXT, qualification TEXT, supervisor TEXT, team TEXT,
      hire_date TEXT, expire_date TEXT);
    CREATE TABLE source_snapshot.work_days (_batch_id TEXT, _scope_id TEXT, _source_row INTEGER, _identity_key TEXT,
      source_uuid TEXT, employee_no TEXT, operational_date TEXT, start_time TEXT, finish_time TEXT,
      work_time_source NUMERIC, open_hours_source NUMERIC, booked_hours_source NUMERIC, source_status TEXT);`);
  return db;
}

export const syntheticEmployees = () => [
  { employee_no: 'SYN-001', first_name: 'Example', last_name: 'One', company: 'Synthetic company',
    qualification: 'Synthetic qualification', supervisor: 'Synthetic supervisor', team: 'Synthetic team',
    hire_date: '2026-01-01', expire_date: '2026-12-31' },
  { employee_no: 'SYN-002' },
];
export const syntheticWorkDays = () => [
  { employee_no: 'SYN-001', operational_date: '2026-01-15', start_time: '06:00:00', finish_time: '17:59:59',
    work_time_source: 0, open_hours_source: 2.25, booked_hours_source: 7.125, source_status: 'synthetic-source-state' },
  { employee_no: 'SYN-002', operational_date: '2026-01-16', start_time: '18:00:00', finish_time: '05:59:59.123456' },
  { employee_no: 'SYN-001', operational_date: '2026-01-16', start_time: '05:59:59', finish_time: null },
  { employee_no: 'SYN-001', operational_date: '2026-01-17', start_time: '17:59:59', finish_time: '18:00:00' },
  { employee_no: 'SYN-002', operational_date: '2026-01-18', start_time: null, finish_time: '12:00:00' },
  { employee_no: null, operational_date: '2026-01-19', start_time: '00:00:00', finish_time: '01:00:00' },
];

export async function hrSource(db, site, { scopeId = randomUUID(), employees = syntheticEmployees(), workDays = syntheticWorkDays() } = {}) {
  const runId = randomUUID(), batches = {}, stored = {};
  if (!await db.get('SELECT id FROM ingest.scopes WHERE id = ?', scopeId)) await db.run(
    'INSERT INTO ingest.scopes (id, organization_id, source_system_key, project_reference) VALUES (?, ?, ?, ?)',
    scopeId, randomUUID(), 'synthetic-source', randomUUID());
  await db.run(`INSERT INTO ingest.import_runs (id, scope_id, status, completeness_verified)
    VALUES (?, ?, 'ready', TRUE)`, runId, scopeId);
  for (const [family, rows] of [['employees', employees], ['work_days', workDays]]) {
    const batchId = randomUUID(); batches[family] = batchId; stored[family] = [];
    await db.run(`INSERT INTO ingest.import_batches (id, scope_id, family, profile_version, source_file_name, content_sha256,
      file_size_bytes, source_sheet, source_headers, expected_rows, status)
      VALUES (?, ?, ?, 'synthetic-v1', 'synthetic.json', ?, 0, 'Synthetic', '[]', ?, 'typed')`,
    batchId, scopeId, family, batchId.replaceAll('-', '').repeat(2), rows.length);
    await db.run('INSERT INTO ingest.run_batches VALUES (?, ?, ?, ?)', runId, batchId, scopeId, family);
    for (const [index, input] of rows.entries()) {
      const row = family === 'employees' ? { ...input } : { ...input, source_uuid: input.source_uuid ?? randomUUID() };
      const identity = family === 'employees' ? row.employee_no : row.source_uuid;
      if (!await db.get('SELECT id FROM ingest.entity_keys WHERE scope_id = ? AND family = ? AND external_key = ?', scopeId, family, identity)) {
        await db.run("INSERT INTO ingest.entity_keys VALUES (?, ?, ?, ?, 'observed')", randomUUID(), scopeId, family, identity);
      }
      await db.run("INSERT INTO ingest.raw_rows (batch_id, scope_id, source_row, payload, row_fingerprint) VALUES (?, ?, ?, '{}', 'synthetic')", batchId, scopeId, index + 2);
      const fields = Object.keys(row);
      await db.run(`INSERT INTO source_snapshot.${family} (_batch_id, _scope_id, _source_row, _identity_key, ${fields.join(', ')})
        VALUES (?, ?, ?, ?, ${fields.map(() => '?').join(', ')})`, batchId, scopeId, index + 2, identity, ...Object.values(row));
      stored[family].push(row);
    }
  }
  await db.run(`INSERT INTO hr_import_sources (site_id, scope_id, run_id) VALUES (?, ?, ?)
    ON CONFLICT (site_id) DO UPDATE SET scope_id = excluded.scope_id, run_id = excluded.run_id`, site.id, scopeId, runId);
  return { scopeId, runId, batches, employees: stored.employees, workDays: stored.work_days };
}
