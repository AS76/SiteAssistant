import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { createSite } from '../server/repository.mjs';
import { createTool } from '../server/tools.mjs';
import { createServer } from '../server/http.mjs';
import { createHseAsset, listHseAssets, getHseAsset, updateHseAsset, deleteHseAsset } from '../server/hse-assets.mjs';
import { findTemplate } from '../server/checklists.mjs';
import { listAuditEvents } from '../server/audit.mjs';
import { saveModuleAccess } from '../server/module-access.mjs';
import { translatePlaceholders } from '../server/storage/pg.mjs';
import { migrate } from '../server/migrations/index.mjs';
import { authFixture } from './helpers/auth.mjs';
import { isPg, openTestDb, openSqliteTestDb } from './helpers/db.mjs';

async function database(t, driver) {
  if (driver === 'sqlite' || isPg) {
    const fixture = await (driver === 'sqlite' ? openSqliteTestDb() : openTestDb());
    t.after(fixture.close);
    return fixture.db;
  }
  const pg = new PGlite();
  t.after(() => pg.close());
  const adapt = connection => ({
    exec: sql => connection.exec(sql),
    all: async (sql, ...values) => (await connection.query(translatePlaceholders(sql), values)).rows,
    get: async (sql, ...values) => (await connection.query(translatePlaceholders(sql), values)).rows[0],
    run: async (sql, ...values) => ({ rowCount: (await connection.query(translatePlaceholders(sql), values)).affectedRows }),
    isUniqueViolation: error => error.code === '23505',
  });
  const db = { ...adapt(pg), transaction: fn => pg.transaction(tx => fn(adapt(tx))) };
  await migrate(db, { driver });
  return db;
}

