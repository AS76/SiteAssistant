import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createSite } from '../server/repository.mjs';
import { createServer } from '../server/http.mjs';
import { listSiteProgress, getSiteProgressItem } from '../server/site-progress.mjs';
import { applyMigration } from '../server/migrations/index.mjs';
import { authFixture, requestListener } from './helpers/auth.mjs';
import { isPg, openTestDb, openSqliteTestDb } from './helpers/db.mjs';
import { siteProgressDatabase } from './helpers/site-progress.mjs';

for (const driver of ['sqlite', 'pg']) test(`Progress types ${driver}: weighted steps and effective progress`, async t => {
  let db;
  if (driver === 'pg' && !isPg) db = await siteProgressDatabase(t, driver);
  else {
    const database = await (driver === 'sqlite' ? openSqliteTestDb() : openTestDb());
    db = database.db; t.after(database.close);
  }
  const auth = await authFixture(db), api = requestListener(createServer(db));
  const otherSite = async () => {
    const site = await createSite(db, { code: randomUUID(), name: 'Synthetic other site' });
    for (const user of Object.values(auth.users)) await db.run('INSERT INTO site_members VALUES (?, ?, ?)', site.id, user.id, 'owner');
    return site;
  };
  const fixture = async () => {
    const site = await createSite(db, { code: randomUUID(), name: 'Synthetic progress type site' });
    for (const [role, user] of Object.entries(auth.users)) {
      if (role === 'verifier') continue; // the verifier deliberately has no membership here
      await db.run('INSERT INTO site_members VALUES (?, ?, ?)', site.id, user.id, role);
    }
    const items = [randomUUID(), randomUUID()];
    const at = '2026-11-10T08:00:00.000Z';
    for (const [index, id] of items.entries()) {
      await db.run(`INSERT INTO site_progress_items (id, site_id, description, progress_pct, source_row, created_at)
        VALUES (?, ?, ?, ?, ?, ?)`, id, site.id, `Synthetic item ${index + 1}`, 42, index + 1, at);
    }
    return { site, items };
  };
  const call = (path, { method = 'GET', body, role = 'owner' } = {}) => api(path,
    { method, ...(body === undefined ? {} : { body }), ...(role ? { cookie: auth.cookies[role] } : {}) });
  const typeBody = (siteId, extra = {}) => ({ site_id: siteId, code: 'TYPE-A', name: 'Synthetic type',
    steps: [{ code: 'S1', position: 1, weight: 60, description: 'Step one' }, { code: 'S2', position: 2, weight: 40 }], ...extra });
  const createType = async (siteId, extra, role = 'owner') => call('/api/progress-types', { method: 'POST', body: typeBody(siteId, extra), role });

  await t.test('owner creates a type, viewer lists it, editor writes weighted step percentages', async t => {
    const f = await fixture();
    const created = await createType(f.site.id);
    t.assert.strictEqual(created.status, 201);
    t.assert.strictEqual(created.body.steps.length, 2);
    t.assert.strictEqual(created.body.steps[0].weight, 60);
    const listed = await call(`/api/progress-types?site_id=${f.site.id}`, { role: 'viewer' });
    t.assert.strictEqual(listed.status, 200); t.assert.strictEqual(listed.body.length, 1);
    t.assert.deepStrictEqual(listed.body[0].steps.map(step => step.code), ['S1', 'S2']);

    const assigned = await call(`/api/site-progress/${f.items[0]}/progress-type`,
      { method: 'PATCH', body: { progress_type_id: created.body.id } });
    t.assert.strictEqual(assigned.status, 200);
    t.assert.strictEqual(assigned.body.progress_pct, 0); // a type means computed: no state yet reads as zero
    t.assert.strictEqual(assigned.body.progress_pct_source, 'computed');
    t.assert.strictEqual(assigned.body.steps.length, 2);
    t.assert.strictEqual(assigned.body.steps[0].percent, null);

    // Weights are percentages: (60*100 + 40*0) / 100 = 60.
    const [first, second] = created.body.steps;
    const written = await call(`/api/site-progress/${f.items[0]}/steps`, { method: 'PUT', role: 'editor',
      body: { steps: [{ step_id: first.id, percent: 100 }, { step_id: second.id, percent: 0 }] } });
    t.assert.strictEqual(written.status, 200);
    t.assert.strictEqual(written.body.progress_pct, 60);
    t.assert.strictEqual(written.body.progress_pct_source, 'computed');
    t.assert.deepStrictEqual(written.body.steps.map(step => step.percent), [100, 0]);

    const detail = await call(`/api/site-progress/${f.items[0]}`, { role: 'viewer' });
    const { booked_hours, ...writtenItem } = detail.body;
    t.assert.strictEqual(booked_hours, 0);
    t.assert.deepStrictEqual(writtenItem, written.body);
    const list = await call(`/api/site-progress?site_id=${f.site.id}`, { role: 'viewer' });
    const row = list.body.find(item => item.id === f.items[0]);
    t.assert.strictEqual(row.progress_pct, 60);
    t.assert.strictEqual(row.progress_pct_source, 'computed');
    t.assert.strictEqual(list.body.find(item => item.id === f.items[1]).progress_pct, 42);
  });

  await t.test('unset steps count as zero; removing the type restores the imported value and keeps states', async t => {
    const f = await fixture();
    const type = (await createType(f.site.id)).body;
    await call(`/api/site-progress/${f.items[0]}/progress-type`, { method: 'PATCH', body: { progress_type_id: type.id } });
    const untouched = await call(`/api/site-progress/${f.items[0]}`, { role: 'viewer' });
    t.assert.strictEqual(untouched.body.progress_pct, 0); // stored 42 must not leak into a computed 0
    t.assert.strictEqual(untouched.body.progress_pct_source, 'computed');

    const before = await api(`/api/site-progress/${f.items[0]}`, { cookie: auth.cookies.viewer });
    t.assert.strictEqual(before.body.progress_pct, 0);
    await call(`/api/site-progress/${f.items[0]}/steps`, { method: 'PUT', role: 'editor',
      body: { steps: [{ step_id: type.steps[0].id, percent: 50 }] } });
    const removed = await call(`/api/site-progress/${f.items[0]}/progress-type`, { method: 'PATCH', body: { progress_type_id: null } });
    t.assert.strictEqual(removed.status, 200);
    t.assert.strictEqual(removed.body.progress_pct, 42); // imported value is never overwritten
    t.assert.strictEqual(removed.body.progress_pct_source, 'imported');
    t.assert.deepStrictEqual(removed.body.steps, []);
    const stored = await db.all('SELECT COUNT(*) AS n FROM site_progress_item_steps WHERE site_progress_item_id = ?', f.items[0]);
    t.assert.strictEqual(Number(stored[0].n), 1);
    const reassigned = await call(`/api/site-progress/${f.items[0]}/progress-type`, { method: 'PATCH', body: { progress_type_id: type.id } });
    t.assert.strictEqual(reassigned.body.progress_pct, 30); // (60*50)/100
    t.assert.strictEqual(reassigned.body.progress_pct_source, 'computed');
  });

  await t.test('authentication and roles: viewer/verifier read only, owner assigns, editor writes', async t => {
    const f = await fixture();
    for (const [path, options] of [['/api/progress-types?site_id=' + f.site.id, {}],
      ['/api/progress-types', { method: 'POST', body: typeBody(f.site.id) }],
      [`/api/site-progress/${f.items[0]}/progress-type`, { method: 'PATCH', body: { progress_type_id: null } }],
      [`/api/site-progress/${f.items[0]}/steps`, { method: 'PUT', body: { steps: [{ step_id: randomUUID(), percent: 10 }] } }]]) {
      t.assert.strictEqual((await call(path, { ...options, role: null })).status, 401);
    }
    t.assert.strictEqual((await createType(f.site.id, undefined, 'viewer')).status, 403);
    t.assert.strictEqual((await createType(f.site.id, undefined, 'editor')).status, 403);
    const type = (await createType(f.site.id)).body;
    for (const role of ['viewer', 'verifier']) {
      t.assert.strictEqual((await call(`/api/site-progress/${f.items[0]}/progress-type`,
        { method: 'PATCH', body: { progress_type_id: type.id }, role })).status, 403);
      t.assert.strictEqual((await call(`/api/site-progress/${f.items[0]}/steps`,
        { method: 'PUT', body: { steps: [{ step_id: type.steps[0].id, percent: 10 }] }, role })).status, 403);
    }
    // The verifier has no membership in this site at all: 403 before the role check.
    const noMembership = await call(`/api/progress-types?site_id=${f.site.id}`, { role: 'verifier' });
    t.assert.strictEqual(noMembership.status, 403);
  });

  await t.test('validation: weights, positions, cross-site types, foreign steps and percent range', async t => {
    const f = await fixture(), other = await otherSite();
    const err = async (response, status, code) => {
      t.assert.strictEqual(response.status, status); t.assert.strictEqual(response.body.code, code);
    };
    await err(await createType(f.site.id, { steps: [{ code: 'S', position: 1, weight: 0 }] }), 400, 'VALIDATION_ERROR');
    await err(await createType(f.site.id, { steps: [{ code: 'S', position: 1, weight: 10 }, { code: 'T', position: 2, weight: 20 }] }), 400, 'WEIGHTS_NOT_100');
    await err(await createType(f.site.id, { steps: [{ code: 'S', position: 1, weight: 'abc' }] }), 400, 'VALIDATION_ERROR');
    await err(await createType(f.site.id, { steps: [{ code: 'S', position: 1, weight: 1 }, { code: 'S', position: 2, weight: 1 }] }), 400, 'VALIDATION_ERROR');
    await err(await createType(f.site.id, { steps: [{ code: 'S', position: 'x', weight: 1 }] }), 400, 'VALIDATION_ERROR');
    const tooMany = Array.from({ length: 101 }, (_, index) => ({ code: `S${index}`, position: index + 1, weight: 1 }));
    await err(await createType(f.site.id, { steps: tooMany }), 400, 'VALIDATION_ERROR');
    const duplicate = await createType(f.site.id);
    t.assert.strictEqual(duplicate.status, 201);
    await err(await createType(f.site.id), 409, 'PROGRESS_TYPE_DUPLICATE');

    const foreign = (await createType(other.id)).body;
    await err(await call(`/api/site-progress/${f.items[0]}/progress-type`, { method: 'PATCH', body: { progress_type_id: foreign.id } }),
      400, 'PROGRESS_TYPE_SITE_MISMATCH');
    await err(await call(`/api/site-progress/${f.items[0]}/progress-type`, { method: 'PATCH', body: { progress_type_id: randomUUID() } }),
      404, 'PROGRESS_TYPE_NOT_FOUND');

    const type = duplicate.body;
    await call(`/api/site-progress/${f.items[1]}/progress-type`, { method: 'PATCH', body: { progress_type_id: type.id } });
    await err(await call(`/api/site-progress/${f.items[1]}/steps`, { method: 'PUT',
      body: { steps: [{ step_id: foreign.steps[0].id, percent: 10 }] } }), 400, 'STEP_NOT_IN_TYPE');
    await err(await call(`/api/site-progress/${f.items[1]}/steps`, { method: 'PUT',
      body: { steps: [{ step_id: type.steps[0].id, percent: 101 }] } }), 400, 'VALIDATION_ERROR');
    await err(await call(`/api/site-progress/${f.items[1]}/steps`, { method: 'PUT',
      body: { steps: [{ step_id: type.steps[0].id, percent: 10 }, { step_id: type.steps[0].id, percent: 20 }] } }), 400, 'VALIDATION_ERROR');
    // No type assigned yet on the first item: steps cannot be written.
    await err(await call(`/api/site-progress/${f.items[0]}/steps`, { method: 'PUT',
      body: { steps: [{ step_id: type.steps[0].id, percent: 10 }] } }), 400, 'PROGRESS_TYPE_NOT_ASSIGNED');
  });

  await t.test('a type in use cannot be deleted; after unassignment deletion also clears retained states', async t => {
    const f = await fixture();
    const type = (await createType(f.site.id)).body;
    await call(`/api/site-progress/${f.items[0]}/progress-type`, { method: 'PATCH', body: { progress_type_id: type.id } });
    await call(`/api/site-progress/${f.items[0]}/steps`, { method: 'PUT', role: 'editor',
      body: { steps: [{ step_id: type.steps[0].id, percent: 25 }] } });
    const refused = await call(`/api/progress-types/${type.id}`, { method: 'DELETE' });
    t.assert.strictEqual(refused.status, 409); t.assert.strictEqual(refused.body.code, 'PROGRESS_TYPE_IN_USE');
    await call(`/api/site-progress/${f.items[0]}/progress-type`, { method: 'PATCH', body: { progress_type_id: null } });
    const deleted = await call(`/api/progress-types/${type.id}`, { method: 'DELETE' });
    t.assert.strictEqual(deleted.status, 200); t.assert.deepStrictEqual(deleted.body, { deleted: true });
    t.assert.deepStrictEqual(await db.all('SELECT id FROM progress_type_steps WHERE progress_type_id = ?', type.id), []);
    t.assert.deepStrictEqual((await call(`/api/progress-types?site_id=${f.site.id}`, { role: 'viewer' })).body, []);
    t.assert.strictEqual((await call(`/api/progress-types/${type.id}`, { method: 'DELETE' })).status, 404);
  });

  await t.test('migration replay preserves rows and constraints are enforced', async t => {
    const f = await fixture();
    const type = (await createType(f.site.id)).body;
    await call(`/api/site-progress/${f.items[0]}/progress-type`, { method: 'PATCH', body: { progress_type_id: type.id } });
    await call(`/api/site-progress/${f.items[0]}/steps`, { method: 'PUT', role: 'editor',
      body: { steps: [{ step_id: type.steps[0].id, percent: 40 }] } });
    const before = await getSiteProgressItem(db, f.items[0]);
    t.assert.strictEqual(before.progress_pct, 24); // (60*40)/100
    // PostgreSQL keeps ADD COLUMN IF NOT EXISTS; SQLite cannot replay an additive column, by design.
    if (driver === 'pg') {
      await db.transaction(tx => applyMigration(tx, '014_progress_types.sql', { driver }));
      t.assert.deepStrictEqual(await getSiteProgressItem(db, f.items[0]), before);
    }
    await t.assert.rejects(() => db.run('INSERT INTO progress_types (id, site_id, code, name, created_at) VALUES (?, ?, ?, ?, ?)',
      randomUUID(), f.site.id, type.code, 'Duplicate', '2026-11-10T08:00:00.000Z'), /unique/i);
    await t.assert.rejects(() => db.run('INSERT INTO progress_type_steps (id, progress_type_id, position, code, weight) VALUES (?, ?, ?, ?, ?)',
      randomUUID(), type.id, 99, 'S9', 0), /check/i);
    await t.assert.rejects(() => db.run('INSERT INTO site_progress_item_steps (id, site_progress_item_id, progress_type_step_id, percent, updated_at) VALUES (?, ?, ?, ?, ?)',
      randomUUID(), f.items[0], type.steps[1].id, 120, '2026-11-10T08:00:00.000Z'), /check/i);
    await t.assert.rejects(() => db.run('INSERT INTO site_progress_item_steps (id, site_progress_item_id, progress_type_step_id, percent, updated_at) VALUES (?, ?, ?, ?, ?)',
      randomUUID(), randomUUID(), type.steps[0].id, 10, '2026-11-10T08:00:00.000Z'), /foreign key/i);
  });
});
