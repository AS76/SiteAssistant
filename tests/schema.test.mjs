import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';

const db = new PGlite();
await db.exec(await readFile(new URL('../database/import-schema.sql', import.meta.url), 'utf8'));
after(async () => db.close());

async function scope() {
  const id = randomUUID();
  await db.query('INSERT INTO ingest.scopes(id,organization_id,source_system_key,project_reference) VALUES ($1,$2,$3,$4)',
    [id, randomUUID(), 'synthetic-source', randomUUID()]);
  return id;
}
async function batch(scopeId, family, size = 2) {
  const id = randomUUID();
  const hash = createHash('sha256').update(id).digest('hex');
  await db.query(`INSERT INTO ingest.import_batches(id,scope_id,family,profile_version,source_file_name,content_sha256,file_size_bytes,source_sheet,source_headers,expected_rows,status)
    VALUES ($1,$2,$3,'synthetic-v1','synthetic-input.json',$4,0,'Example','[]'::jsonb,$5,'staging')`, [id, scopeId, family, hash, size]);
  return { id, scopeId, family, hash };
}
async function raw(b, row = 2, payload = { example: true }) {
  await db.query('INSERT INTO ingest.raw_rows(batch_id,scope_id,source_row,payload,row_fingerprint) VALUES ($1,$2,$3,$4::jsonb,$5)',
    [b.id, b.scopeId, row, JSON.stringify(payload), 'f'.repeat(64)]);
}
async function identity(scopeId, family, key) {
  await db.query("INSERT INTO ingest.entity_keys(id,scope_id,family,external_key,identity_state) VALUES ($1,$2,$3,$4,'observed')",
    [randomUUID(), scopeId, family, key]);
}
async function employee(b, number = 'EMP-DEMO-01', company = 'Example Company A') {
  await raw(b);
  await identity(b.scopeId, 'employees', number);
  await db.query(`INSERT INTO source_snapshot.employees(_batch_id,_source_row,_scope_id,_identity_key,employee_no,first_name,last_name,company)
    VALUES ($1,2,$2,$3,$3,'Example','Person',$4)`, [b.id, b.scopeId, number, company]);
}
const code = expected => error => error.code === expected;

test('all six source families and ingestion/reporting tables are created', async () => {
  const result = await db.query("SELECT table_name FROM information_schema.tables WHERE table_schema='source_snapshot' ORDER BY table_name");
  assert.deepEqual(result.rows.map(row => row.table_name), ['daily_logs', 'deviations', 'employees', 'site_progress_items', 'time_schedule', 'work_days']);
  const views = await db.query("SELECT table_name FROM information_schema.views WHERE table_schema='reporting'");
  assert.equal(views.rows.length, 7);
});

test('work-day identity links to an employee while retaining historical attributes', async () => {
  const s = await scope();
  const e = await batch(s, 'employees');
  await employee(e);
  const w = await batch(s, 'work_days');
  await raw(w);
  const id = randomUUID(); await identity(s, 'work_days', id);
  await db.query(`INSERT INTO source_snapshot.work_days(_batch_id,_source_row,_scope_id,_identity_key,source_uuid,employee_no,operational_date,company)
    VALUES ($1,2,$2,$3::text,$3::text::uuid,'EMP-DEMO-01','2024-01-01','Example Company B')`, [w.id, s, id]);
  const result = await db.query(`SELECT w.company AS historical,e.company AS master FROM source_snapshot.work_days w
    JOIN source_snapshot.employees e ON e._scope_id=w._scope_id AND e.employee_no=w.employee_no WHERE w._batch_id=$1`, [w.id]);
  assert.deepEqual(result.rows, [{ historical: 'Example Company B', master: 'Example Company A' }]);
});

test('a work day cannot reference an unregistered employee key', async () => {
  const s = await scope(), b = await batch(s, 'work_days');
  await raw(b);
  const id = randomUUID(); await identity(s, 'work_days', id);
  await assert.rejects(db.query(`INSERT INTO source_snapshot.work_days(_batch_id,_source_row,_scope_id,_identity_key,source_uuid,employee_no)
    VALUES ($1,2,$2,$3::text,$3::text::uuid,'EMP-UNKNOWN')`, [b.id, s, id]), code('23503'));
});