for (const driver of ['sqlite', 'pg']) test(`HSE assets ${driver === 'pg' && !isPg ? 'PGlite' : driver}`, async t => {
  const db = await database(t, driver);
  const { users, cookies } = await authFixture(db);
  const fixture = async (jurisdiction = 'IT', roles = ['owner', 'editor', 'verifier', 'viewer']) => {
    const site = await createSite(db, { code: randomUUID(), name: 'Synthetic asset site', jurisdiction });
    for (const role of roles) await db.run('INSERT INTO site_members VALUES (?, ?, ?)', site.id, users[role].id, role);
    return {
      site,
      create: (input = {}, user = users.owner) => createHseAsset(db, {
        siteId: site.id, templateCode: `${jurisdiction.toLowerCase()}_lifting`, name: 'Synthetic asset', ...input,
      }, user),
      list: (user = users.verifier) => listHseAssets(db, { siteId: site.id }, user),
    };
  };
  const error = (status, code) => ({ status, code });

  await t.test('create derives classification, ignores body classification and trims text', async t => {
    const f = await fixture();
    const row = await f.create({ name: '  Synthetic crane  ', kind: 'ppe', category: 'arbitrary',
      code: ' C-1 ', notes: ' Example note ' });
    t.assert.strictEqual(row.name, 'Synthetic crane');
    t.assert.strictEqual(row.kind, 'tool');
    t.assert.strictEqual(row.category, 'lifting');
    t.assert.strictEqual(row.template_code, 'it_lifting');
    t.assert.strictEqual(row.code, 'C-1');
    t.assert.strictEqual(row.notes, 'Example note');
    t.assert.strictEqual(Boolean(row.active), true);
    t.assert.strictEqual(row.tool_id, null);
    t.assert.strictEqual(row.deleted_at, null);
    t.assert.match(row.id, /^[0-9a-f-]{36}$/);
    t.assert.ok(Number.isFinite(Date.parse(row.created_at)));
    t.assert.strictEqual(new Date(row.created_at).toISOString(), new Date(row.updated_at).toISOString());
  });

  await t.test('Italian sites reject British templates on create and patch', async t => {
    const f = await fixture(), row = await f.create();
    await t.assert.rejects(() => f.create({ name: 'Mismatch', templateCode: 'uk_lifting' }),
      error(400, 'TEMPLATE_JURISDICTION_MISMATCH'));
    await t.assert.rejects(() => updateHseAsset(db, row.id, { templateCode: 'uk_ppe' }, users.owner),
      error(400, 'TEMPLATE_JURISDICTION_MISMATCH'));
    t.assert.strictEqual((await getHseAsset(db, row.id, users.verifier)).template_code, 'it_lifting');
    const british = await fixture('UK');
    t.assert.strictEqual((await british.create()).template_code, 'uk_lifting');
  });

  await t.test('unknown and missing template codes are validation errors', async t => {
    const f = await fixture(), row = await f.create();
    for (const templateCode of ['unknown_template', '', null, undefined, 42, {}]) {
      await t.assert.rejects(() => f.create({ templateCode }), error(400, 'VALIDATION_ERROR'));
      await t.assert.rejects(() => updateHseAsset(db, row.id, { templateCode }, users.owner), error(400, 'VALIDATION_ERROR'));
    }
  });

  await t.test('duplicate names conflict within a site and are accepted across sites', async t => {
    const f = await fixture(), other = await fixture();
    const row = await f.create();
    await t.assert.rejects(() => f.create({ name: '  Synthetic asset  ' }), error(409, 'DUPLICATE_ASSET_NAME'));
    t.assert.strictEqual((await other.create()).name, row.name);
    const second = await f.create({ name: 'Second asset' });
    await t.assert.rejects(() => updateHseAsset(db, second.id, { name: row.name }, users.owner),
      error(409, 'DUPLICATE_ASSET_NAME'));
    t.assert.strictEqual((await getHseAsset(db, second.id, users.verifier)).name, 'Second asset');
    t.assert.strictEqual((await db.all("SELECT * FROM audit_events WHERE entity_id = ? AND action = 'update'", second.id)).length, 0);
  });

  await t.test('soft delete preserves rows, hides them and allows repeated name reuse', async t => {
    const f = await fixture();
    for (let i = 0; i < 3; i++) {
      const row = await f.create();
      const removed = await deleteHseAsset(db, row.id, users.editor);
      t.assert.strictEqual(removed.id, row.id);
      t.assert.strictEqual(removed.name, row.name);
      t.assert.ok(Number.isFinite(Date.parse(removed.deleted_at)));
      t.assert.deepStrictEqual(await f.list(), []);
      t.assert.ok((await db.get('SELECT * FROM hse_assets WHERE id = ?', row.id)).deleted_at);
      for (const call of [
        () => getHseAsset(db, row.id, users.verifier),
        () => updateHseAsset(db, row.id, {}, users.owner),
        () => deleteHseAsset(db, row.id, users.owner),
      ]) await t.assert.rejects(call, error(404, 'HSE_ASSET_NOT_FOUND'));
    }
    const replacement = await f.create();
    const stored = await db.all('SELECT * FROM hse_assets WHERE site_id = ?', f.site.id);
    t.assert.strictEqual(stored.length, 4);
    for (const row of stored.filter(row => row.deleted_at)) {
      t.assert.strictEqual(row.name, `Synthetic asset (deleted ${row.id})`);
    }
    t.assert.deepStrictEqual((await f.list()).map(row => row.id), [replacement.id]);
  });

  await t.test('patch re-derives classification and changes only allowed columns', async t => {
    const f = await fixture(), row = await f.create({ code: 'OLD', notes: 'Initial note' });
    const changed = await updateHseAsset(db, row.id.toUpperCase(), {
      templateCode: 'it_ppe', kind: 'site_work', category: 'arbitrary', name: '  PPE set  ',
      code: ' ', notes: null, active: false, siteId: randomUUID(), toolId: randomUUID(), deleted_at: '2026-01-01',
    }, users.editor);
    t.assert.strictEqual(changed.template_code, 'it_ppe');
    t.assert.strictEqual(changed.kind, 'ppe');
    t.assert.strictEqual(changed.category, 'ppe');
    t.assert.strictEqual(changed.name, 'PPE set');
    t.assert.strictEqual(changed.code, null);
    t.assert.strictEqual(changed.notes, null);
    t.assert.strictEqual(Boolean(changed.active), false);
    t.assert.strictEqual(changed.site_id, f.site.id);
    t.assert.strictEqual(changed.tool_id, null);
    t.assert.strictEqual(changed.deleted_at, null);
    t.assert.strictEqual(new Date(changed.created_at).toISOString(), new Date(row.created_at).toISOString());
    const unchanged = await updateHseAsset(db, row.id, { kind: 'tool', category: 'lifting' }, users.owner);
    t.assert.deepStrictEqual(unchanged, changed);
    t.assert.strictEqual(Boolean((await updateHseAsset(db, row.id, { active: true }, users.owner)).active), true);
  });

  await t.test('patch can reuse a soft-deleted name', async t => {
    const f = await fixture(), previous = await f.create({ name: 'Reusable' });
    const row = await f.create({ name: 'Initial' });
    await deleteHseAsset(db, previous.id, users.owner);
    const changed = await updateHseAsset(db, row.id, { name: 'Reusable' }, users.editor);
    t.assert.strictEqual(changed.name, 'Reusable');
    t.assert.strictEqual((await db.get('SELECT name FROM hse_assets WHERE id = ?', previous.id)).name,
      `Reusable (deleted ${previous.id})`);
  });

  await t.test('tool links must reference an existing tool in the same site', async t => {
    const f = await fixture(), other = await fixture();
    const tool = await createTool(db, { siteId: f.site.id, name: 'Synthetic crane' }, users.owner);
    const foreign = await createTool(db, { siteId: other.site.id, name: 'Other crane' }, users.owner);
    for (const toolId of [foreign.id, randomUUID(), 'invalid', '']) {
      await t.assert.rejects(() => f.create({ toolId }), error(400, 'VALIDATION_ERROR'));
    }
    t.assert.strictEqual((await f.create({ toolId: tool.id.toUpperCase() })).tool_id, tool.id);
  });

  await t.test('role matrix permits owner and editor writes, HSE readers read', async t => {
    const f = await fixture(), row = await f.create();
    for (const role of ['owner', 'editor']) {
      const created = await f.create({ name: `Asset ${role}` }, users[role]);
      t.assert.strictEqual((await updateHseAsset(db, created.id, { notes: role }, users[role])).notes, role);
      t.assert.strictEqual((await deleteHseAsset(db, created.id, users[role])).id, created.id);
    }
    for (const role of ['viewer', 'verifier']) {
      for (const call of [
        () => f.create({ name: 'Denied' }, users[role]),
        () => updateHseAsset(db, row.id, { name: 'Denied' }, users[role]),
        () => deleteHseAsset(db, row.id, users[role]),
      ]) await t.assert.rejects(call, error(403, 'FORBIDDEN'));
    }
    for (const role of ['owner', 'editor', 'verifier']) {
      t.assert.deepStrictEqual((await f.list(users[role])).map(row => row.id), [row.id]);
      t.assert.strictEqual((await getHseAsset(db, row.id, users[role])).id, row.id);
    }
    await t.assert.rejects(() => f.list(users.viewer), error(403, 'FORBIDDEN'));
    await t.assert.rejects(() => getHseAsset(db, row.id, users.viewer), error(403, 'FORBIDDEN'));
    const nonmember = await fixture('IT', ['owner']);
    const other = await nonmember.create();
    for (const call of [
      () => nonmember.list(users.verifier),
      () => getHseAsset(db, other.id, users.verifier),
      () => nonmember.create({ name: 'Denied' }, users.verifier),
      () => updateHseAsset(db, other.id, {}, users.verifier),
      () => deleteHseAsset(db, other.id, users.verifier),
    ]) await t.assert.rejects(call, error(403, 'FORBIDDEN'));
  });

  await t.test('HSE module denial blocks reads and writes', async t => {
    const f = await fixture(), row = await f.create();
    await saveModuleAccess(db, { siteId: f.site.id, memberId: users.editor.id,
      module: 'hse', allowed: false }, users.owner);
    for (const call of [
      () => f.list(users.editor),
      () => getHseAsset(db, row.id, users.editor),
      () => f.create({ name: 'Denied' }, users.editor),
      () => updateHseAsset(db, row.id, {}, users.editor),
      () => deleteHseAsset(db, row.id, users.editor),
    ]) await t.assert.rejects(call, error(403, 'MODULE_FORBIDDEN'));
    t.assert.strictEqual((await f.list(users.owner)).length, 1);
  });

  await t.test('list excludes deleted rows, orders by category and name and enriches metadata', async t => {
    const f = await fixture(), other = await fixture();
    const z = await f.create({ name: 'Z crane' });
    const a = await f.create({ name: 'A crane' });
    const ppe = await f.create({ name: 'PPE', templateCode: 'it_ppe', active: false });
    const scaffold = await f.create({ name: 'Scaffold', templateCode: 'it_scaffolding' });
    const removed = await f.create({ name: 'Hidden' });
    await deleteHseAsset(db, removed.id, users.owner);
    await other.create();
    const rows = await listHseAssets(db, { siteId: f.site.id.toUpperCase() }, users.verifier);
    t.assert.deepStrictEqual(rows.map(row => row.id), [a.id, z.id, ppe.id, scaffold.id]);
    for (const row of rows) {
      t.assert.strictEqual(row.templateTitle, findTemplate(row.template_code).title);
      t.assert.strictEqual(row.jurisdiction, 'IT');
      t.assert.strictEqual(row.deleted_at, null);
    }
  });

  await t.test('field limits, types, UUIDs and authentication are validated', async t => {
    const f = await fixture(), row = await f.create();
    for (const input of [
      { name: '' }, { name: ' ' }, { name: null }, { name: 42 }, { name: 'n'.repeat(201) },
      { code: 'c'.repeat(61) }, { code: 42 }, { notes: 'n'.repeat(2001) }, { notes: [] },
      { active: null }, { active: 1 }, { active: 'true' },
    ]) {
      await t.assert.rejects(() => f.create(input), error(400, 'VALIDATION_ERROR'));
      await t.assert.rejects(() => updateHseAsset(db, row.id, input, users.owner), error(400, 'VALIDATION_ERROR'));
    }
    await f.create({ name: 'n'.repeat(200), code: 'c'.repeat(60), notes: 'n'.repeat(2000), active: false });
    for (const input of [null, [], 'invalid']) {
      await t.assert.rejects(() => createHseAsset(db, input, users.owner), error(400, 'VALIDATION_ERROR'));
      await t.assert.rejects(() => updateHseAsset(db, row.id, input, users.owner), error(400, 'VALIDATION_ERROR'));
    }
    for (const call of [
      () => listHseAssets(db, { siteId: 'invalid' }, users.verifier),
      () => f.create({ siteId: 'invalid' }),
      () => getHseAsset(db, 'invalid', users.verifier),
      () => updateHseAsset(db, 'invalid', {}, users.owner),
      () => deleteHseAsset(db, 'invalid', users.owner),
    ]) await t.assert.rejects(call, error(400, 'VALIDATION_ERROR'));
    for (const call of [
      () => f.list(null), () => getHseAsset(db, row.id, null), () => f.create({}, null),
      () => updateHseAsset(db, row.id, {}, null), () => deleteHseAsset(db, row.id, null),
    ]) await t.assert.rejects(call, error(401, 'UNAUTHENTICATED'));
  });

  await t.test('create, update and delete audit rows record actors and stored snapshots', async t => {
    const f = await fixture(), row = await f.create();
    await updateHseAsset(db, row.id, { templateCode: 'it_ppe', notes: 'Updated' }, users.editor);
    await deleteHseAsset(db, row.id, users.owner);
    const events = await listAuditEvents(db, { siteId: f.site.id, entityType: 'hse_asset', entityId: row.id }, users.owner);
    t.assert.strictEqual(events.length, 3);
    for (const action of ['create', 'update', 'delete']) {
      const event = events.find(row => row.action === action);
      t.assert.strictEqual(event.actor, users[action === 'update' ? 'editor' : 'owner'].id);
      const changes = typeof event.changes === 'string' ? JSON.parse(event.changes) : event.changes;
      t.assert.ok(!Object.hasOwn(changes, 'templateTitle'));
      t.assert.ok(!Object.hasOwn(changes, 'jurisdiction'));
      if (action === 'update') {
        t.assert.deepStrictEqual(changes.kind, { from: 'tool', to: 'ppe' });
        t.assert.deepStrictEqual(changes.category, { from: 'lifting', to: 'ppe' });
      } else t.assert.strictEqual(changes.id, row.id);
    }
  });

  await t.test('audit failure rolls back the asset write and deleted-name recovery', async t => {
    const f = await fixture(), old = await f.create();
    await deleteHseAsset(db, old.id, users.owner);
    const failing = { transaction: fn => db.transaction(tx => fn({ ...tx,
      run: (sql, ...values) => {
        if (sql.startsWith('INSERT INTO audit_events')) throw new Error('Synthetic audit failure');
        return tx.run(sql, ...values);
      },
    })) };
    await t.assert.rejects(() => createHseAsset(failing, { siteId: f.site.id,
      name: old.name, templateCode: 'it_lifting' }, users.owner), /Synthetic audit failure/);
    const rows = await db.all('SELECT * FROM hse_assets WHERE site_id = ?', f.site.id);
    t.assert.strictEqual(rows.length, 1);
    t.assert.strictEqual(rows[0].name, old.name);
    t.assert.deepStrictEqual(await f.list(), []);
    t.assert.strictEqual((await f.create()).name, old.name);
  });

  await t.test('migration enforces kind, foreign keys, uniqueness and site-kind index', async t => {
    const f = await fixture(), row = await f.create();
    t.assert.strictEqual(await migrate(db, { driver }), 0);
    const insert = (siteId, kind, name, toolId = null) => db.run(`INSERT INTO hse_assets
      (id, site_id, kind, category, name, tool_id, template_code, created_at, updated_at)
      VALUES (?, ?, ?, 'lifting', ?, ?, 'it_lifting', ?, ?)`,
    randomUUID(), siteId, kind, name, toolId, row.created_at, row.updated_at);
    await t.assert.rejects(() => insert(f.site.id, 'unknown', 'Invalid kind'), /check/i);
    await t.assert.rejects(() => insert(randomUUID(), 'tool', 'Missing site'), /foreign key/i);
    await t.assert.rejects(() => insert(f.site.id, 'tool', 'Missing tool', randomUUID()), /foreign key/i);
    await t.assert.rejects(() => insert(f.site.id, 'tool', row.name), /unique/i);
    await insert(f.site.id, 'tool', 'Default active');
    const defaults = await db.get('SELECT active FROM hse_assets WHERE site_id = ? AND name = ?', f.site.id, 'Default active');
    t.assert.strictEqual(Boolean(defaults.active), true);
    if (driver === 'sqlite') {
      t.assert.deepStrictEqual((await db.all('PRAGMA index_info(hse_assets_site_kind)')).map(row => row.name), ['site_id', 'kind']);
    } else {
      const index = await db.get("SELECT indexdef FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'hse_assets_site_kind'");
      t.assert.match(index.indexdef, /\(site_id, kind\)/);
      const columns = await db.all("SELECT column_name, udt_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'hse_assets'");
      for (const [name, type] of [['id', 'uuid'], ['site_id', 'uuid'], ['tool_id', 'uuid'], ['active', 'bool'],
        ['deleted_at', 'timestamptz'], ['created_at', 'timestamptz'], ['updated_at', 'timestamptz']]) {
        t.assert.strictEqual(columns.find(row => row.column_name === name).udt_name, type);
      }
    }
  });

  await t.test('HTTP CRUD, errors, role matrix and module gates over a real socket', async t => {
    const server = createServer(db);
    t.after(async () => {
      if (server.listening) await new Promise((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
        server.closeAllConnections();
      });
    });
    // Socket admission errors must fail visibly; do not replace this with an in-process listener.
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    const api = async (path, { method = 'GET', body, role = 'owner' } = {}) => {
      const response = await fetch(`${base}${path}`, { method,
        headers: { ...(role ? { cookie: cookies[role] } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, body: await response.json() };
    };
    const f = await fixture(), other = await fixture(), nonmember = await fixture('IT', ['owner']);
    const path = '/api/hse/assets';
    const input = { siteId: f.site.id, templateCode: 'it_lifting', name: 'HTTP asset', kind: 'ppe', category: 'ppe' };
    const created = await api(path, { method: 'POST', body: input, role: 'editor' });
    t.assert.strictEqual(created.status, 201);
    t.assert.strictEqual(created.body.kind, 'tool');
    t.assert.strictEqual(created.body.category, 'lifting');
    const id = created.body.id;
    const listed = await api(`${path}?siteId=${f.site.id}`, { role: 'verifier' });
    t.assert.strictEqual(listed.status, 200);
    t.assert.deepStrictEqual(listed.body.map(row => row.id), [id]);
    t.assert.strictEqual(listed.body[0].templateTitle, findTemplate('it_lifting').title);
    t.assert.strictEqual(listed.body[0].jurisdiction, 'IT');
    const patched = await api(`${path}/${id}`, { method: 'PATCH', role: 'editor', body: { templateCode: 'it_ppe', active: false } });
    t.assert.strictEqual(patched.status, 200);
    t.assert.strictEqual(patched.body.kind, 'ppe');
    t.assert.strictEqual(patched.body.category, 'ppe');
    const foreignTool = await createTool(db, { siteId: other.site.id, name: 'Foreign tool' }, users.owner);
    for (const [url, method, body, role, status, code] of [
      [path, 'POST', input, 'viewer', 403, 'FORBIDDEN'],
      [`${path}?siteId=${f.site.id}`, 'GET', undefined, 'viewer', 403, 'FORBIDDEN'],
      [`/api/hse/inspection-templates?siteId=${f.site.id}`, 'GET', undefined, 'viewer', 403, 'FORBIDDEN'],
      [`${path}/${id}`, 'PATCH', {}, 'viewer', 403, 'FORBIDDEN'],
      [`${path}/${id}`, 'DELETE', undefined, 'viewer', 403, 'FORBIDDEN'],
      [path, 'POST', input, 'verifier', 403, 'FORBIDDEN'],
      [path, 'POST', { ...input, siteId: nonmember.site.id }, 'verifier', 403, 'FORBIDDEN'],
      [`${path}?siteId=${nonmember.site.id}`, 'GET', undefined, 'verifier', 403, 'FORBIDDEN'],
      [path, 'POST', input, 'owner', 409, 'DUPLICATE_ASSET_NAME'],
      [path, 'POST', { ...input, templateCode: 'uk_lifting' }, 'owner', 400, 'TEMPLATE_JURISDICTION_MISMATCH'],
      [path, 'POST', { ...input, templateCode: 'unknown' }, 'owner', 400, 'VALIDATION_ERROR'],
      [path, 'POST', { ...input, toolId: foreignTool.id }, 'owner', 400, 'VALIDATION_ERROR'],
      [`${path}/${id}`, 'PATCH', { templateCode: 'uk_ppe' }, 'editor', 400, 'TEMPLATE_JURISDICTION_MISMATCH'],
      [`${path}?siteId=invalid`, 'GET', undefined, 'owner', 400, 'VALIDATION_ERROR'],
      [`${path}?siteId=${f.site.id}`, 'GET', undefined, null, 401, 'AUTH_REQUIRED'],
    ]) {
      const response = await api(url, { method, body, role });
      t.assert.strictEqual(response.status, status, `${method} ${url}`);
      t.assert.strictEqual(response.body.code, code);
    }
    t.assert.strictEqual((await api(path, { method: 'POST', body: { ...input, siteId: other.site.id } })).status, 201);
    await saveModuleAccess(db, { siteId: f.site.id, memberId: users.editor.id, module: 'hse', allowed: false }, users.owner);
    for (const [url, method, body] of [
      [`${path}?siteId=${f.site.id}`, 'GET'], [path, 'POST', input], [`${path}/${id}`, 'PATCH', {}], [`${path}/${id}`, 'DELETE'],
    ]) {
      const response = await api(url, { method, body, role: 'editor' });
      t.assert.strictEqual(response.status, 403);
      t.assert.strictEqual(response.body.code, 'MODULE_FORBIDDEN');
    }
    const removed = await api(`${path}/${id}`, { method: 'DELETE' });
    t.assert.strictEqual(removed.status, 200);
    t.assert.strictEqual(removed.body.id, id);
    t.assert.ok(removed.body.deleted_at);
    t.assert.deepStrictEqual((await api(`${path}?siteId=${f.site.id}`)).body, []);
    t.assert.ok((await db.get('SELECT deleted_at FROM hse_assets WHERE id = ?', id)).deleted_at);
    t.assert.strictEqual((await api(path, { method: 'POST', body: input })).status, 201);
  });
});
