import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { createSite } from '../server/repository.mjs';
import { createServer } from '../server/http.mjs';
import { listViews, createView, updateView, deleteView } from '../server/view-settings.mjs';
import { translatePlaceholders } from '../server/storage/pg.mjs';
import { applyMigration, migrate } from '../server/migrations/index.mjs';
import { authFixture, requestListener } from './helpers/auth.mjs';
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

for (const driver of ['sqlite', 'pg']) test(`Saved views ${driver}`, async t => {
  const db = await database(t, driver);
  const { users, cookies } = await authFixture(db);
  const api = requestListener(createServer(db));
  const payload = { filters: { status: ['todo'], section: null }, sort: { field: 'name', direction: 'asc' },
    columns: ['name', 'status'], custom: { preserved: true } };
  const fixture = async (roles = ['owner', 'editor', 'verifier', 'viewer']) => {
    const site = await createSite(db, { code: randomUUID(), name: 'Synthetic saved views site' });
    for (const role of roles) await db.run('INSERT INTO site_members VALUES (?, ?, ?)', site.id, users[role].id, role);
    return {
      site,
      create: (input = {}, user = users.editor) => createView(db, {
        siteId: site.id, module: 'tasks', name: 'Synthetic view', payload, ...input,
      }, user),
      list: (user = users.editor, module = 'tasks') => listViews(db, { siteId: site.id, module }, user),
    };
  };
  const error = (status, code) => ({ status, code });

  await t.test('shared and personal visibility, site owner exception, alphabetical order and opaque round trip', async t => {
    const f = await fixture();
    const privateView = await f.create({ name: 'B personal' });
    const shared = await f.create({ name: 'A shared', shared: true });
    const ownerPrivate = await f.create({ name: 'C owner personal' }, users.owner);
    const verifierPrivate = await f.create({ name: 'D verifier personal' }, users.verifier);
    t.assert.strictEqual(privateView.owner_id, users.editor.id);
    t.assert.strictEqual(privateView.shared, false);
    t.assert.strictEqual(shared.shared, true);
    t.assert.deepStrictEqual(privateView.payload, payload);
    t.assert.deepStrictEqual(JSON.parse((await db.get('SELECT payload FROM view_settings WHERE id = ?', privateView.id)).payload), payload);
    t.assert.strictEqual(new Date(privateView.created_at).toISOString(), new Date(privateView.updated_at).toISOString());
    t.assert.ok(Number.isFinite(Date.parse(privateView.created_at)));
    t.assert.deepStrictEqual((await f.list()).map(v => v.id), [shared.id, privateView.id]);
    t.assert.deepStrictEqual((await f.list(users.viewer)).map(v => v.id), [shared.id]);
    t.assert.deepStrictEqual((await f.list(users.verifier)).map(v => v.id), [shared.id, verifierPrivate.id]);
    t.assert.deepStrictEqual((await f.list(users.owner)).map(v => v.id), [shared.id, privateView.id, ownerPrivate.id, verifierPrivate.id]);
  });

  await t.test('all modules, site isolation, UUID normalization and non-members', async t => {
    const f = await fixture(), other = await fixture(['editor']);
    for (const module of ['tasks', 'deviations', 'progress', 'bookings', 'impacts', 'wbs']) {
      const view = await f.create({ module, siteId: f.site.id.toUpperCase() });
      t.assert.deepStrictEqual((await f.list(users.editor, module)).map(v => v.id), [view.id]);
    }
    await other.create({ shared: true });
    t.assert.strictEqual((await f.list()).length, 1);
    await t.assert.rejects(other.list(users.owner), error(403, 'VIEW_FORBIDDEN'));
    await t.assert.rejects(other.create({}, users.owner), error(403, 'VIEW_FORBIDDEN'));
    await t.assert.rejects(f.create({}, users.viewer), error(403, 'VIEW_FORBIDDEN'));
  });

  await t.test('trimmed duplicate names conflict within owner/site/module; rename rolls back on conflict', async t => {
    const f = await fixture();
    const first = await f.create({ name: '  Same  ' });
    t.assert.strictEqual(first.name, 'Same');
    await t.assert.rejects(f.create({ name: 'Same', shared: true }), error(409, 'VIEW_NAME_TAKEN'));
    await f.create({ name: 'Same' }, users.verifier);
    await f.create({ name: 'Same', module: 'wbs' });
    await (await fixture()).create({ name: 'Same' });
    const second = await f.create({ name: 'Second' });
    await t.assert.rejects(updateView(db, second.id, { name: 'Same', shared: true }, users.owner), error(409, 'VIEW_NAME_TAKEN'));
    t.assert.deepStrictEqual((await f.list()).find(v => v.id === second.id), second);
    t.assert.strictEqual((await updateView(db, first.id, { name: 'Same' }, users.editor)).name, 'Same');
  });

  await t.test('view owner and site owner update; patch preserves other fields and ownership', async t => {
    const f = await fixture(), view = await f.create();
    const initial = '2020-01-01T00:00:00.000Z';
    await db.run('UPDATE view_settings SET updated_at = ? WHERE id = ?', initial, view.id);
    const changed = await updateView(db, view.id.toUpperCase(), { name: 'Renamed', shared: true }, users.editor);
    t.assert.strictEqual(changed.name, 'Renamed');
    t.assert.ok(Date.parse(changed.updated_at) > Date.parse(initial));
    t.assert.strictEqual(new Date(changed.created_at).toISOString(), new Date(view.created_at).toISOString());
    t.assert.deepStrictEqual(changed.payload, payload);
    const adminChanged = await updateView(db, view.id, { payload: {}, shared: false,
      owner_id: users.owner.id, module: 'wbs', site_id: randomUUID() }, users.owner);
    t.assert.deepStrictEqual(adminChanged.payload, {});
    t.assert.strictEqual(adminChanged.shared, false);
    t.assert.strictEqual(adminChanged.owner_id, users.editor.id);
    t.assert.strictEqual(adminChanged.site_id, f.site.id);
    t.assert.strictEqual(adminChanged.module, 'tasks');
    t.assert.strictEqual(adminChanged.name, 'Renamed');
    t.assert.deepStrictEqual(await updateView(db, view.id, {}, users.editor), adminChanged);
  });

  await t.test('shared visibility never grants editing, sharing or deletion; site role is local', async t => {
    const f = await fixture();
    for (const shared of [false, true]) {
      const view = await f.create({ name: `Shared ${shared}`, shared });
      for (const user of [users.verifier, users.viewer]) {
        for (const patch of [{ name: 'Hijacked' }, { payload: {} }, { shared: !shared }]) {
          await t.assert.rejects(updateView(db, view.id, patch, user), error(403, 'VIEW_FORBIDDEN'));
        }
        await t.assert.rejects(deleteView(db, view.id, user), error(403, 'VIEW_FORBIDDEN'));
      }
    }
    const other = await fixture(['editor']), view = await other.create({ shared: true });
    await t.assert.rejects(updateView(db, view.id, { shared: false }, users.owner), error(403, 'VIEW_FORBIDDEN'));
    await t.assert.rejects(deleteView(db, view.id, users.owner), error(403, 'VIEW_FORBIDDEN'));
  });

  await t.test('delete by view owner or site owner; missing views return 404', async t => {
    const f = await fixture();
    for (const user of [users.editor, users.owner]) {
      const view = await f.create();
      t.assert.deepStrictEqual(await deleteView(db, view.id, user), { deleted: true });
      t.assert.deepStrictEqual(await f.list(), []);
      await t.assert.rejects(deleteView(db, view.id, user), error(404, 'VIEW_NOT_FOUND'));
      await t.assert.rejects(updateView(db, view.id, { name: 'Missing' }, user), error(404, 'VIEW_NOT_FOUND'));
    }
  });

  await t.test('existing view ownership requires membership, but creation alone requires a write role', async t => {
    const f = await fixture(), view = await f.create();
    await db.run("UPDATE site_members SET role = 'viewer' WHERE site_id = ? AND user_id = ?", f.site.id, users.editor.id);
    await t.assert.rejects(f.create({ name: 'Another' }), error(403, 'VIEW_FORBIDDEN'));
    t.assert.strictEqual((await updateView(db, view.id, { shared: true }, users.editor)).shared, true);
    await db.run('DELETE FROM site_members WHERE site_id = ? AND user_id = ?', f.site.id, users.editor.id);
    await t.assert.rejects(updateView(db, view.id, { shared: false }, users.editor), error(403, 'VIEW_FORBIDDEN'));
    await t.assert.rejects(deleteView(db, view.id, users.editor), error(403, 'VIEW_FORBIDDEN'));
  });

  await t.test('invalid inputs and UTF-8 payload boundary apply to create and patch', async t => {
    const f = await fixture(), view = await f.create();
    const circular = {}; circular.self = circular;
    for (const name of ['', '   ', 'n'.repeat(81), null, 4]) {
      await t.assert.rejects(f.create({ name }), error(400, 'VIEW_INVALID'));
      await t.assert.rejects(updateView(db, view.id, { name }, users.editor), error(400, 'VIEW_INVALID'));
    }
    await f.create({ name: 'n'.repeat(80) });
    for (const module of ['diary', 'TASKS', '', undefined, null]) {
      await t.assert.rejects(f.create({ module }), error(400, 'VIEW_INVALID'));
      await t.assert.rejects(listViews(db, { siteId: f.site.id, module }, users.editor), error(400, 'VIEW_INVALID'));
    }
    for (const shared of [null, 1, 'true']) {
      await t.assert.rejects(f.create({ shared }), error(400, 'VIEW_INVALID'));
      await t.assert.rejects(updateView(db, view.id, { shared }, users.editor), error(400, 'VIEW_INVALID'));
    }
    const boundary = { x: 'a'.repeat(16376) };
    t.assert.strictEqual(Buffer.byteLength(JSON.stringify(boundary)), 16384);
    for (const payload of [undefined, null, [], 'string', 42, circular, { x: 1n }, new Date(), boundary,
      { x: 'é'.repeat(8190) }]) {
      await t.assert.rejects(f.create({ payload }), error(400, 'VIEW_INVALID'));
      await t.assert.rejects(updateView(db, view.id, { payload }, users.editor), error(400, 'VIEW_INVALID'));
    }
    const allowed = { x: 'a'.repeat(16375) };
    t.assert.deepStrictEqual((await f.create({ name: 'Boundary', payload: allowed })).payload, allowed);
    t.assert.deepStrictEqual((await updateView(db, view.id, { payload: allowed }, users.editor)).payload, allowed);
    await t.assert.rejects(f.create({ siteId: 'bad' }), error(400, 'VIEW_INVALID'));
    await t.assert.rejects(updateView(db, 'bad', {}, users.editor), error(400, 'VIEW_INVALID'));
    await t.assert.rejects(deleteView(db, 'bad', users.editor), error(400, 'VIEW_INVALID'));
    await t.assert.rejects(updateView(db, view.id, null, users.editor), error(400, 'VIEW_INVALID'));
  });

  await t.test('HTTP CRUD, visibility and error codes including unauthenticated requests', async t => {
    const f = await fixture();
    const path = `/api/views?site_id=${f.site.id}&module=tasks`;
    const body = { site_id: f.site.id, module: 'tasks', name: 'HTTP synthetic view', payload };
    const created = await api('/api/views', { method: 'POST', body, cookie: cookies.editor });
    t.assert.strictEqual(created.status, 201);
    const id = created.body.id;
    t.assert.deepStrictEqual(created.body.payload, payload);
    t.assert.deepStrictEqual((await api(path, { cookie: cookies.viewer })).body, []);
    t.assert.deepStrictEqual((await api(path, { cookie: cookies.owner })).body.map(v => v.id), [id]);
    t.assert.strictEqual((await api(`/api/views/${id}`, { method: 'PATCH', body: { shared: true }, cookie: cookies.editor })).status, 200);
    t.assert.deepStrictEqual((await api(path, { cookie: cookies.viewer })).body.map(v => v.id), [id]);
    for (const [route, method, input, cookie, status, code] of [
      ['/api/views', 'POST', body, cookies.viewer, 403, 'VIEW_FORBIDDEN'],
      ['/api/views', 'POST', body, cookies.editor, 409, 'VIEW_NAME_TAKEN'],
      [`/api/views/${id}`, 'PATCH', { shared: false }, cookies.verifier, 403, 'VIEW_FORBIDDEN'],
      [`/api/views/${id}`, 'DELETE', undefined, cookies.verifier, 403, 'VIEW_FORBIDDEN'],
      ['/api/views?module=tasks', 'GET', undefined, cookies.editor, 400, 'VIEW_INVALID'],
      [`/api/views?site_id=${f.site.id}&module=wrong`, 'GET', undefined, cookies.editor, 400, 'VIEW_INVALID'],
      ['/api/views', 'POST', { ...body, payload: [] }, cookies.editor, 400, 'VIEW_INVALID'],
      [`/api/views/${randomUUID()}`, 'PATCH', {}, cookies.editor, 404, 'VIEW_NOT_FOUND'],
      [path, 'GET', undefined, undefined, 401, 'AUTH_REQUIRED'],
      ['/api/views', 'POST', body, undefined, 401, 'AUTH_REQUIRED'],
      [`/api/views/${id}`, 'PATCH', {}, undefined, 401, 'AUTH_REQUIRED'],
      [`/api/views/${id}`, 'DELETE', undefined, undefined, 401, 'AUTH_REQUIRED'],
    ]) {
      const response = await api(route, { method, body: input, cookie });
      t.assert.strictEqual(response.status, status, `${method} ${route}`);
      t.assert.strictEqual(response.body.code, code);
    }
    const removed = await api(`/api/views/${id}`, { method: 'DELETE', cookie: cookies.owner });
    t.assert.strictEqual(removed.status, 200);
    t.assert.deepStrictEqual(removed.body, { deleted: true });
    for (const call of [() => f.create({}, null), () => f.list(null),
      () => updateView(db, id, {}, null), () => deleteView(db, id, null)]) {
      await t.assert.rejects(call, error(401, 'UNAUTHENTICATED'));
    }
  });

  await t.test('017 replays without data loss; schema defaults, constraints and index', async t => {
    const f = await fixture(), view = await f.create();
    const before = await db.get('SELECT * FROM view_settings WHERE id = ?', view.id);
    for (let i = 0; i < 2; i++) {
      await db.transaction(tx => applyMigration(tx, '017_view_settings.sql', { driver }));
      t.assert.strictEqual(await migrate(db, { driver }), 0);
    }
    t.assert.deepStrictEqual(await db.get('SELECT * FROM view_settings WHERE id = ?', view.id), before);
    const insert = (siteId, ownerId, module = 'tasks') => db.get(`INSERT INTO view_settings
      (id, site_id, module, name, owner_id, payload, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, '{}', ?, ?) RETURNING *`,
    randomUUID(), siteId, module, randomUUID(), ownerId, view.created_at, view.updated_at);
    t.assert.strictEqual(Boolean((await insert(f.site.id, users.editor.id)).shared), false);
    await t.assert.rejects(insert(randomUUID(), users.editor.id), /foreign key/i);
    await t.assert.rejects(insert(f.site.id, randomUUID()), /foreign key/i);
    await t.assert.rejects(insert(f.site.id, users.editor.id, 'wrong'), /check/i);
    if (driver === 'pg') {
      const columns = await db.all("SELECT column_name, udt_name FROM information_schema.columns WHERE table_name = 'view_settings' AND table_schema = current_schema()");
      for (const [column, type] of [['id', 'uuid'], ['site_id', 'uuid'], ['owner_id', 'uuid'], ['shared', 'bool'],
        ['payload', 'text'], ['created_at', 'timestamptz'], ['updated_at', 'timestamptz']]) {
        t.assert.strictEqual(columns.find(c => c.column_name === column).udt_name, type);
      }
      const index = await db.get("SELECT indexdef FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'view_settings_site_module'");
      t.assert.match(index.indexdef, /\(site_id, module\)/);
    } else {
      t.assert.deepStrictEqual((await db.all('PRAGMA index_info(view_settings_site_module)')).map(c => c.name), ['site_id', 'module']);
    }
  });

  // Keep real socket coverage separate from listener coverage: EPERM must fail, never skip.
  await t.test('HTTP socket smoke test', async t => {
    const f = await fixture();
    await f.create({ shared: true });
    const server = createServer(db);
    t.after(() => new Promise((resolve, reject) => {
      if (!server.listening) return resolve();
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    }));
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const url = `http://127.0.0.1:${server.address().port}/api/views?site_id=${f.site.id}&module=tasks`;
    const response = await fetch(url, { headers: { Cookie: cookies.viewer } });
    t.assert.strictEqual(response.status, 200);
    t.assert.strictEqual((await response.json()).length, 1);
    t.assert.strictEqual((await fetch(url)).status, 401);
  });
});
