import { provisionDemoFixture, withDemoEnvironment } from './helpers/demo-seed.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createSite, createTask, updateTaskWbs, getTask, listTasks } from '../server/repository.mjs';
import { createWbs, updateWbs, listWbs, getWbs, importWbs } from '../server/wbs.mjs';
import { applyFamily, previewToken, verifyPreviewToken } from '../server/planning-import.mjs';
import { createServer } from '../server/http.mjs';
import { authFixture, requestListener } from './helpers/auth.mjs';
import { wbsDatabase, wbsSource } from './helpers/wbs.mjs';
import { apply as seedDemo, reset as resetDemo } from '../server/seed-demo.mjs';

for (const driver of ['sqlite', 'pg']) test(`Operational WBS ${driver}: stable links, reconciliation, isolation and fixture`, async t => {
  const db = await wbsDatabase(t, driver), auth = await authFixture(db);
  const fixture = async () => {
    const site = await createSite(db, { code: randomUUID(), name: 'Synthetic operational site' });
    for (const [role, user] of Object.entries(auth.users)) await db.run('INSERT INTO site_members VALUES (?, ?, ?)', site.id, user.id, role);
    return site;
  };
  const create = (site, code = 'C03', more = {}, user = auth.users.owner) => createWbs(db, { site_id: site.id, wbs_code: code, description: 'Synthetic section', ...more }, user);
  const upload = (site, rows, completeVerified = false) => applyFamily(db, { siteId: site.id, family: 'time_schedule',
    rows: rows.map((values, index) => ({ key: values.wbs_code, values: { level: 0, ...values }, source_row: index + 2, identity_state: 'observed' })), user: auth.users.owner, completeVerified });
  const links = async (site, node) => {
    const task = await createTask(db, { siteId: site.id, title: 'Synthetic C03 work', executor: 'Crew', verifier: 'Checker', area: 'Area independent of WBS', company: 'Synthetic contractor', wbsId: node.id });
    const item = randomUUID(), employee = randomUUID(), day = randomUUID(), booking = randomUUID(), at = '2026-11-16T22:00:00Z';
    await db.run(`INSERT INTO site_progress_items (id, site_id, wbs_id, description, source_row, created_at) VALUES (?, ?, ?, 'Synthetic progress', 12345, ?)`, item, site.id, node.id, at);
    await db.run(`INSERT INTO employees (id, site_id, employee_no, created_at) VALUES (?, ?, 'SYN-1', ?)`, employee, site.id, at);
    await db.run(`INSERT INTO work_days (id, site_id, employee_id, operational_date, shift, created_at) VALUES (?, ?, ?, '2026-11-16', 'night', ?)`, day, site.id, employee, at);
    await db.run('INSERT INTO time_bookings (id, site_id, work_day_id, site_progress_item_id, hours, created_at) VALUES (?, ?, ?, ?, 6, ?)', booking, site.id, day, item, at);
    return { task, item, day, booking };
  };
  const assertLinks = async (node, saved) => {
    assert.equal((await getTask(db, saved.task.id)).wbs_id, node.id);
    assert.equal((await db.get('SELECT wbs_id FROM site_progress_items WHERE id = ?', saved.item)).wbs_id, node.id);
    assert.equal((await db.get('SELECT site_progress_item_id FROM time_bookings WHERE id = ?', saved.booking)).site_progress_item_id, saved.item);
  };

  await t.test('native create/edit/move/reorder/archive retains ID; cycles and cross-site parents roll back', async () => {
    const site = await fixture(), other = await fixture(), root = await create(site), foreign = await create(other);
    const child = await create(site, 'CHILD', { parent_id: root.id });
    const edit = await updateWbs(db, child.id, { description: 'Working name', sort_order: 0, parent_id: null }, auth.users.editor);
    assert.equal(edit.id, child.id); assert.equal(edit.description, 'Working name'); assert.equal(edit.sort_order, 0); assert.equal(edit.parent_id, null);
    assert.equal(edit.source_values.description, 'Synthetic section'); assert.equal(edit.local_overrides.sort_order, 0);
    assert.equal(edit.provenance.updated_by, auth.users.editor.id);
    await updateWbs(db, child.id, { parent_id: root.id }, auth.users.owner);
    await assert.rejects(updateWbs(db, root.id, { parent_id: child.id }, auth.users.owner), { code: 'WBS_CYCLE' });
    await assert.rejects(updateWbs(db, root.id, { parent_id: root.id }, auth.users.owner), { code: 'WBS_CYCLE' });
    await assert.rejects(updateWbs(db, root.id, { parent_id: foreign.id }, auth.users.owner), { code: 'WBS_WRONG_SITE' });
    assert.equal((await getWbs(db, root.id)).parent_id, null);
    const saved = await links(site, child);
    await updateWbs(db, child.id, { archived: true }, auth.users.owner);
    assert.ok((await getWbs(db, child.id)).archived_at); await assertLinks(child, saved);
    assert.ok((await listWbs(db, { siteId: site.id, flat: true })).some(node => node.id === child.id));
    await updateWbs(db, child.id, { archived: false }, auth.users.owner);
    assert.equal((await getWbs(db, child.id)).archived_at, null);
  });

  await t.test('source import retains linked IDs, preserves local fields, and flags complete missing only', async () => {
    const site = await fixture();
    const source = await wbsSource(db, site, [{ wbs_code: 'C03', description: 'Source name', level: 0 }, { wbs_code: 'ROOT', level: 0 }]);
    await importWbs(db, site.id, auth.users.owner);
    const nodes = await listWbs(db, { siteId: site.id, flat: true }), node = nodes.find(row => row.wbs_code === 'C03'), root = nodes.find(row => row.wbs_code === 'ROOT');
    const saved = await links(site, node);
    await updateWbs(db, node.id, { description: 'Local name', parent_id: root.id, sort_order: 0 }, auth.users.editor);
    const before = await db.all('SELECT * FROM source_snapshot.time_schedule WHERE _batch_id = ?', source.batchId);
    const next = async rows => { const input = await wbsSource(db, site, rows, { scopeId: source.scopeId }); return input; };
    await next([{ ...source.rows[0], description: 'Changed source', sort_order: 4 }, source.rows[1]]);
    await importWbs(db, site.id, auth.users.owner);
    let current = await getWbs(db, node.id);
    assert.equal(current.description, 'Local name'); assert.equal(current.parent_id, root.id); assert.equal(current.sort_order, 0);
    assert.equal(current.source_values.description, 'Changed source'); assert.equal(current.override_source_values.description, 'Source name');
    assert.equal(current.conflicts.description, true); assert.equal(current.conflicts.sort_order, true);
    await assertLinks(node, saved);
    const partial = await next([source.rows[1]]);
    // A run still loading cannot promote, even with verified completeness.
    await db.run("UPDATE ingest.import_runs SET status = 'loading' WHERE id = ?", partial.runId);
    const intact = await getWbs(db, node.id);
    await assert.rejects(importWbs(db, site.id, auth.users.owner), { code: 'WBS_RUN_NOT_READY' });
    assert.deepEqual(await getWbs(db, node.id), intact);
    await assertLinks(node, saved);
    await next([source.rows[1]]); await importWbs(db, site.id, auth.users.owner);
    assert.equal((await getWbs(db, node.id)).missing_from_source, true); await assertLinks(node, saved);
    await next(source.rows); await importWbs(db, site.id, auth.users.owner);
    current = await getWbs(db, node.id); assert.equal(current.missing_from_source, false);
    assert.equal(current.conflicts.description, true); // even a source revert needs explicit resolution
    await updateWbs(db, node.id, { keep_fields: ['description'], reset_fields: ['sort_order'] }, auth.users.owner);
    current = await getWbs(db, node.id); assert.equal(current.description, 'Local name'); assert.equal(current.sort_order, null);
    assert.deepEqual(current.conflicts, {}); await assertLinks(node, saved);
    assert.deepEqual(await db.all('SELECT * FROM source_snapshot.time_schedule WHERE _batch_id = ?', source.batchId), before);
  });

  await t.test('a missing source parent is represented synthetically without overwriting the real parent', async () => {
    const site = await fixture();
    const source = await wbsSource(db, site, [
      { wbs_code: 'ROOT', description: 'Source root', level: 0 },
      { wbs_code: 'ROOT.C03', description: 'Source child', level: 1 },
    ]);
    await importWbs(db, site.id, auth.users.owner);
    const before = await listWbs(db, { siteId: site.id, flat: true });
    const realRoot = before.find(node => node.wbs_code === 'ROOT');
    assert.ok(realRoot); assert.equal(realRoot.source_uuid, source.rows[0].source_uuid); assert.equal(realRoot.is_synthetic, false);

    await wbsSource(db, site, [source.rows[1]], { scopeId: source.scopeId });
    await importWbs(db, site.id, auth.users.owner);

    const after = await listWbs(db, { siteId: site.id, flat: true });
    const roots = after.filter(node => node.wbs_code === 'ROOT');
    assert.equal(roots.length, 2);
    const kept = roots.find(node => !node.is_synthetic), synthetic = roots.find(node => node.is_synthetic);
    assert.equal(kept.id, realRoot.id); assert.equal(kept.source_uuid, source.rows[0].source_uuid);
    assert.equal(kept.description, 'Source root'); assert.equal(kept.missing_from_source, true);
    assert.equal(synthetic.source_uuid, null);
    assert.equal(after.find(node => node.wbs_code === 'ROOT.C03').parent_id, synthetic.id);
  });

  await t.test('upload and source promotions adopt the same operational identity and reconcile both ways', async () => {
    const site = await fixture(), source = await wbsSource(db, site, [{ wbs_code: 'C03', description: 'Original source', level: 0 }]);
    await upload(site, [{ wbs_code: 'C03', description: 'Uploaded name' }, { wbs_code: 'EXTRA' }]);
    const node = (await listWbs(db, { siteId: site.id, flat: true })).find(row => row.wbs_code === 'C03');
    const saved = await links(site, node);
    await updateWbs(db, node.id, { description: 'Working C03' }, auth.users.owner);
    await importWbs(db, site.id, auth.users.owner);
    assert.equal((await listWbs(db, { siteId: site.id, flat: true })).filter(row => row.wbs_code === 'C03').length, 1);
    assert.equal((await getWbs(db, node.id)).source_values.source_uuid, source.rows[0].source_uuid);
    await upload(site, [{ wbs_code: 'C03', description: 'Uploaded revision' }], true);
    let current = await getWbs(db, node.id); assert.equal(current.description, 'Working C03'); assert.equal(current.conflicts.description, true);
    assert.equal(current.source_values.description, 'Uploaded revision'); await assertLinks(node, saved);
    await upload(site, [{ wbs_code: 'OTHER' }]); assert.equal((await getWbs(db, node.id)).missing_from_source, false);
    await upload(site, [{ wbs_code: 'OTHER' }], true); assert.equal((await getWbs(db, node.id)).missing_from_source, true);
    await assertLinks(node, saved);
  });

  await t.test('DB rejects cross-site parent, local override, task, progress and booking links, including reverse moves', async () => {
    const site = await fixture(), other = await fixture(), node = await create(site), foreign = await create(other);
    const saved = await links(site, node), elsewhere = await links(other, foreign);
    for (const [sql, args] of [
      ['UPDATE project_structure SET parent_id = ? WHERE id = ?', [foreign.id, node.id]],
      ['UPDATE tasks SET wbs_id = ? WHERE id = ?', [foreign.id, saved.task.id]],
      ['UPDATE site_progress_items SET wbs_id = ? WHERE id = ?', [foreign.id, saved.item]],
      ['UPDATE time_bookings SET site_progress_item_id = ? WHERE id = ?', [elsewhere.item, saved.booking]],
      ['UPDATE time_bookings SET work_day_id = ? WHERE id = ?', [elsewhere.day, saved.booking]],
      ['UPDATE project_structure SET site_id = ? WHERE id = ?', [other.id, node.id]],
      ['UPDATE site_progress_items SET site_id = ? WHERE id = ?', [other.id, saved.item]],
      ['UPDATE work_days SET site_id = ? WHERE id = ?', [other.id, saved.day]],
    ]) await assert.rejects(db.run(sql, ...args));
    await updateWbs(db, node.id, { description: 'Local' }, auth.users.owner);
    await assert.rejects(db.run('UPDATE wbs_node_overrides SET parent_id = ?, parent_set = TRUE WHERE wbs_id = ?', foreign.id, node.id));
    await assertLinks(node, saved);
  });

  await t.test('task association is optional, editable, site scoped and visible in list/detail/API payload', async () => {
    const site = await fixture(), other = await fixture(), node = await create(site), foreign = await create(other);
    const base = { siteId: site.id, title: 'Optional association', executor: 'Crew', verifier: 'Checker' };
    const task = await createTask(db, base); assert.equal(task.wbs_id, null);
    await assert.rejects(createTask(db, { ...base, wbsId: foreign.id }), { code: 'WBS_WRONG_SITE' });
    await assert.rejects(updateTaskWbs(db, task.id, { wbsId: foreign.id }, auth.users.owner), { code: 'WBS_WRONG_SITE' });
    await updateWbs(db, node.id, { description: 'Effective description' }, auth.users.owner);
    const changed = await updateTaskWbs(db, task.id, { wbsId: node.id }, auth.users.editor);
    assert.equal(changed.wbs_code, 'C03'); assert.equal(changed.wbs_description, 'Effective description');
    assert.equal((await listTasks(db, { siteId: site.id }))[0].wbs_id, node.id);
    await updateTaskWbs(db, task.id, { wbsId: null }, auth.users.owner); assert.equal((await getTask(db, task.id)).wbs_id, null);
  });

  await t.test('HTTP roles/module access, source fields read only, archive instead of delete', async () => {
    const site = await fixture(), node = await create(site), request = requestListener(createServer(db));
    for (const role of ['viewer', 'verifier']) {
      assert.equal((await request(`/api/wbs/${node.id}`, { method: 'PATCH', cookie: auth.cookies[role], body: { description: 'Denied' } })).status, 403);
      assert.equal((await request('/api/wbs', { method: 'POST', cookie: auth.cookies[role], body: { site_id: site.id, wbs_code: 'DENIED' } })).status, 403);
    }
    assert.equal((await request(`/api/wbs/${node.id}`, { cookie: auth.cookies.viewer })).status, 200);
    assert.equal((await request(`/api/wbs/${node.id}`, { method: 'PATCH', cookie: auth.cookies.owner, body: { source_uuid: randomUUID() } })).status, 400);
    await db.run("INSERT INTO member_module_access (id, site_id, user_id, module, allowed, created_at, updated_at) VALUES (?, ?, ?, 'wbs', FALSE, ?, ?)", randomUUID(), site.id, auth.users.editor.id, '2026-11-16T22:00:00Z', '2026-11-16T22:00:00Z');
    assert.equal((await request(`/api/wbs/${node.id}`, { method: 'PATCH', cookie: auth.cookies.editor, body: { description: 'Denied' } })).status, 403);
    assert.equal((await request(`/api/wbs/${node.id}`, { method: 'DELETE', cookie: auth.cookies.owner })).status, 200);
    assert.ok((await getWbs(db, node.id)).archived_at);
  });

  await t.test('synthetic C03 fixture is idempotent, site isolated, linked to work/night diary; reset preserves unrelated data', async () => {
    await provisionDemoFixture(db);
    await withDemoEnvironment(() => seedDemo(db));
    const first = await db.all("SELECT id, site_id FROM project_structure WHERE wbs_code = 'C03' AND site_id IN (SELECT id FROM sites WHERE code IN ('FITT-03', 'FITT-05')) ORDER BY site_id");
    assert.equal(first.length, 2); assert.notEqual(first[0].id, first[1].id);
    const main = await db.get("SELECT * FROM sites WHERE code = 'FITT-03'");
    const c03 = first.find(row => row.site_id === main.id);
    const task = await db.get('SELECT * FROM tasks WHERE wbs_id = ?', c03.id);
    const item = await db.get('SELECT * FROM site_progress_items WHERE wbs_id = ?', c03.id);
    assert.ok(task); assert.ok(item);
    const booking = await db.get('SELECT * FROM time_bookings WHERE site_progress_item_id = ?', item.id); assert.ok(booking);
    assert.equal((await db.get('SELECT shift FROM work_days WHERE id = ?', booking.work_day_id)).shift, 'night');
    assert.ok(await db.get("SELECT id FROM diary WHERE site_id = ? AND shift = 'night' AND operational_date = '2026-11-16'", main.id));
    assert.ok(await db.get("SELECT entity_id FROM deviation_links WHERE entity_type = 'task' AND entity_id = ?", task.id));
    const counts = async () => Promise.all(['tasks', 'site_progress_items', 'time_bookings', 'diary', 'demo_seed_records'].map(async table => Number((await db.get(`SELECT COUNT(*) AS n FROM ${table}`)).n)));
    const before = await counts(); await withDemoEnvironment(() => seedDemo(db)); assert.deepEqual(await counts(), before);
    assert.deepEqual(await db.all("SELECT id, site_id FROM project_structure WHERE wbs_code = 'C03' AND site_id IN (SELECT id FROM sites WHERE code IN ('FITT-03', 'FITT-05')) ORDER BY site_id"), first);
    const unrelated = await createTask(db, { siteId: main.id, title: 'Unrelated synthetic task', executor: 'Other crew', verifier: 'Other checker' });
    await withDemoEnvironment(() => resetDemo(db));
    assert.equal((await getTask(db, unrelated.id)).title, 'Unrelated synthetic task');
    await withDemoEnvironment(() => seedDemo(db)); assert.equal((await getTask(db, unrelated.id)).title, 'Unrelated synthetic task');
  });
});

test('complete-snapshot declaration is bound to preview approval', () => {
  const input = { buffer: Buffer.from('synthetic workbook'), family: 'time_schedule', siteId: randomUUID(), rows: [], completeVerified: false };
  const token = previewToken(input);
  assert.throws(() => verifyPreviewToken(token, { ...input, completeVerified: true }), { code: 'PREVIEW_MISMATCH' });
});
