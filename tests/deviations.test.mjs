import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createSite, createTask, listTasks, getTask } from '../server/repository.mjs';
import { listDeviations, getDeviation, importDeviations } from '../server/deviations.mjs';
import { stableId } from '../server/wbs.mjs';
import { createServer } from '../server/http.mjs';
import { migrate } from '../server/migrations/index.mjs';
import { authFixture, requestListener } from './helpers/auth.mjs';
import { deviationsDatabase, deviationsSource } from './helpers/deviations.mjs';

for (const driver of ['sqlite', 'pg']) test(`Deviations ${driver}: import, references and access`, async t => {
  const db = await deviationsDatabase(t, driver), auth = await authFixture(db);
  const fixture = async (rows, options) => {
    const site = await createSite(db, { code: randomUUID(), name: 'Synthetic deviations site' });
    for (const [role, user] of Object.entries(auth.users)) await db.run('INSERT INTO site_members VALUES (?, ?, ?)', site.id, user.id, role);
    return { site, ...await deviationsSource(db, site, rows, options) };
  };
  const promote = site => importDeviations(db, site.id, auth.users.owner);
  const state = site => listDeviations(db, { siteId: site.id });
  const config = site => db.get('SELECT * FROM deviation_import_sources WHERE site_id = ?', site.id);

  await t.test('normalizes all six states and aliases; counts unknown, blank and absent states without changing source data', async t => {
    const f = await fixture();
    const snapshot = await db.all('SELECT * FROM source_snapshot.deviations WHERE _batch_id = ? ORDER BY _source_row', f.batchId);
    t.assert.deepStrictEqual(await promote(f.site), { imported: 14, unchanged: false, unmapped_status: 3, run_id: f.runId });
    const rows = await state(f.site);
    const expected = ['open', 'approved', 'in_progress', 'work_completed', 'closed', 'rejected',
      'in_progress', 'work_completed', 'work_completed', 'rejected', 'in_progress', null, null, null];
    for (const [index, input] of f.rows.entries()) {
      const row = rows.find(item => item.id === stableId(f.site.id, f.scopeId, input.source_row));
      t.assert.strictEqual(row.status, expected[index]);
      for (const field of ['deviation_no', 'title', 'problem_description', 'priority', 'author', 'assigned_to', 'plc_area']) {
        t.assert.strictEqual(row[field], input[field] ?? null, field);
      }
      for (const field of ['actual_cost', 'claim_quantity', 'labor_hours', 'completed_tasks_pct']) {
        if (input[field] == null) t.assert.strictEqual(row[field], null);
        else t.assert.strictEqual(Number(row[field]), input[field]);
      }
    }
    const first = rows.find(row => row.deviation_no === 'SYN-01');
    for (const [field, expected] of [['creation_date', '2026-01-15T07:30:00.000Z'],
      ['due_date', '2026-07-15T14:30:00.000Z'], ['approved_date', '2026-01-16T08:00:00.000Z'],
      ['closed_date', '2026-07-16T14:30:00.000Z']]) {
      t.assert.strictEqual(new Date(first[field]).toISOString(), expected);
      t.assert.strictEqual(rows.find(row => row.deviation_no === 'SYN-02')[field], null);
    }
    t.assert.deepStrictEqual(await db.all('SELECT * FROM deviation_links'), []);
    t.assert.deepStrictEqual(await db.all('SELECT * FROM source_snapshot.deviations WHERE _batch_id = ? ORDER BY _source_row', f.batchId), snapshot);
    const marker = await config(f.site);
    t.assert.strictEqual(marker.promoted_run_id, f.runId); t.assert.strictEqual(marker.promoted_batch_id, f.batchId);
    for (const field of ['created_at', 'updated_at', 'promoted_at']) t.assert.ok(Number.isFinite(new Date(marker[field]).getTime()));
  });

  await t.test('repeated and concurrent imports leave IDs, rows, timestamps and markers unchanged', async t => {
    const f = await fixture(); await promote(f.site);
    const before = await state(f.site), marker = await config(f.site);
    for (const result of await Promise.all([promote(f.site), promote(f.site)])) {
      t.assert.deepStrictEqual(result, { imported: 0, unchanged: true, unmapped_status: 0, run_id: f.runId });
    }
    t.assert.deepStrictEqual(await state(f.site), before); t.assert.deepStrictEqual(await config(f.site), marker);
  });

  await t.test('new batches correct all fields and retain IDs, created_at, explicit links and absent rows', async t => {
    const f = await fixture(); await promote(f.site);
    const before = await state(f.site), old = before.find(row => row.deviation_no === 'SYN-01'), target = randomUUID();
    await db.run("INSERT INTO deviation_links VALUES (?, 'task', ?)", old.id, target);
    const next = await deviationsSource(db, f.site, [{ source_row: 2, deviation_no: 'SYN-REVISED',
      title: 'Synthetic revision', source_status: 'closed', actual_cost: 12.5 }], { scopeId: f.scopeId });
    t.assert.deepStrictEqual(await promote(f.site), { imported: 1, unchanged: false, unmapped_status: 0, run_id: next.runId });
    const after = await getDeviation(db, old.id);
    t.assert.strictEqual((await state(f.site)).length, before.length);
    t.assert.deepStrictEqual(after.created_at, old.created_at);
    t.assert.strictEqual(after.title, 'Synthetic revision'); t.assert.strictEqual(after.deviation_no, 'SYN-REVISED');
    t.assert.strictEqual(after.status, 'closed'); t.assert.strictEqual(Number(after.actual_cost), 12.5);
    for (const field of ['problem_description', 'priority', 'author', 'assigned_to', 'plc_area',
      'creation_date', 'due_date', 'approved_date', 'closed_date', 'claim_quantity', 'labor_hours', 'completed_tasks_pct']) {
      t.assert.strictEqual(after[field], null, field);
    }
    t.assert.deepStrictEqual(after.links.map(row => ({ ...row })), [{ entity_type: 'task', entity_id: target }]);
    t.assert.strictEqual((await db.all('SELECT * FROM source_snapshot.deviations WHERE _batch_id = ?', f.batchId)).length, 14);
  });

  await t.test('only observed/manual identities are linked; unresolved or absent keys stay NULL', async t => {
    const f = await fixture(['observed', 'manual', 'unresolved'].map(identity_state => ({ identity_state })));
    await promote(f.site);
    for (const [index, input] of f.rows.entries()) {
      const row = await getDeviation(db, stableId(f.site.id, f.scopeId, input.source_row));
      const key = await db.get("SELECT id FROM ingest.entity_keys WHERE scope_id = ? AND external_key = ?", f.scopeId, input.source_uuid);
      t.assert.strictEqual(row.source_entity_key_id, index < 2 ? key.id : null);
    }
    // The canonical PG snapshot requires a registered identity; simulate an external
    // source adapter without keys to exercise the LEFT JOIN fallback on both drivers.
    const other = await fixture([{}]);
    const noKeys = { transaction: fn => db.transaction(tx => fn({ ...tx, all: async (sql, ...args) => {
      const rows = await tx.all(sql, ...args);
      return sql.includes('FROM source_snapshot.deviations')
        ? rows.map(row => ({ ...row, source_entity_key_id: null, identity_state: null })) : rows;
    } })) };
    await importDeviations(noKeys, other.site.id, auth.users.owner);
    t.assert.strictEqual((await state(other.site))[0].source_entity_key_id, null);
  });

  await t.test('filters combine exactly; dates, numbers and IDs provide stable ordering with NULLs last', async t => {
    const f = await fixture([
      { deviation_no: 'C', creation_date: '2026-01-01 08:00:00', source_status: 'open', priority: 'high' },
      { deviation_no: 'B', creation_date: '2026-02-01 08:00:00', source_status: 'closed', priority: 'high' },
      { deviation_no: 'A', creation_date: '2026-02-01 08:00:00', source_status: 'open', priority: 'normal' },
      { deviation_no: 'D', source_status: 'open', priority: 'high' }, {}, {},
    ]);
    const other = await fixture(); await promote(other.site); await promote(f.site);
    const rows = await state(f.site);
    t.assert.deepStrictEqual(rows.slice(0, 4).map(row => row.deviation_no), ['A', 'B', 'C', 'D']);
    t.assert.deepStrictEqual(rows.slice(4).map(row => row.id), [stableId(f.site.id, f.scopeId, 6), stableId(f.site.id, f.scopeId, 7)].sort());
    for (const [filters, numbers] of [[{ status: 'open' }, ['A', 'C', 'D']], [{ priority: 'high' }, ['B', 'C', 'D']],
      [{ status: 'open', priority: 'high' }, ['C', 'D']], [{ priority: 'HIGH' }, []]]) {
      const result = await listDeviations(db, { siteId: f.site.id.toUpperCase(), ...filters });
      t.assert.deepStrictEqual(result.map(row => row.deviation_no), numbers);
    }
    for (const siteId of [undefined, '', 'invalid', 42]) await t.assert.rejects(() => listDeviations(db, { siteId }), { status: 400, code: 'VALIDATION_ERROR' });
    for (const status of ['', 'OPEN', 'unknown']) await t.assert.rejects(() => listDeviations(db, { siteId: f.site.id, status }), { status: 400, code: 'VALIDATION_ERROR' });
    await t.assert.rejects(() => listDeviations(db, { siteId: randomUUID() }), { status: 404, code: 'SITE_NOT_FOUND' });
    for (const id of ['invalid', randomUUID()]) await t.assert.rejects(() => getDeviation(db, id), { status: 404, code: 'DEVIATION_NOT_FOUND' });
  });

  await t.test('timestamp ordering preserves microseconds and treats equivalent fractional precision equally', async t => {
    const f = await fixture([
      { deviation_no: 'B', creation_date: '2026-01-01 08:00:00.1' },
      { deviation_no: 'C', creation_date: '2026-01-01 08:00:00.100001' },
      { deviation_no: 'A', creation_date: '2026-01-01 08:00:00.100000' },
    ], { zone: 'UTC' });
    await promote(f.site);
    t.assert.deepStrictEqual((await state(f.site)).map(row => row.deviation_no), ['C', 'A', 'B']);
  });

  await t.test('deviation links enforce their FK, entity enum and composite uniqueness', async t => {
    const f = await fixture([{}]); await promote(f.site);
    const row = (await state(f.site))[0], entityId = randomUUID();
    for (const type of ['site_progress_item', 'work_day', 'task', 'diary']) {
      await db.run('INSERT INTO deviation_links VALUES (?, ?, ?)', row.id, type, entityId);
    }
    const detail = await getDeviation(db, row.id.toUpperCase());
    t.assert.deepStrictEqual(detail.links.map(row => ({ ...row })), ['diary', 'site_progress_item', 'task', 'work_day'].map(entity_type => ({ entity_type, entity_id: entityId })));
    await t.assert.rejects(() => db.run("INSERT INTO deviation_links VALUES (?, 'task', ?)", randomUUID(), randomUUID()), /foreign key/i);
    await t.assert.rejects(() => db.run("INSERT INTO deviation_links VALUES (?, 'unknown', ?)", row.id, randomUUID()), /check/i);
    await t.assert.rejects(() => db.run("INSERT INTO deviation_links VALUES (?, 'task', ?)", row.id, entityId), /unique/i);
    await t.assert.rejects(() => db.run('DELETE FROM deviations WHERE id = ?', row.id), /foreign key/i);
  });

  await t.test('unready runs, untyped/missing batches, scope mismatch and incomplete snapshots are rejected atomically', async t => {
    const f = await fixture(); await promote(f.site);
    const before = await state(f.site), marker = await config(f.site);
    const rejected = async code => {
      await t.assert.rejects(() => promote(f.site), { status: 409, code });
      t.assert.deepStrictEqual(await state(f.site), before);
    };
    await db.run("UPDATE ingest.import_runs SET status = 'loading', completeness_verified = FALSE WHERE id = ?", f.runId);
    await rejected('DEVIATION_RUN_NOT_READY');
    await db.run('UPDATE ingest.import_runs SET completeness_verified = TRUE WHERE id = ?', f.runId);
    await rejected('DEVIATION_RUN_NOT_READY');
    await db.run("UPDATE ingest.import_runs SET status = 'ready' WHERE id = ?", f.runId);
    await db.run("UPDATE ingest.import_batches SET status = 'staging' WHERE id = ?", f.batchId);
    await rejected('DEVIATION_RUN_NOT_READY');
    await db.run("UPDATE ingest.import_batches SET status = 'typed', expected_rows = 99 WHERE id = ?", f.batchId);
    await rejected('DEVIATION_INCOMPLETE_SNAPSHOT');
    t.assert.deepStrictEqual(await config(f.site), marker);
    await db.run('UPDATE ingest.import_batches SET expected_rows = 14 WHERE id = ?', f.batchId);
    const other = await fixture();
    await db.run('UPDATE deviation_import_sources SET run_id = ? WHERE site_id = ?', other.runId, f.site.id);
    await rejected('DEVIATION_RUN_NOT_READY');
    await db.run('UPDATE deviation_import_sources SET run_id = ? WHERE site_id = ?', f.runId, f.site.id);
    await db.run('DELETE FROM ingest.run_batches WHERE run_id = ?', f.runId);
    await rejected('DEVIATION_RUN_NOT_READY');
    await db.run('DELETE FROM deviation_import_sources WHERE site_id = ?', f.site.id);
    await rejected('DEVIATION_SOURCE_NOT_CONFIGURED');
  });

  await t.test('late SQL failure and ambiguous/missing timezone roll back rows and promotion markers', async t => {
    const f = await fixture(); await promote(f.site);
    await deviationsSource(db, f.site, [{ title: 'Synthetic change' }], { scopeId: f.scopeId });
    const before = await state(f.site), marker = await config(f.site);
    const failing = { transaction: fn => db.transaction(tx => fn({ ...tx, run: async (sql, ...args) => {
      const result = await tx.run(sql, ...args);
      if (sql.startsWith('UPDATE deviation_import_sources')) throw new Error('Synthetic late failure');
      return result;
    } })) };
    await t.assert.rejects(() => importDeviations(failing, f.site.id, auth.users.owner), /Synthetic late failure/);
    t.assert.deepStrictEqual(await state(f.site), before); t.assert.deepStrictEqual(await config(f.site), marker);
    for (const [creation_date, zone] of [['2026-01-15 08:30:00', null], ['2026-10-25 02:30:00', 'Europe/Rome']]) {
      await deviationsSource(db, f.site, [{ creation_date }], { scopeId: f.scopeId, zone });
      const marker = await config(f.site);
      await t.assert.rejects(() => promote(f.site), { status: 409 });
      t.assert.deepStrictEqual(await state(f.site), before); t.assert.deepStrictEqual(await config(f.site), marker);
    }
  });

  await t.test('HTTP requires authentication/membership; viewer reads, only owner imports, routes remain read-only', async t => {
    const f = await fixture(), request = requestListener(createServer(db));
    const list = `/api/deviations?site_id=${f.site.id}`, importing = '/api/deviations/import';
    for (const path of [list, '/api/deviations/invalid']) t.assert.strictEqual((await request(path)).status, 401);
    t.assert.strictEqual((await request(importing, { method: 'POST', body: { site_id: f.site.id } })).status, 401);
    await t.assert.rejects(() => importDeviations(db, f.site.id), { status: 401, code: 'UNAUTHENTICATED' });
    for (const role of ['viewer', 'editor', 'verifier']) {
      const response = await request(importing, { method: 'POST', cookie: auth.cookies[role], body: { site_id: f.site.id } });
      t.assert.strictEqual(response.status, 403); t.assert.strictEqual(response.body.code, 'FORBIDDEN');
      await t.assert.rejects(() => importDeviations(db, f.site.id, auth.users[role]), { status: 403, code: 'FORBIDDEN' });
    }
    const imported = await request(importing, { method: 'POST', cookie: auth.cookies.owner, body: { site_id: f.site.id } });
    t.assert.strictEqual(imported.status, 200); t.assert.strictEqual(imported.body.imported, 14);
    const listed = await request(list, { cookie: auth.cookies.viewer });
    t.assert.strictEqual(listed.status, 200); t.assert.strictEqual(listed.body.length, 14);
    const row = listed.body[0], detailPath = `/api/deviations/${row.id}`, target = randomUUID();
    await db.run("INSERT INTO deviation_links VALUES (?, 'task', ?)", row.id, target);
    const detail = await request(detailPath, { cookie: auth.cookies.viewer });
    t.assert.strictEqual(detail.status, 200);
    t.assert.deepStrictEqual(detail.body, { ...row, links: [{ entity_type: 'task', entity_id: target }] });
    const filtered = await request(`${list}&status=open&priority=high`, { cookie: auth.cookies.viewer });
    t.assert.strictEqual(filtered.status, 200); t.assert.strictEqual(filtered.body.length, 1);
    for (const path of ['/api/deviations', '/api/deviations?site_id=invalid', `${list}&status=unknown`, `${list}&status=`]) {
      const response = await request(path, { cookie: auth.cookies.viewer });
      t.assert.strictEqual(response.status, 400); t.assert.strictEqual(response.body.code, 'VALIDATION_ERROR');
    }
    t.assert.strictEqual((await request(importing, { method: 'POST', cookie: auth.cookies.owner, body: {} })).status, 400);
    for (const id of ['invalid', randomUUID()]) {
      const response = await request(`/api/deviations/${id}`, { cookie: auth.cookies.viewer });
      t.assert.strictEqual(response.status, 404); t.assert.strictEqual(response.body.code, 'DEVIATION_NOT_FOUND');
    }
    await db.run('DELETE FROM site_members WHERE site_id = ? AND user_id = ?', f.site.id, auth.users.viewer.id);
    for (const path of [list, detailPath]) t.assert.strictEqual((await request(path, { cookie: auth.cookies.viewer })).status, 403);
    const other = await createSite(db, { code: randomUUID(), name: 'Synthetic unrelated site' });
    t.assert.strictEqual((await request(importing, { method: 'POST', cookie: auth.cookies.owner, body: { site_id: other.id } })).status, 403);
    for (const method of ['PATCH', 'DELETE']) for (const path of [list, detailPath]) {
      t.assert.strictEqual((await request(path, { method, cookie: auth.cookies.owner, body: {} })).status, 404);
    }
  });

  await t.test('migrations preserve data; deviation constraints/types/indexes and reserved task kind are enforced', async t => {
    const f = await fixture(); await promote(f.site);
    const before = await state(f.site);
    const task = await createTask(db, { siteId: f.site.id, title: 'Synthetic task', executor: 'Example executor', verifier: 'Example verifier', kind: 'ignored' });
    t.assert.strictEqual((await db.get('SELECT kind FROM tasks WHERE id = ?', task.id)).kind, null);
    for (const kind of ['arbitrary synthetic value', '', null]) {
      await db.run('UPDATE tasks SET kind = ? WHERE id = ?', kind, task.id);
      t.assert.strictEqual((await db.get('SELECT kind FROM tasks WHERE id = ?', task.id)).kind, kind);
      t.assert.strictEqual(Object.hasOwn(await getTask(db, task.id), 'kind'), false);
      t.assert.strictEqual(Object.hasOwn((await listTasks(db, { siteId: f.site.id }))[0], 'kind'), false);
    }
    t.assert.strictEqual(await migrate(db, { driver }), 0);
    t.assert.deepStrictEqual(await state(f.site), before);
    for (const [column, value, pattern] of [['site_id', randomUUID(), /foreign key/i], ['status', 'unknown', /check/i],
      ['created_at', null, /not.null/i], ['deviation_no', 'DUPLICATE', /unique/i]]) {
      await t.assert.rejects(() => db.run(`UPDATE deviations SET ${column} = ? WHERE site_id = ?`, value, f.site.id), pattern);
    }
    for (const column of ['status', 'priority']) {
      if (driver === 'pg') t.assert.match((await db.get('SELECT indexdef FROM pg_indexes WHERE indexname = ?', `deviations_site_${column}`)).indexdef, new RegExp(`site_id, ${column}`));
      else t.assert.deepStrictEqual((await db.all(`PRAGMA index_info(deviations_site_${column})`)).map(row => row.name), ['site_id', column]);
    }
    if (driver === 'pg') {
      const columns = await db.all("SELECT column_name, udt_name FROM information_schema.columns WHERE table_name = 'deviations' AND table_schema = current_schema()");
      for (const [field, type] of [['id', 'uuid'], ['site_id', 'uuid'], ['source_entity_key_id', 'uuid'],
        ['creation_date', 'timestamptz'], ['due_date', 'timestamptz'], ['approved_date', 'timestamptz'], ['closed_date', 'timestamptz'],
        ['actual_cost', 'numeric'], ['claim_quantity', 'numeric'], ['labor_hours', 'numeric'], ['completed_tasks_pct', 'numeric']]) {
        t.assert.strictEqual(columns.find(row => row.column_name === field).udt_name, type);
      }
      const kind = await db.get("SELECT is_nullable, column_default, udt_name FROM information_schema.columns WHERE table_name = 'tasks' AND column_name = 'kind' AND table_schema = current_schema()");
      t.assert.deepStrictEqual(kind, { is_nullable: 'YES', column_default: null, udt_name: 'text' });
    } else {
      const kind = (await db.all('PRAGMA table_info(tasks)')).find(row => row.name === 'kind');
      t.assert.strictEqual(kind.notnull, 0); t.assert.strictEqual(kind.dflt_value, null); t.assert.strictEqual(kind.type, 'TEXT');
    }
  });

  await t.test('missing ingestion schema or table returns a domain conflict and preserves projection/markers', async t => {
    const f = await fixture(); await promote(f.site);
    const before = await state(f.site), marker = await config(f.site);
    // Exercise both PostgreSQL missing-relation and missing-schema SQLSTATE mappings.
    for (const code of ['42P01', '3F000']) {
      const missing = { transaction: fn => db.transaction(tx => fn({ ...tx, all: async () => { throw Object.assign(new Error('Synthetic unavailable source'), { code }); } })) };
      await t.assert.rejects(() => importDeviations(missing, f.site.id, auth.users.owner), { status: 409, code: 'DEVIATION_SOURCE_UNAVAILABLE' });
    }
    if (driver === 'pg') await db.exec('DROP SCHEMA source_snapshot CASCADE');
    else await db.exec('DETACH DATABASE source_snapshot');
    await t.assert.rejects(() => promote(f.site), { status: 409, code: 'DEVIATION_SOURCE_UNAVAILABLE' });
    t.assert.deepStrictEqual(await state(f.site), before); t.assert.deepStrictEqual(await config(f.site), marker);
  });
});
