import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { createSite } from '../server/repository.mjs';
import { createServer } from '../server/http.mjs';
import { listTools, createTool, updateTool, deleteTool } from '../server/tools.mjs';
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

for (const driver of ['sqlite', 'pg']) test(`Tools registry ${driver}`, async t => {
  const db = await database(t, driver);
  const { users, cookies } = await authFixture(db);
  const api = requestListener(createServer(db));
  const fixture = async (roles = ['owner', 'editor', 'verifier', 'viewer']) => {
    const site = await createSite(db, { code: randomUUID(), name: 'Synthetic tools site' });
    for (const role of roles) await db.run('INSERT INTO site_members VALUES (?, ?, ?)', site.id, users[role].id, role);
    return {
      site,
      create: (input = {}, user = users.editor) => createTool(db, {
        siteId: site.id, name: 'Synthetic tool', ...input,
      }, user),
      list: (company, user = users.editor) => listTools(db, { siteId: site.id, company }, user),
    };
  };
  const error = (status, code) => ({ status, code });

  await t.test('create defaults, trim optional text, list ordering, company filter and isolation', async t => {
    const f = await fixture(), other = await fixture();
    const first = await f.create({ name: '  Synthetic drill  ', company: ' Beta ', code: '   ', location: ' Zone A ', notes: ' Example note ' });
    t.assert.strictEqual(first.name, 'Synthetic drill');
    t.assert.strictEqual(first.code, null);
    t.assert.strictEqual(first.company, 'Beta');
    t.assert.strictEqual(first.status, 'available');
    t.assert.strictEqual(first.location, 'Zone A');
    t.assert.strictEqual(first.notes, 'Example note');
    t.assert.strictEqual(first.site_id, f.site.id);
    t.assert.ok(Number.isFinite(Date.parse(first.created_at)));
    t.assert.strictEqual(new Date(first.created_at).toISOString(), new Date(first.updated_at).toISOString());

    const bolt = await f.create({ name: 'Bolt', company: 'Alpha', status: 'maintenance' });
    const crane = await f.create({ name: 'Crane', company: 'Alpha', status: 'in_use' });
    const ladder = await f.create({ name: 'Ladder', company: 'Beta', status: 'retired' });
    const isolated = await other.create({ name: 'Other site tool', company: 'Beta' });
    t.assert.deepStrictEqual((await f.list()).map(row => row.id), [bolt.id, crane.id, ladder.id, first.id]);
    t.assert.deepStrictEqual((await f.list('Beta')).map(row => row.id), [ladder.id, first.id]);
    t.assert.deepStrictEqual((await listTools(db, { siteId: f.site.id.toUpperCase() }, users.viewer)).map(row => row.id), [bolt.id, crane.id, ladder.id, first.id]);
    t.assert.deepStrictEqual((await other.list()).map(row => row.id), [isolated.id]);
    t.assert.ok(!(await f.list()).some(row => row.id === isolated.id));
  });

  await t.test('partial update, role checks, validation, delete and unauthenticated access', async t => {
    const f = await fixture(), tool = await f.create({ name: 'Initial', code: 'A-1', company: 'Alpha',
      status: 'in_use', location: 'Zone 1', notes: 'Initial note' });
    await db.run('UPDATE tools SET updated_at = ? WHERE id = ?', '2020-01-01T00:00:00.000Z', tool.id);
    const changed = await updateTool(db, tool.id.toUpperCase(), { location: ' Zone 2 ', code: '  ' }, users.verifier);
    t.assert.strictEqual(changed.location, 'Zone 2');
    t.assert.strictEqual(changed.code, null);
    t.assert.strictEqual(changed.name, 'Initial');
    t.assert.strictEqual(changed.status, 'in_use');
    t.assert.strictEqual(changed.notes, 'Initial note');
    t.assert.strictEqual(new Date(changed.created_at).toISOString(), new Date(tool.created_at).toISOString());
    t.assert.ok(Date.parse(changed.updated_at) > Date.parse('2020-01-01T00:00:00.000Z'));
    t.assert.deepStrictEqual(await updateTool(db, tool.id, {}, users.editor), changed);

    for (const invalid of [
      () => f.create({ status: 'unknown' }, users.editor),
      () => f.create({ name: 'n'.repeat(121) }, users.editor),
      () => f.create({ name: '   ' }, users.editor),
      () => f.create({ siteId: 'not-a-uuid' }, users.editor),
      () => updateTool(db, tool.id, { status: 'unknown' }, users.editor),
      () => updateTool(db, tool.id, { name: 'n'.repeat(121) }, users.editor),
      () => updateTool(db, 'not-a-uuid', {}, users.editor),
      () => deleteTool(db, 'not-a-uuid', users.editor),
    ]) await t.assert.rejects(invalid, error(400, 'TOOL_INVALID'));
    await t.assert.rejects(updateTool(db, randomUUID(), {}, users.editor), error(404, 'TOOL_NOT_FOUND'));
    await t.assert.rejects(deleteTool(db, randomUUID(), users.editor), error(404, 'TOOL_NOT_FOUND'));

    for (const call of [
      () => f.create({}, users.viewer),
      () => updateTool(db, tool.id, { name: 'Denied' }, users.viewer),
      () => deleteTool(db, tool.id, users.viewer),
    ]) await t.assert.rejects(call, error(403, 'TOOL_FORBIDDEN'));
    for (const call of [
      () => listTools(db, { siteId: f.site.id }, null),
      () => createTool(db, { siteId: f.site.id, name: 'Unauthenticated' }, null),
      () => updateTool(db, tool.id, {}, null),
      () => deleteTool(db, tool.id, null),
    ]) await t.assert.rejects(call, error(401, 'UNAUTHENTICATED'));

    t.assert.deepStrictEqual(await deleteTool(db, tool.id, users.editor), { deleted: true, id: tool.id });
    t.assert.deepStrictEqual(await f.list(), []);
    await t.assert.rejects(deleteTool(db, tool.id, users.editor), error(404, 'TOOL_NOT_FOUND'));
  });

  await t.test('HTTP CRUD, filters and error codes', async t => {
    const f = await fixture(), other = await fixture();
    const body = { site_id: f.site.id, name: 'HTTP tool', code: 'H-1', company: 'HTTP contractor', status: 'available', location: 'Gate' };
    const created = await api('/api/tools', { method: 'POST', body, cookie: cookies.editor });
    t.assert.strictEqual(created.status, 201);
    t.assert.strictEqual(created.body.site_id, f.site.id);
    t.assert.strictEqual(created.body.status, 'available');
    const id = created.body.id;
    t.assert.deepStrictEqual((await api(`/api/tools?site_id=${f.site.id}`, { cookie: cookies.viewer })).body.map(row => row.id), [id]);
    t.assert.deepStrictEqual((await api(`/api/tools?site_id=${f.site.id}&company=${encodeURIComponent('HTTP contractor')}`, { cookie: cookies.viewer })).body.map(row => row.id), [id]);
    t.assert.deepStrictEqual((await api(`/api/tools?site_id=${f.site.id}&company=${encodeURIComponent('Other contractor')}`, { cookie: cookies.viewer })).body, []);
    t.assert.deepStrictEqual((await api(`/api/tools?site_id=${other.site.id}`, { cookie: cookies.viewer })).body, []);
    const updated = await api(`/api/tools/${id}`, { method: 'PATCH', body: { status: 'maintenance', notes: 'Synthetic note' }, cookie: cookies.verifier });
    t.assert.strictEqual(updated.status, 200);
    t.assert.strictEqual(updated.body.name, 'HTTP tool');
    t.assert.strictEqual(updated.body.status, 'maintenance');

    for (const [route, method, input, cookie, status, code] of [
      ['/api/tools', 'POST', { ...body, name: 'n'.repeat(121) }, cookies.editor, 400, 'TOOL_INVALID'],
      ['/api/tools', 'POST', { ...body, status: 'unknown' }, cookies.editor, 400, 'TOOL_INVALID'],
      ['/api/tools', 'POST', body, cookies.viewer, 403, 'TOOL_FORBIDDEN'],
      [`/api/tools/${id}`, 'PATCH', { name: 'Denied' }, cookies.viewer, 403, 'TOOL_FORBIDDEN'],
      [`/api/tools/${id}`, 'DELETE', undefined, cookies.viewer, 403, 'TOOL_FORBIDDEN'],
      [`/api/tools/${randomUUID()}`, 'PATCH', {}, cookies.editor, 404, 'TOOL_NOT_FOUND'],
      [`/api/tools/${randomUUID()}`, 'DELETE', undefined, cookies.editor, 404, 'TOOL_NOT_FOUND'],
      [`/api/tools?site_id=${f.site.id}`, 'GET', undefined, undefined, 401, 'AUTH_REQUIRED'],
      ['/api/tools', 'POST', body, undefined, 401, 'AUTH_REQUIRED'],
      [`/api/tools/${id}`, 'PATCH', {}, undefined, 401, 'AUTH_REQUIRED'],
      [`/api/tools/${id}`, 'DELETE', undefined, undefined, 401, 'AUTH_REQUIRED'],
    ]) {
      const response = await api(route, { method, body: input, cookie });
      t.assert.strictEqual(response.status, status, `${method} ${route}`);
      t.assert.strictEqual(response.body.code, code);
    }
    const removed = await api(`/api/tools/${id}`, { method: 'DELETE', cookie: cookies.owner });
    t.assert.strictEqual(removed.status, 200);
    t.assert.deepStrictEqual(removed.body, { deleted: true, id });
  });

  await t.test('018 replays without data loss and enforces status and index', async t => {
    const f = await fixture(), tool = await f.create({ name: 'Migration tool' });
    const before = await db.get('SELECT * FROM tools WHERE id = ?', tool.id);
    for (let i = 0; i < 2; i++) {
      await db.transaction(tx => applyMigration(tx, '018_tools.sql', { driver }));
      t.assert.strictEqual(await migrate(db, { driver }), 0);
    }
    t.assert.deepStrictEqual(await db.get('SELECT * FROM tools WHERE id = ?', tool.id), before);
    const insert = status => db.run(`INSERT INTO tools
      (id, site_id, name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
    randomUUID(), f.site.id, 'Synthetic migration tool', status, tool.created_at, tool.updated_at);
    await insert('retired');
    await t.assert.rejects(() => insert('unknown'), /check/i);
    if (driver === 'pg') {
      const columns = await db.all("SELECT column_name, udt_name FROM information_schema.columns WHERE table_name = 'tools' AND table_schema = current_schema()");
      for (const [column, type] of [['id', 'uuid'], ['site_id', 'uuid'], ['status', 'text'], ['created_at', 'timestamptz'], ['updated_at', 'timestamptz']]) {
        t.assert.strictEqual(columns.find(candidate => candidate.column_name === column).udt_name, type);
      }
      const index = await db.get("SELECT indexdef FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'tools_site_company'");
      t.assert.match(index.indexdef, /\(site_id, company\)/);
    } else {
      t.assert.deepStrictEqual((await db.all('PRAGMA index_info(tools_site_company)')).map(column => column.name), ['site_id', 'company']);
    }
  });
});
