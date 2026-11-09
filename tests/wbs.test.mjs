import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createSite } from '../server/repository.mjs';
import { importWbs, listWbs, getWbs, sourceTimestamp } from '../server/wbs.mjs';
import { createServer } from '../server/http.mjs';
import { applyMigration } from '../server/migrations/index.mjs';
import { authFixture, requestListener } from './helpers/auth.mjs';
import { wbsDatabase, wbsSource, syntheticWbs } from './helpers/wbs.mjs';

for (const driver of ['sqlite', 'pg']) test(`WBS ${driver}: migration, canonical snapshots, hierarchy and access`, async t => {
  const db = await wbsDatabase(t, driver);
  const auth = await authFixture(db);
  const fixture = async (rows, options) => {
    const site = await createSite(db, { code: randomUUID(), name: 'Synthetic WBS site' });
    for (const [role, user] of Object.entries(auth.users)) await db.run('INSERT INTO site_members VALUES (?, ?, ?)', site.id, user.id, role);
    const source = await wbsSource(db, site, rows, options);
    return { site, ...source };
  };
  const promote = site => importWbs(db, site.id, auth.users.owner);
  const flat = site => listWbs(db, { siteId: site.id, flat: 1 });

  await t.test('hierarchy is acyclic, ordered, scoped, and synthetic ancestors have no invented values', async t => {
    const { site, batchId } = await fixture();
    const before = await db.all('SELECT * FROM source_snapshot.time_schedule WHERE _batch_id = ?', batchId);
    const result = await promote(site);
    t.assert.strictEqual(result.imported, 6); t.assert.strictEqual(result.synthetic, 2);
    const rows = await flat(site), byId = new Map(rows.map(row => [row.id, row]));
    t.assert.strictEqual(rows.length, 8);
    for (const node of rows) {
      const seen = new Set([node.id]);
      let current = node;
      while (current.parent_id) {
        const parent = byId.get(current.parent_id);
        t.assert.ok(parent); t.assert.strictEqual(parent.level + 1, current.level);
        t.assert.strictEqual(parent.site_id, current.site_id);
        t.assert.ok(!seen.has(parent.id)); seen.add(parent.id); current = parent;
      }
    }
    const synthetic = rows.filter(node => node.is_synthetic);
    t.assert.deepStrictEqual(synthetic.map(node => node.wbs_code), ['4', '4.2']);
    for (const node of synthetic) for (const key of ['description', 'sort_order', 'summary_task', 'source_uuid', 'source_entity_key_id',
      'progress_pct', 'planned_start', 'planned_finish', 'actual_start', 'actual_finish', 'planned_hours', 'section', 'plc_area', 'assigned_to']) {
      t.assert.strictEqual(node[key], null, key);
    }
    const work = rows.find(node => node.wbs_code === '1.1');
    t.assert.strictEqual(Number(work.progress_pct), 0); t.assert.strictEqual(Number(work.planned_hours), 0);
    t.assert.strictEqual(work.summary_task, false);
    t.assert.strictEqual(new Date(work.planned_start).toISOString(), '2026-01-15T07:30:00.000Z');
    t.assert.ok(work.source_entity_key_id);
    t.assert.strictEqual(rows.find(node => node.wbs_code === 'ORPHAN').parent_id, null);
    const tree = await listWbs(db, { siteId: site.id });
    t.assert.deepStrictEqual(tree.map(node => node.wbs_code), ['1', '4', 'ORPHAN']);
    t.assert.deepStrictEqual(tree[0].children.map(node => node.wbs_code), ['1.2', '1.1']);
    const detail = await getWbs(db, tree[0].id);
    t.assert.deepStrictEqual(detail.children.map(node => node.wbs_code), ['1.2', '1.1']);
    t.assert.ok(detail.children.every(node => !('children' in node)));
    t.assert.deepStrictEqual(await db.all('SELECT * FROM source_snapshot.time_schedule WHERE _batch_id = ?', batchId), before);
    await t.assert.rejects(() => getWbs(db, 'invalid'), { status: 404 });
  });

  await t.test('reimport and concurrent promotions are no-ops with stable IDs and timestamps', async t => {
    const { site } = await fixture();
    await promote(site);
    const before = await flat(site), config = await db.get('SELECT * FROM wbs_import_sources WHERE site_id = ?', site.id);
    for (const result of await Promise.all([promote(site), promote(site)])) {
      t.assert.strictEqual(result.unchanged, true); t.assert.strictEqual(result.imported, 0);
    }
    t.assert.deepStrictEqual(await flat(site), before);
    t.assert.deepStrictEqual(await db.get('SELECT * FROM wbs_import_sources WHERE site_id = ?', site.id), config);
  });

  await t.test('same codes in different plans and duplicate leaf codes retain distinct source identities', async t => {
    const { site } = await fixture([
      { project_plan: 'A', wbs_code: '1', level: 0 }, { project_plan: 'B', wbs_code: '1', level: 0 },
      { project_plan: 'A', wbs_code: '1.1', level: 1 }, { project_plan: 'A', wbs_code: '1.1', level: 1 },
      { project_plan: 'B', wbs_code: '1.1', level: 1 },
    ]);
    await promote(site);
    const rows = await flat(site);
    t.assert.strictEqual(rows.length, 5);
    t.assert.strictEqual(new Set(rows.map(node => node.source_uuid)).size, 5);
    t.assert.strictEqual(new Set(rows.filter(node => node.level === 1).map(node => node.parent_id)).size, 2);
  });

  await t.test('ambiguous parent codes and inconsistent levels fail atomically', async t => {
    for (const rows of [
      [{ wbs_code: '1', level: 0 }, { wbs_code: '1', level: 0 }, { wbs_code: '1.1', level: 1 }],
      [{ wbs_code: '1', level: 2 }, { wbs_code: '1.1', level: 1 }],
      [{ wbs_code: '1.1', level: 1 }, { wbs_code: '1.2', level: 2 }],
    ]) {
      const { site } = await fixture(rows);
      await t.assert.rejects(() => promote(site), { status: 409 });
      t.assert.deepStrictEqual(await flat(site), []);
      t.assert.strictEqual((await db.get('SELECT promoted_run_id FROM wbs_import_sources WHERE site_id = ?', site.id)).promoted_run_id, null);
    }
  });

  await t.test('missing mappings, incomplete runs, untyped batches and count mismatch cannot promote', async t => {
    const { site, runId, batchId } = await fixture();
    await db.run("UPDATE ingest.import_runs SET status = 'loading', completeness_verified = FALSE WHERE id = ?", runId);
    await t.assert.rejects(() => promote(site), { code: 'WBS_RUN_NOT_READY' });
    await db.run("UPDATE ingest.import_runs SET status = 'ready', completeness_verified = TRUE WHERE id = ?", runId);
    await db.run("UPDATE ingest.import_batches SET status = 'staging' WHERE id = ?", batchId);
    await t.assert.rejects(() => promote(site), { code: 'WBS_RUN_NOT_READY' });
    await db.run("UPDATE ingest.import_batches SET status = 'typed', expected_rows = 99 WHERE id = ?", batchId);
    await t.assert.rejects(() => promote(site), { code: 'WBS_INCOMPLETE_SNAPSHOT' });
    await db.run('DELETE FROM wbs_import_sources WHERE site_id = ?', site.id);
    await t.assert.rejects(() => promote(site), { code: 'WBS_SOURCE_NOT_CONFIGURED' });
    t.assert.deepStrictEqual(await flat(site), []);
  });

  await t.test('scope/run mismatch and unresolved identities cannot leak or promote data', async t => {
    const { site, scopeId } = await fixture();
    const other = await fixture();
    await db.run('UPDATE wbs_import_sources SET run_id = ? WHERE site_id = ?', other.runId, site.id);
    await t.assert.rejects(() => promote(site), { code: 'WBS_RUN_NOT_READY' });
    await db.run("UPDATE ingest.entity_keys SET identity_state = 'unresolved' WHERE scope_id = ?", other.scopeId);
    await t.assert.rejects(() => promote(other.site), { code: 'WBS_RECONCILIATION_REQUIRED' });
    t.assert.notStrictEqual(scopeId, other.scopeId);
    t.assert.deepStrictEqual(await flat(site), []);
  });

  await t.test('a later configured run updates current nodes, replaces synthetic parents and preserves snapshots', async t => {
    const first = await fixture([{ wbs_code: '2.1', level: 1 }, { wbs_code: 'OLD', level: 0 }]);
    await promote(first.site);
    const before = await flat(first.site), child = before.find(node => !node.is_synthetic && node.level === 1);
    await wbsSource(db, first.site, [{ ...first.rows[0], description: 'Revised synthetic work' }, { wbs_code: '2', level: 0 }], { scopeId: first.scopeId });
    await promote(first.site);
    const after = await flat(first.site), updated = after.find(node => node.id === child.id);
    t.assert.strictEqual(after.length, 2); t.assert.ok(after.every(node => !node.is_synthetic));
    t.assert.strictEqual(updated.description, 'Revised synthetic work');
    t.assert.deepStrictEqual(updated.created_at, child.created_at);
    t.assert.strictEqual(updated.parent_id, after.find(node => node.wbs_code === '2').id);
    t.assert.strictEqual((await db.all('SELECT * FROM source_snapshot.time_schedule WHERE _batch_id = ?', first.batchId)).length, 2);
  });

  await t.test('invalid date/level and late SQL failure roll back the entire projection', async t => {
    const first = await fixture(); await promote(first.site);
    const before = await flat(first.site);
    await wbsSource(db, first.site, [{ wbs_code: '2', level: 0, planned_start: '2026-01-15 08:00:00' }], { scopeId: first.scopeId, zone: null });
    await t.assert.rejects(() => promote(first.site), { status: 409 });
    t.assert.deepStrictEqual(await flat(first.site), before);
    const invalid = await fixture([{ wbs_code: '2', level: null }]);
    await t.assert.rejects(() => promote(invalid.site), { status: 409 });
    await db.run("UPDATE ingest.import_runs SET source_timezone = 'UTC' WHERE id = (SELECT run_id FROM wbs_import_sources WHERE site_id = ?)", first.site.id);
    const failing = { transaction: fn => db.transaction(tx => fn({ ...tx, run: async (sql, ...args) => {
      const result = await tx.run(sql, ...args);
      if (sql.startsWith('INSERT INTO project_structure')) throw new Error('Synthetic write failure');
      return result;
    } })) };
    await t.assert.rejects(() => importWbs(failing, first.site.id, auth.users.owner), /Synthetic write failure/);
    t.assert.deepStrictEqual(await flat(first.site), before);
  });

  await t.test('HTTP requires sessions/membership, viewers read and only site owners import', async t => {
    const { site } = await fixture();
    const request = requestListener(createServer(db));
    const path = `/api/wbs?site_id=${site.id}`;
    t.assert.strictEqual((await request(path)).status, 401);
    for (const role of ['editor', 'verifier', 'viewer']) {
      t.assert.strictEqual((await request('/api/wbs/import', { method: 'POST', body: { site_id: site.id }, cookie: auth.cookies[role] })).status, 403);
      await t.assert.rejects(() => importWbs(db, site.id, auth.users[role]), { status: 403 });
    }
    await t.assert.rejects(() => importWbs(db, site.id), { status: 401 });
    const imported = await request('/api/wbs/import', { method: 'POST', body: { site_id: site.id }, cookie: auth.cookies.owner });
    t.assert.strictEqual(imported.status, 200); t.assert.strictEqual(imported.body.imported, 6);
    const list = await request(path + '&flat=1', { cookie: auth.cookies.viewer });
    t.assert.strictEqual(list.status, 200); t.assert.strictEqual(list.body.length, 8);
    t.assert.deepStrictEqual(list.body, JSON.parse(JSON.stringify(await flat(site))));
    const tree = await request(path, { cookie: auth.cookies.viewer });
    t.assert.strictEqual(tree.status, 200); t.assert.strictEqual(tree.body.length, 3);
    const detailPath = `/api/wbs/${list.body[0].id}`;
    t.assert.strictEqual((await request(detailPath, { cookie: auth.cookies.viewer })).status, 200);
    await db.run('DELETE FROM site_members WHERE site_id = ? AND user_id = ?', site.id, auth.users.viewer.id);
    for (const route of [path, detailPath]) t.assert.strictEqual((await request(route, { cookie: auth.cookies.viewer })).status, 403);
    const other = await createSite(db, { code: randomUUID(), name: 'Synthetic unrelated site' });
    t.assert.strictEqual((await request('/api/wbs/import', { method: 'POST', body: { site_id: other.id }, cookie: auth.cookies.owner })).status, 403);
    t.assert.strictEqual((await request('/api/wbs', { cookie: auth.cookies.owner })).status, 400);
    t.assert.strictEqual((await request('/api/wbs/import', { method: 'POST', body: {}, cookie: auth.cookies.owner })).status, 400);
    t.assert.strictEqual((await request('/api/wbs/invalid', { cookie: auth.cookies.owner })).status, 404);
  });

  await t.test('migration replay preserves rows, required types, foreign keys and indexes', async t => {
    const { site } = await fixture(); await promote(site);
    const before = await flat(site);
    await db.transaction(tx => applyMigration(tx, '008_wbs.sql', { driver }));
    t.assert.deepStrictEqual(await flat(site), before);
    await t.assert.rejects(() => db.run('UPDATE project_structure SET parent_id = id WHERE site_id = ?', site.id), /check/i);
    await t.assert.rejects(() => db.run('UPDATE project_structure SET parent_id = ? WHERE site_id = ?', randomUUID(), site.id), /foreign key/i);
    await t.assert.rejects(() => db.run('UPDATE project_structure SET wbs_code = NULL WHERE site_id = ?', site.id), /not.null/i);
    if (driver === 'pg') {
      const columns = await db.all("SELECT column_name, udt_name FROM information_schema.columns WHERE table_name = 'project_structure'");
      for (const [column, type] of [['id', 'uuid'], ['site_id', 'uuid'], ['source_entity_key_id', 'uuid'], ['planned_start', 'timestamptz'], ['progress_pct', 'numeric'], ['is_synthetic', 'bool']]) {
        t.assert.strictEqual(columns.find(row => row.column_name === column).udt_name, type);
      }
      t.assert.match((await db.get("SELECT indexdef FROM pg_indexes WHERE indexname = 'project_structure_order'")).indexdef, /site_id, level, sort_order/);
    } else t.assert.deepStrictEqual((await db.all('PRAGMA index_info(project_structure_order)')).map(row => row.name), ['site_id', 'level', 'sort_order']);
  });
});

test('WBS timestamps require explicit zones and reject ambiguous/nonexistent local times', t => {
  t.assert.strictEqual(sourceTimestamp(null, null), null);
  t.assert.strictEqual(sourceTimestamp('2026-01-15T08:30:00.123456+01:00'), '2026-01-15T07:30:00.123456Z');
  t.assert.strictEqual(sourceTimestamp('2026-07-15 08:30:00', 'Europe/Rome'), '2026-07-15T06:30:00.000Z');
  for (const [value, zone] of [['2026-01-15 08:30:00', null], ['2026-10-25 02:30:00', 'Europe/Rome'],
    ['2026-03-29 02:30:00', 'Europe/Rome'], ['2026-02-30 02:30:00', 'UTC'], ['2026-01-01 12:00:00', 'Invalid/Zone']]) {
    t.assert.throws(() => sourceTimestamp(value, zone), { status: 409 });
  }
});