test('different source logs can share an operational day', async () => {
  const s = await scope(), b = await batch(s, 'daily_logs');
  for (const row of [2, 3]) {
    await raw(b, row);
    const id = randomUUID(); await identity(s, 'daily_logs', id);
    await db.query(`INSERT INTO source_snapshot.daily_logs(_batch_id,_source_row,_scope_id,_identity_key,source_uuid,operational_date)
      VALUES ($1,$2,$3,$4::text,$4::text::uuid,'2024-01-01')`, [b.id, row, s, id]);
  }
  const result = await db.query('SELECT count(*)::integer AS n FROM source_snapshot.daily_logs WHERE _batch_id=$1', [b.id]);
  assert.equal(result.rows[0].n, 2);
});

test('identical progress rows remain distinct and missing flags remain NULL', async () => {
  const s = await scope(), b = await batch(s, 'site_progress_items');
  for (const row of [2, 3]) {
    await raw(b, row, { description: 'Synthetic example', progress: 25 });
    await db.query(`INSERT INTO source_snapshot.site_progress_items(_batch_id,_source_row,_scope_id,description,progress_pct)
      VALUES ($1,$2,$3,'Synthetic example',25)`, [b.id, row, s]);
  }
  const result = await db.query(`SELECT count(*)::integer AS n,count(has_deviations)::integer AS known_flags
    FROM source_snapshot.site_progress_items WHERE _batch_id=$1`, [b.id]);
  assert.deepEqual(result.rows[0], { n: 2, known_flags: 0 });
});

test('scope foreign keys prevent source rows from crossing contexts', async () => {
  const s = await scope(), other = await scope(), b = await batch(s, 'employees');
  await assert.rejects(db.query(`INSERT INTO ingest.raw_rows(batch_id,scope_id,source_row,payload,row_fingerprint)
    VALUES ($1,$2,2,'{}'::jsonb,'synthetic')`, [b.id, other]), code('23503'));
});

test('duplicate batch content/profile and duplicate source identity are rejected', async () => {
  const s = await scope(), b = await batch(s, 'employees');
  await employee(b);
  await assert.rejects(db.query(`INSERT INTO ingest.import_batches(id,scope_id,family,profile_version,source_file_name,content_sha256,file_size_bytes,source_sheet,source_headers,expected_rows,status)
    VALUES ($1,$2,'employees','synthetic-v1','other-name.json',$3,0,'Example','[]'::jsonb,1,'staging')`, [randomUUID(), s, b.hash]), code('23505'));
  await raw(b, 3);
  await assert.rejects(db.query(`INSERT INTO source_snapshot.employees(_batch_id,_source_row,_scope_id,_identity_key,employee_no)
    VALUES ($1,3,$2,'EMP-DEMO-01','EMP-DEMO-01')`, [b.id, s]), code('23505'));
});

test('source chronology is preserved for quality checks rather than silently rewritten', async () => {
  const s = await scope(), b = await batch(s, 'deviations'); await raw(b);
  const id = randomUUID(); await identity(s, 'deviations', id);
  await db.query(`INSERT INTO source_snapshot.deviations(_batch_id,_source_row,_scope_id,_identity_key,source_uuid,source_status,creation_date,closed_date)
    VALUES ($1,2,$2,$3::text,$3::text::uuid,'unmapped-source-state','2024-01-02 08:30','2024-01-01 17:00')`, [b.id, s, id]);
  const result = await db.query(`SELECT closed_date < creation_date AS flagged,title IS NULL AS missing_title
    FROM source_snapshot.deviations WHERE _batch_id=$1`, [b.id]);
  assert.deepEqual(result.rows[0], { flagged: true, missing_title: true });
});

test('a run cannot declare readiness without a completeness flag', async () => {
  const s = await scope();
  await assert.rejects(db.query("INSERT INTO ingest.import_runs(id,scope_id,status) VALUES ($1,$2,'ready')", [randomUUID(), s]), code('23514'));
});
