import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createSite } from '../server/repository.mjs';
import { listSiteProgress, getSiteProgressItem, importSiteProgress } from '../server/site-progress.mjs';
import { importWbs, listWbs, stableId } from '../server/wbs.mjs';
import { createServer } from '../server/http.mjs';
import { applyMigration } from '../server/migrations/index.mjs';
import { authFixture, requestListener } from './helpers/auth.mjs';
import { wbsSource } from './helpers/wbs.mjs';
import { siteProgressDatabase, siteProgressSource } from './helpers/site-progress.mjs';

for (const driver of ['sqlite', 'pg']) test(`Site Progress ${driver}: snapshots, WBS links and access`, async t => {
  const db = await siteProgressDatabase(t, driver), auth = await authFixture(db);
  const fixture = async (rows, options) => {
    const site = await createSite(db, { code: randomUUID(), name: 'Synthetic progress site' });
    for (const [role, user] of Object.entries(auth.users)) await db.run('INSERT INTO site_members VALUES (?, ?, ?)', site.id, user.id, role);
    await wbsSource(db, site, [
      { wbs_code: '1', level: 0, section: 'Unique', plc_area: 'Area A' },
      { wbs_code: '2', level: 0, section: 'Ambiguous', plc_area: 'Area B' },
      { wbs_code: '3', level: 0, section: 'Ambiguous', plc_area: 'Area C' },
      { wbs_code: '4.1', level: 1 },
    ]);
    await importWbs(db, site.id, auth.users.owner);
    // Even a synthetic ancestor with matching dimensions must never become a candidate.
    await db.run("UPDATE project_structure SET section = 'Synthetic only', plc_area = 'Area S' WHERE site_id = ? AND is_synthetic = TRUE", site.id);
    return { site, ...await siteProgressSource(db, site, rows, options) };
  };
  const promote = site => importSiteProgress(db, site.id, auth.users.owner);
  const state = site => listSiteProgress(db, { siteId: site.id });
  const config = site => db.get('SELECT * FROM site_progress_import_sources WHERE site_id = ?', site.id);

  await t.test('promotion preserves fields, nulls, zero/100, timestamps and unresolved identities without annotations', async t => {
    const f = await fixture();
    const snapshot = await db.all('SELECT * FROM source_snapshot.site_progress_items WHERE _batch_id = ?', f.batchId);
    t.assert.deepStrictEqual(await promote(f.site), { imported: 8, linked: 3, unresolved: 8, unchanged: false, run_id: f.runId });
    const rows = await state(f.site);
    t.assert.strictEqual(rows.length, 8);
    for (const [index, input] of f.rows.entries()) {
      const row = rows.find(item => item.source_row === index + 2);
      t.assert.strictEqual(row.id, stableId(f.site.id, f.scopeId, index + 2));
      t.assert.strictEqual(row.source_entity_key_id, null);
      for (const field of ['description', 'plc_area', 'section', 'assigned_to', 'has_files', 'has_notes', 'has_deviations']) {
        t.assert.strictEqual(row[field], input[field] ?? null, field);
      }
      for (const field of ['progress_pct', 'planned_progress_pct', 'delta_progress_source']) {
        if (input[field] == null) t.assert.strictEqual(row[field], null);
        else t.assert.strictEqual(Number(row[field]), input[field]);
      }
      t.assert.strictEqual(row.expected_delay, input.expected_delay_raw ?? null);
    }
    const first = rows.find(row => row.source_row === 2);
    for (const [field, expected] of [['planned_start', '2026-01-15T07:30:00.000Z'],
      ['planned_finish', '2026-07-15T14:30:00.000Z'], ['actual_start', '2026-01-15T08:00:00.000Z']]) {
      t.assert.strictEqual(new Date(first[field]).toISOString(), expected);
      t.assert.strictEqual(rows.find(row => row.source_row === 5)[field], null);
    }
    t.assert.deepStrictEqual(await db.all('SELECT * FROM internal_work.record_annotations'), []);
    t.assert.deepStrictEqual(await db.all("SELECT * FROM ingest.entity_keys WHERE family = 'site_progress_items' AND scope_id = ?", f.scopeId), []);
    t.assert.deepStrictEqual(await db.all('SELECT * FROM source_snapshot.site_progress_items WHERE _batch_id = ?', f.batchId), snapshot);
    const marker = await config(f.site);
    t.assert.strictEqual(marker.promoted_run_id, f.runId); t.assert.strictEqual(marker.promoted_batch_id, f.batchId);
    t.assert.ok(Number.isFinite(new Date(marker.promoted_at).getTime()));
  });

  await t.test('WBS links require exactly one real candidate matching all supplied dimensions in the same site', async t => {
    const f = await fixture(), other = await fixture();
    await promote(f.site); await promote(other.site);
    const nodes = await listWbs(db, { siteId: f.site.id, flat: 1 });
    const unique = nodes.find(node => node.wbs_code === '1'), rows = await state(f.site);
    for (const row of rows) t.assert.strictEqual(row.wbs_id, [2, 7, 8].includes(row.source_row) ? unique.id : null);
    const filtered = await listSiteProgress(db, { siteId: f.site.id, wbsId: unique.id.toUpperCase() });
    t.assert.strictEqual(filtered.length, 3); t.assert.ok(filtered.every(row => row.wbs_id === unique.id));
    const foreignNode = (await listWbs(db, { siteId: other.site.id, flat: 1 }))[0];
    t.assert.deepStrictEqual(await listSiteProgress(db, { siteId: f.site.id, wbsId: foreignNode.id }), []);
    const expected = await db.all('SELECT id FROM site_progress_items WHERE site_id = ? ORDER BY section, plc_area, source_row, id', f.site.id);
    t.assert.deepStrictEqual(rows.map(row => row.id), expected.map(row => row.id));
  });

  await t.test('repeated and concurrent imports preserve IDs, created_at, rows and promotion markers', async t => {
    const f = await fixture(); await promote(f.site);
    const before = await state(f.site), marker = await config(f.site);
    for (const result of await Promise.all([promote(f.site), promote(f.site)])) {
      t.assert.deepStrictEqual(result, { imported: 0, unresolved: 0, unchanged: true, run_id: f.runId });
    }
    t.assert.deepStrictEqual(await state(f.site), before);
    t.assert.deepStrictEqual(await config(f.site), marker);
  });

  await t.test('a later run updates surviving rows, deletes absent rows and retains source history', async t => {
    const f = await fixture(); await promote(f.site);
    const before = await state(f.site);
    await siteProgressSource(db, f.site, [
      { ...f.rows[0], description: 'Synthetic revised work', section: 'Missing', progress_pct: 50 },
      { description: 'Synthetic new work', source_row: 20 },
    ], { scopeId: f.scopeId });
    t.assert.strictEqual((await promote(f.site)).imported, 2);
    const after = await state(f.site), surviving = after.find(row => row.source_row === 2), old = before.find(row => row.source_row === 2);
    t.assert.strictEqual(after.length, 2); t.assert.strictEqual(surviving.id, old.id);
    t.assert.deepStrictEqual(surviving.created_at, old.created_at);
    t.assert.strictEqual(surviving.description, 'Synthetic revised work');
    t.assert.strictEqual(Number(surviving.progress_pct), 50); t.assert.strictEqual(surviving.wbs_id, null);
    t.assert.strictEqual((await db.all('SELECT * FROM source_snapshot.site_progress_items WHERE _batch_id = ?', f.batchId)).length, 8);
    // Changing the explicitly configured scope replaces IDs even at the same row positions.
    await siteProgressSource(db, f.site, [{ description: 'Synthetic replacement scope' }]);
    await promote(f.site);
    t.assert.notStrictEqual((await state(f.site))[0].id, old.id);
  });

  await t.test('reimport fails closed with 409 when a removed item has active time bookings', async t => {
    const f = await fixture(); await promote(f.site);
    const item = (await state(f.site)).find(row => row.source_row === 2);
    const employeeId = randomUUID(), workDayId = randomUUID(), at = '2026-01-15T08:00:00.000Z';
    await db.run('INSERT INTO employees (id, site_id, employee_no, created_at) VALUES (?, ?, ?, ?)', employeeId, f.site.id, 'SYN-409', at);
    await db.run('INSERT INTO work_days (id, site_id, employee_id, operational_date, created_at) VALUES (?, ?, ?, ?, ?)',
      workDayId, f.site.id, employeeId, '2026-01-15', at);
    await db.run(`INSERT INTO time_bookings (id, site_id, work_day_id, site_progress_item_id, hours, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`, randomUUID(), f.site.id, workDayId, item.id, 2.5, auth.users.owner.id, at);
    const before = await state(f.site), marker = await config(f.site);
    t.assert.strictEqual(before.find(row => row.id === item.id).booked_hours, 2.5);
    // A snapshot that drops the booked item must be rejected whole, never partially applied.
    await siteProgressSource(db, f.site, [{ description: 'Synthetic replacement only', source_row: 30 }], { scopeId: f.scopeId });
    await t.assert.rejects(() => promote(f.site), { status: 409, code: 'SITE_PROGRESS_ITEM_HAS_BOOKINGS' });
    t.assert.deepStrictEqual(await state(f.site), before);
    const unchangedMarker = await config(f.site);
    for (const field of ['promoted_run_id', 'promoted_batch_id', 'promoted_at']) t.assert.deepStrictEqual(unchangedMarker[field], marker[field], field);
    // The same snapshot is accepted once the booking is gone.
    await db.run('DELETE FROM time_bookings WHERE site_progress_item_id = ?', item.id);
    t.assert.strictEqual((await promote(f.site)).imported, 1);
    const after = await state(f.site);
    t.assert.strictEqual(after.length, 1); t.assert.strictEqual(after[0].description, 'Synthetic replacement only');
    t.assert.strictEqual(after[0].booked_hours, 0);
  });

  await t.test('only observed/manual entity keys are linked; unresolved keys remain valid snapshot rows', async t => {
    const f = await fixture();
    const keys = [];
    for (const [index, identityState] of ['observed', 'manual', 'unresolved'].entries()) {
      const id = randomUUID(), external = `synthetic-key-${index}`; keys.push(id);
      await db.run("INSERT INTO ingest.entity_keys VALUES (?, ?, 'site_progress_items', ?, ?)", id, f.scopeId, external, identityState);
      await db.run('UPDATE source_snapshot.site_progress_items SET _identity_key = ? WHERE _batch_id = ? AND _source_row = ?', external, f.batchId, index + 2);
    }
    t.assert.strictEqual((await promote(f.site)).unresolved, 6);
    const rows = await state(f.site);
    for (let index = 0; index < 3; index++) t.assert.strictEqual(rows.find(row => row.source_row === index + 2).source_entity_key_id, index < 2 ? keys[index] : null);
    t.assert.deepStrictEqual(await db.all('SELECT * FROM internal_work.record_annotations'), []);
  });

  await t.test('UUID validation and missing items/sites use domain errors', async t => {
    const f = await fixture();
    for (const siteId of [undefined, '', 'invalid', 42]) await t.assert.rejects(() => listSiteProgress(db, { siteId }), { status: 400, code: 'VALIDATION_ERROR' });
    await t.assert.rejects(() => listSiteProgress(db, { siteId: f.site.id, wbsId: '' }), { status: 400, code: 'VALIDATION_ERROR' });
    await t.assert.rejects(() => listSiteProgress(db, { siteId: randomUUID() }), { status: 404, code: 'SITE_NOT_FOUND' });
    for (const id of ['invalid', randomUUID()]) await t.assert.rejects(() => getSiteProgressItem(db, id), { status: 404, code: 'SITE_PROGRESS_ITEM_NOT_FOUND' });
    await t.assert.rejects(() => importSiteProgress(db, 'invalid', auth.users.owner), { status: 400, code: 'VALIDATION_ERROR' });
    await t.assert.rejects(() => importSiteProgress(db, randomUUID(), auth.users.owner), { status: 404, code: 'SITE_NOT_FOUND' });
  });

  await t.test('unready runs, untyped/missing batches, mismatched scopes and incomplete snapshots preserve the projection', async t => {
    const f = await fixture(); await promote(f.site);
    const before = await state(f.site), marker = await config(f.site);
    const rejected = async code => {
      await t.assert.rejects(() => promote(f.site), { status: 409, code });
      t.assert.deepStrictEqual(await state(f.site), before);
    };
    await db.run("UPDATE ingest.import_runs SET status = 'loading' WHERE id = ?", f.runId);
    await rejected('SITE_PROGRESS_RUN_NOT_READY');
    await db.run('UPDATE ingest.import_runs SET completeness_verified = FALSE WHERE id = ?', f.runId);
    await rejected('SITE_PROGRESS_RUN_NOT_READY');
    await db.run("UPDATE ingest.import_runs SET status = 'ready', completeness_verified = TRUE WHERE id = ?", f.runId);
    await db.run("UPDATE ingest.import_batches SET status = 'staging' WHERE id = ?", f.batchId);
    await rejected('SITE_PROGRESS_RUN_NOT_READY');
    await db.run("UPDATE ingest.import_batches SET status = 'typed', expected_rows = 99 WHERE id = ?", f.batchId);
    await rejected('SITE_PROGRESS_INCOMPLETE_SNAPSHOT');
    t.assert.deepStrictEqual(await config(f.site), marker);
    await db.run('UPDATE ingest.import_batches SET expected_rows = 8 WHERE id = ?', f.batchId);
    const other = await fixture();
    await db.run('UPDATE site_progress_import_sources SET run_id = ? WHERE site_id = ?', other.runId, f.site.id);
    await rejected('SITE_PROGRESS_RUN_NOT_READY');
    await db.run('UPDATE site_progress_import_sources SET run_id = ? WHERE site_id = ?', f.runId, f.site.id);
    await db.run('DELETE FROM ingest.run_batches WHERE run_id = ?', f.runId);
    await rejected('SITE_PROGRESS_RUN_NOT_READY');
    await db.run('DELETE FROM site_progress_import_sources WHERE site_id = ?', f.site.id);
    await rejected('SITE_PROGRESS_SOURCE_NOT_CONFIGURED');
  });

  await t.test('a late SQL failure rolls back links, deletions, upserts and promotion markers', async t => {
    const f = await fixture(); await promote(f.site);
    await siteProgressSource(db, f.site, [{ ...f.rows[0], description: 'Synthetic change' }], { scopeId: f.scopeId });
    const before = await state(f.site), marker = await config(f.site);
    const failing = { transaction: fn => db.transaction(tx => fn({ ...tx, run: async (sql, ...args) => {
      const result = await tx.run(sql, ...args);
      if (sql.startsWith('INSERT INTO site_progress_items')) throw new Error('Synthetic write failure');
      return result;
    } })) };
    await t.assert.rejects(() => importSiteProgress(failing, f.site.id, auth.users.owner), /Synthetic write failure/);
    t.assert.deepStrictEqual(await state(f.site), before); t.assert.deepStrictEqual(await config(f.site), marker);
  });

  await t.test('missing or ambiguous source timezone prevents partial promotion', async t => {
    const f = await fixture(); await promote(f.site);
    const before = await state(f.site);
    for (const [planned_start, zone] of [['2026-01-15 08:30:00', null], ['2026-10-25 02:30:00', 'Europe/Rome']]) {
      await siteProgressSource(db, f.site, [{ planned_start }], { scopeId: f.scopeId, zone });
      const marker = await config(f.site);
      await t.assert.rejects(() => promote(f.site), { status: 409 });
      t.assert.deepStrictEqual(await state(f.site), before); t.assert.deepStrictEqual(await config(f.site), marker);
    }
  });

  await t.test('HTTP enforces authentication/membership: viewer reads and filters, only owner imports', async t => {
    const f = await fixture(), request = requestListener(createServer(db));
    const listPath = `/api/site-progress?site_id=${f.site.id}`, importPath = '/api/site-progress/import';
    for (const path of [listPath, '/api/site-progress/invalid']) t.assert.strictEqual((await request(path)).status, 401);
    t.assert.strictEqual((await request(importPath, { method: 'POST', body: { site_id: f.site.id } })).status, 401);
    await t.assert.rejects(() => importSiteProgress(db, f.site.id), { status: 401, code: 'UNAUTHENTICATED' });
    for (const role of ['viewer', 'editor', 'verifier']) {
      const response = await request(importPath, { method: 'POST', cookie: auth.cookies[role], body: { site_id: f.site.id } });
      t.assert.strictEqual(response.status, 403); t.assert.strictEqual(response.body.code, 'FORBIDDEN');
      await t.assert.rejects(() => importSiteProgress(db, f.site.id, auth.users[role]), { status: 403, code: 'FORBIDDEN' });
    }
    const imported = await request(importPath, { method: 'POST', cookie: auth.cookies.owner, body: { site_id: f.site.id } });
    t.assert.strictEqual(imported.status, 200); t.assert.strictEqual(imported.body.imported, 8);
    const listed = await request(listPath, { cookie: auth.cookies.viewer });
    t.assert.strictEqual(listed.status, 200); t.assert.strictEqual(listed.body.length, 8);
    const linked = listed.body.find(row => row.wbs_id), detailPath = `/api/site-progress/${linked.id}`;
    const detail = await request(detailPath, { cookie: auth.cookies.viewer });
    t.assert.strictEqual(detail.status, 200); t.assert.deepStrictEqual(detail.body, { ...linked, booked_hours: 0 });
    const filtered = await request(`${listPath}&wbs_id=${linked.wbs_id}`, { cookie: auth.cookies.viewer });
    t.assert.strictEqual(filtered.status, 200); t.assert.strictEqual(filtered.body.length, 3);
    t.assert.ok(filtered.body.every(row => row.wbs_id === linked.wbs_id));
    for (const path of ['/api/site-progress', '/api/site-progress?site_id=invalid', `${listPath}&wbs_id=invalid`]) {
      const result = await request(path, { cookie: auth.cookies.viewer });
      t.assert.strictEqual(result.status, 400); t.assert.strictEqual(result.body.code, 'VALIDATION_ERROR');
    }
    t.assert.strictEqual((await request(importPath, { method: 'POST', cookie: auth.cookies.owner, body: {} })).status, 400);
    const missing = await request('/api/site-progress/invalid', { cookie: auth.cookies.viewer });
    t.assert.strictEqual(missing.status, 404); t.assert.strictEqual(missing.body.code, 'SITE_PROGRESS_ITEM_NOT_FOUND');
    await db.run('DELETE FROM site_members WHERE site_id = ? AND user_id = ?', f.site.id, auth.users.viewer.id);
    for (const path of [listPath, detailPath]) t.assert.strictEqual((await request(path, { cookie: auth.cookies.viewer })).status, 403);
    const other = await createSite(db, { code: randomUUID(), name: 'Synthetic unrelated site' });
    const forbidden = await request(importPath, { method: 'POST', cookie: auth.cookies.owner, body: { site_id: other.id } });
    t.assert.strictEqual(forbidden.status, 403); t.assert.strictEqual(forbidden.body.code, 'FORBIDDEN');
    for (const path of [listPath, detailPath]) t.assert.strictEqual((await request(path, { method: 'PATCH', cookie: auth.cookies.owner, body: {} })).status, 404);
  });

  await t.test('migration replay preserves rows; foreign keys, row uniqueness, types and index are enforced', async t => {
    const f = await fixture(); await promote(f.site);
    const before = await state(f.site);
    await db.transaction(tx => applyMigration(tx, '010_site_progress.sql', { driver }));
    t.assert.deepStrictEqual(await state(f.site), before);
    for (const [column, value, pattern] of [['wbs_id', randomUUID(), /foreign key/i], ['site_id', randomUUID(), /foreign key/i],
      ['source_row', null, /not.null/i], ['source_row', 42, /unique/i]]) {
      await t.assert.rejects(() => db.run(`UPDATE site_progress_items SET ${column} = ? WHERE site_id = ?`, value, f.site.id), pattern);
    }
    if (driver === 'pg') {
      const columns = await db.all("SELECT column_name, udt_name FROM information_schema.columns WHERE table_name = 'site_progress_items' AND table_schema = current_schema()");
      for (const [column, type] of [['id', 'uuid'], ['site_id', 'uuid'], ['wbs_id', 'uuid'], ['source_entity_key_id', 'uuid'],
        ['source_row', 'int4'], ['planned_start', 'timestamptz'], ['planned_finish', 'timestamptz'], ['actual_start', 'timestamptz'],
        ['created_at', 'timestamptz'], ['progress_pct', 'numeric'], ['has_files', 'bool'], ['has_notes', 'bool'], ['has_deviations', 'bool']]) {
        t.assert.strictEqual(columns.find(row => row.column_name === column).udt_name, type);
      }
      t.assert.match((await db.get("SELECT indexdef FROM pg_indexes WHERE indexname = 'site_progress_items_site_wbs'")).indexdef, /site_id, wbs_id/);
    } else t.assert.deepStrictEqual((await db.all('PRAGMA index_info(site_progress_items_site_wbs)')).map(row => row.name), ['site_id', 'wbs_id']);
  });

  await t.test('unavailable ingestion tables/schemas return a domain conflict without changing the projection', async t => {
    const f = await fixture(); await promote(f.site);
    const before = await state(f.site), marker = await config(f.site);
    if (driver === 'pg') await db.exec('DROP SCHEMA source_snapshot CASCADE');
    else await db.exec('DETACH DATABASE source_snapshot');
    await t.assert.rejects(() => promote(f.site), { status: 409, code: 'SITE_PROGRESS_SOURCE_UNAVAILABLE' });
    t.assert.deepStrictEqual(await state(f.site), before); t.assert.deepStrictEqual(await config(f.site), marker);
  });
});
