import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { SqliteStorage } from '../server/storage/sqlite.mjs';
import { translatePlaceholders } from '../server/storage/pg.mjs';
import { migrate, applyMigration } from '../server/migrations/index.mjs';
import { createSite } from '../server/repository.mjs';
import { listAuditEvents, countAuditEvents } from '../server/audit.mjs';
import { createHseEvent, updateHseEvent, deleteHseEvent, listHseEvents, hseSummary } from '../server/hse.mjs';
import { createCertification, updateCertification, deleteCertification, listCertifications, certificationSummary } from '../server/certifications.mjs';
import { createTool, updateTool, deleteTool, listTools } from '../server/tools.mjs';
import { saveModuleAccess } from '../server/module-access.mjs';
import { createServer } from '../server/http.mjs';
import { authFixture, requestListener } from './helpers/auth.mjs';

// Same in-process PostgreSQL adapter as the HSE suite; no database service required.
async function database(t, driver, initialize = true) {
  let db;
  if (driver === 'sqlite') {
    db = new SqliteStorage(':memory:');
    await db.exec('PRAGMA foreign_keys = ON');
    t.after(() => db.close());
  } else {
    const pg = new PGlite();
    t.after(() => pg.close());
    const adapt = connection => ({
      exec: sql => connection.exec(sql),
      all: async (sql, ...values) => (await connection.query(translatePlaceholders(sql), values)).rows,
      get: async (sql, ...values) => (await connection.query(translatePlaceholders(sql), values)).rows[0],
      run: async (sql, ...values) => ({ rowCount: (await connection.query(translatePlaceholders(sql), values)).affectedRows }),
      isUniqueViolation: error => error.code === '23505',
    });
    db = { ...adapt(pg), transaction: fn => pg.transaction(tx => fn(adapt(tx))) };
  }
  if (initialize) await migrate(db, { driver });
  return db;
}
const plain = value => JSON.parse(JSON.stringify(value));
// Raw DATE values from PGlite are Dates; audit preserves calendar dates as strings.
const snapshot = (module, row) => {
  const result = plain(row);
  for (const field of module.dates ?? []) if (result[field] !== null) result[field] = result[field].slice(0, 10);
  return result;
};
const modules = [
  { type: 'hse_event', table: 'hse_events', path: 'hse-events', module: 'hse',
    dates: ['occurred_on'],
    create: createHseEvent, update: updateHseEvent, remove: deleteHseEvent, list: listHseEvents,
    input: () => ({ type: 'near_miss', severity: 'low', occurredOn: '2026-11-10', personsInvolved: 0 }),
    patch: { severity: 'high', persons_involved: null, notes: null },
    diff: { severity: { from: 'low', to: 'high' }, persons_involved: { from: 0, to: null }, notes: { from: 'Synthetic note', to: null } },
    missing: 'HSE_NOT_FOUND', summary: hseSummary },
  { type: 'certification', table: 'employee_certifications', path: 'certifications', module: 'certifications',
    dates: ['issued_on', 'expires_on'],
    create: createCertification, update: updateCertification, remove: deleteCertification, list: listCertifications,
    input: employeeId => ({ employeeId, category: 'training', name: 'Synthetic training', issuedOn: '2026-01-01', expiresOn: '2027-01-01' }),
    patch: { name: 'Synthetic qualification', notes: null },
    diff: { name: { from: 'Synthetic training', to: 'Synthetic qualification' }, notes: { from: 'Synthetic note', to: null } },
    missing: 'CERT_NOT_FOUND', summary: certificationSummary },
  { type: 'tool', table: 'tools', path: 'tools', module: 'tools',
    create: createTool, update: updateTool, remove: deleteTool, list: listTools,
    input: () => ({ name: 'Synthetic tool' }), patch: { status: 'maintenance', notes: null },
    diff: { status: { from: 'available', to: 'maintenance' }, notes: { from: 'Synthetic note', to: null } }, missing: 'TOOL_NOT_FOUND' },
];

for (const driver of ['sqlite', 'pg']) test(`Audit trail ${driver === 'pg' ? 'PGlite' : driver}`, async t => {
  const db = await database(t, driver);
  const { users, cookies } = await authFixture(db);
  const api = requestListener(createServer(db));
  const fixture = async (roles = ['owner', 'editor', 'verifier', 'viewer'], code = randomUUID()) => {
    const site = await createSite(db, { code, name: 'Synthetic audit site' });
    for (const role of roles) await db.run('INSERT INTO site_members VALUES (?, ?, ?)', site.id, users[role].id, role);
    const employeeId = randomUUID();
    await db.run(`INSERT INTO employees (id, site_id, employee_no, created_at) VALUES (?, ?, ?, ?)`,
      employeeId, site.id, 'SYNTHETIC-001', new Date().toISOString());
    return { site, create: (module, actor = users.editor) => module.create(db, {
      siteId: site.id, ...module.input(employeeId), notes: 'Synthetic note',
    }, actor) };
  };
  const events = (site, module, row) => listAuditEvents(db, { siteId: site.id, entityType: module.type, entityId: row.id }, users.owner);

  for (const module of modules) {
    await t.test(`${module.type}: create, minimal diff, no-op, last snapshot, soft delete and 404`, async t => {
      const f = await fixture();
      const row = await f.create(module);
      let audit = await events(f.site, module, row);
      t.assert.strictEqual(audit.length, 1);
      const created = snapshot(module, await db.get(`SELECT * FROM ${module.table} WHERE id = ?`, row.id));
      t.assert.deepStrictEqual(JSON.parse(audit[0].changes), Object.fromEntries(Object.entries(created).filter(([, value]) => value !== null)));
      t.assert.strictEqual(audit[0].action, 'create');
      t.assert.strictEqual(audit[0].actor, users.editor.id);
      t.assert.strictEqual(audit[0].site_id, f.site.id);
      t.assert.match(audit[0].id, /^[0-9a-f-]{36}$/);
      t.assert.strictEqual(new Date(audit[0].at).toISOString(), audit[0].at);
      const createEvent = plain(audit[0]);
      const updated = await module.update(db, row.id, module.patch, users.owner);
      audit = await events(f.site, module, row);
      const update = audit.find(event => event.action === 'update');
      t.assert.strictEqual(update.actor, users.owner.id);
      t.assert.deepStrictEqual(JSON.parse(update.changes), module.diff);
      await module.update(db, row.id, {}, users.editor);
      await module.update(db, row.id, module.patch, users.editor);
      audit = await events(f.site, module, row);
      t.assert.strictEqual(audit.filter(event => event.action === 'update' && event.changes === '{}').length, 2);
      const beforeDelete = snapshot(module, await db.get(`SELECT * FROM ${module.table} WHERE id = ?`, row.id));
      await module.remove(db, row.id, users.editor);
      const stored = snapshot(module, await db.get(`SELECT * FROM ${module.table} WHERE id = ?`, row.id));
      t.assert.deepStrictEqual({ ...stored, deleted_at: null }, beforeDelete);
      t.assert.strictEqual(new Date(stored.deleted_at).toISOString(), stored.deleted_at);
      t.assert.deepStrictEqual(await module.list(db, { siteId: f.site.id }, users.owner), []);
      if (module.summary) t.assert.strictEqual((await module.summary(db, { siteId: f.site.id }, users.owner)).total, 0);
      audit = await events(f.site, module, row);
      t.assert.strictEqual(audit.length, 5);
      t.assert.deepStrictEqual(plain(audit.find(event => event.action === 'create')), createEvent);
      const deletion = audit.find(event => event.action === 'delete');
      t.assert.strictEqual(deletion.actor, users.editor.id);
      t.assert.strictEqual(deletion.at, stored.deleted_at);
      t.assert.deepStrictEqual(JSON.parse(deletion.changes), beforeDelete);
      if (module.type === 'certification') {
        t.assert.strictEqual(Object.hasOwn(JSON.parse(deletion.changes), 'days_left'), false);
        t.assert.strictEqual(Object.hasOwn(JSON.parse(deletion.changes), 'status'), false);
      }
      for (const call of [() => module.update(db, row.id, {}, users.owner), () => module.remove(db, row.id, users.owner)]) {
        await t.assert.rejects(call, { status: 404, code: module.missing });
      }
      for (const method of ['PATCH', 'DELETE']) {
        const result = await api(`/api/${module.path}/${row.id}`, { method, cookie: cookies.owner, ...(method === 'PATCH' ? { body: {} } : {}) });
        t.assert.strictEqual(result.status, 404);
        t.assert.strictEqual(result.body.code, module.missing);
      }
      t.assert.strictEqual((await events(f.site, module, row)).length, 5);
      t.assert.strictEqual(updated.notes, null);
    });

    await t.test(`${module.type}: audit failure rolls back create, update and delete`, async t => {
      const f = await fixture(), row = await f.create(module);
      const baseline = plain(await db.get(`SELECT * FROM ${module.table} WHERE id = ?`, row.id));
      const auditBefore = plain(await events(f.site, module, row));
      const failing = { transaction: fn => db.transaction(tx => fn({ ...tx, run: async (sql, ...values) => {
        if (/^INSERT INTO audit_events/.test(sql)) throw new Error('Synthetic audit append failure');
        return await tx.run(sql, ...values);
      } })) };
      for (const call of [
        () => module.create(failing, { siteId: f.site.id, ...module.input(baseline.employee_id), notes: 'Synthetic note' }, users.editor),
        () => module.update(failing, row.id, module.patch, users.owner),
        () => module.remove(failing, row.id, users.editor),
      ]) {
        await t.assert.rejects(call, /Synthetic audit append failure/);
        t.assert.deepStrictEqual(plain(await db.all(`SELECT * FROM ${module.table} WHERE site_id = ?`, f.site.id)), [baseline]);
        t.assert.deepStrictEqual(plain(await events(f.site, module, row)), auditBefore);
      }
    });

    await t.test(`${module.type}: rejected writes leave audit unchanged and existing roles remain in force`, async t => {
      const f = await fixture(), row = await f.create(module);
      const auditBefore = plain(await events(f.site, module, row));
      const deniedRoles = module.type === 'tool' ? ['viewer'] : ['viewer', 'verifier'];
      for (const role of deniedRoles) {
        for (const call of [() => f.create(module, users[role]), () => module.update(db, row.id, module.patch, users[role]), () => module.remove(db, row.id, users[role])]) {
          await t.assert.rejects(call, { status: 403 });
        }
      }
      await t.assert.rejects(() => module.update(db, row.id, { name: '', severity: 'unknown' }, users.owner), { status: 400 });
      t.assert.deepStrictEqual(plain(await events(f.site, module, row)), auditBefore);
      if (module.type === 'tool') {
        await module.update(db, row.id, { notes: 'Synthetic verification' }, users.verifier);
        t.assert.strictEqual((await events(f.site, module, row)).find(event => event.action === 'update').actor, users.verifier.id);
      }
    });
  }

  await t.test('site/entity/id filters, ordering, standard pagination, roles, isolation and no module gate', async t => {
    const f = await fixture(), other = await fixture(['viewer']);
    const rows = [];
    for (const module of modules) {
      const row = await f.create(module);
      rows.push(row);
      await module.update(db, row.id, module.patch, users.owner);
      await saveModuleAccess(db, { siteId: f.site.id, memberId: users.verifier.id, module: module.module, allowed: false }, users.owner);
    }
    // The site owner is deliberately a different synthetic account.
    await db.run("UPDATE site_members SET role = 'owner' WHERE site_id = ? AND user_id = ?", other.site.id, users.viewer.id);
    const foreign = await createTool(db, { siteId: other.site.id, name: 'Synthetic isolated tool' }, users.viewer);
    const path = `/api/audit-events?site_id=${f.site.id}`;
    const all = await api(path, { cookie: cookies.verifier });
    t.assert.strictEqual(all.status, 200);
    t.assert.strictEqual(all.headers['x-total-count'], '6');
    t.assert.strictEqual(all.headers['x-limit'], '50');
    t.assert.strictEqual(all.headers['x-offset'], '0');
    t.assert.strictEqual(all.body.length, 6);
    t.assert.ok(all.body.every(event => event.site_id === f.site.id && typeof event.changes === 'string'));
    const compare = (a, b) => a.at === b.at ? (a.id < b.id ? 1 : a.id > b.id ? -1 : 0) : a.at < b.at ? 1 : -1;
    t.assert.deepStrictEqual(all.body, [...all.body].sort(compare));
    for (let index = 0; index < modules.length; index++) {
      const filtered = await api(`${path}&entity_type=${modules[index].type}&entity_id=${rows[index].id.toUpperCase()}`, { cookie: cookies.owner });
      t.assert.strictEqual(filtered.status, 200);
      t.assert.strictEqual(filtered.headers['x-total-count'], '2');
      t.assert.ok(filtered.body.every(event => event.entity_type === modules[index].type && event.entity_id === rows[index].id));
      const typeOnly = await api(`${path}&entity_type=${modules[index].type}`, { cookie: cookies.owner });
      const idOnly = await api(`${path}&entity_id=${rows[index].id}`, { cookie: cookies.owner });
      t.assert.deepStrictEqual(typeOnly.body, filtered.body);
      t.assert.deepStrictEqual(idOnly.body, filtered.body);
    }
    const page = await api(`${path}&limit=2&offset=1`, { cookie: cookies.owner });
    t.assert.strictEqual(page.headers['x-total-count'], '6');
    t.assert.strictEqual(page.headers['x-limit'], '2');
    t.assert.strictEqual(page.headers['x-offset'], '1');
    t.assert.deepStrictEqual(page.body, all.body.slice(1, 3));
    const empty = await api(`${path}&offset=100`, { cookie: cookies.owner });
    t.assert.deepStrictEqual(empty.body, []);
    t.assert.strictEqual(empty.headers['x-total-count'], '6');
    const foreignId = await api(`${path}&entity_id=${foreign.id}`, { cookie: cookies.owner });
    t.assert.deepStrictEqual(foreignId.body, []);
    t.assert.strictEqual(foreignId.headers['x-total-count'], '0');
    for (const role of ['editor', 'viewer']) t.assert.strictEqual((await api(path, { cookie: cookies[role] })).status, 403);
    for (const read of [listAuditEvents, countAuditEvents]) {
      await t.assert.rejects(() => read(db, { siteId: other.site.id }, users.owner), { status: 403 });
      await t.assert.rejects(() => read(db, { siteId: f.site.id }, null), { status: 401 });
    }
    t.assert.strictEqual((await api(`/api/audit-events?site_id=${other.site.id}`, { cookie: cookies.owner })).status, 403);
    t.assert.strictEqual((await api(path)).status, 401);
    for (const query of ['entity_type=unknown', 'entity_id=bad', 'limit=0', 'limit=201', 'limit=1.5', 'offset=-1', 'offset=bad']) {
      t.assert.strictEqual((await api(`${path}&${query}`, { cookie: cookies.owner })).status, 400);
    }
    for (const suffix of ['', '?site_id=bad']) t.assert.strictEqual((await api(`/api/audit-events${suffix}`, { cookie: cookies.owner })).status, 400);
    t.assert.strictEqual((await api(`/api/audit-events?site_id=${randomUUID()}`, { cookie: cookies.owner })).status, 404);
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      for (const url of ['/api/audit-events', `/api/audit-events/${all.body[0].id}`]) {
        t.assert.strictEqual((await api(url, { method, cookie: cookies.owner, body: {} })).status, 404);
      }
    }
    t.assert.strictEqual(await countAuditEvents(db, { siteId: f.site.id }, users.owner), 6);
  });

  await t.test('concurrent writers preserve a continuous diff chain and deleted rows cannot be resurrected', async t => {
    for (const module of modules) {
      const f = await fixture(), row = await f.create(module);
      await Promise.all([
        module.update(db, row.id, { notes: 'Synthetic note B' }, users.editor),
        module.update(db, row.id, { notes: 'Synthetic note C' }, users.owner),
      ]);
      const audit = await events(f.site, module, row);
      const diffs = audit.filter(event => event.action === 'update').map(event => JSON.parse(event.changes).notes);
      t.assert.strictEqual(diffs.length, 2);
      const first = diffs.find(diff => diff.from === 'Synthetic note');
      t.assert.ok(first);
      const second = diffs.find(diff => diff.from === first.to);
      t.assert.ok(second);
      t.assert.notStrictEqual(first.to, second.to);
      await module.remove(db, row.id, users.owner);
      await t.assert.rejects(() => module.update(db, row.id, { notes: 'Synthetic replacement' }, users.editor), { status: 404 });
      t.assert.strictEqual((await events(f.site, module, row)).length, 4);
    }
  });

});

for (const driver of ['sqlite', 'pg']) test(`Audit migration upgrades populated 024 and restarts safely: ${driver}`, async t => {
  const db = await database(t, driver, false);
  await db.exec('CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  const directory = new URL(`../server/migrations/${driver}/`, import.meta.url);
  const files = (await readdir(directory)).filter(file => /^\d{3}_.*\.sql$/.test(file) && file < '025').sort();
  for (const file of files) {
    await applyMigration(db, file, { driver });
    await db.run('INSERT INTO schema_migrations VALUES (?, ?)', file.slice(0, 3), new Date().toISOString());
  }
  const site = await createSite(db, { code: randomUUID(), name: 'Synthetic legacy site' });
  const employeeId = randomUUID(), at = '2026-11-01T00:00:00.000Z';
  await db.run('INSERT INTO employees (id, site_id, employee_no, created_at) VALUES (?, ?, ?, ?)', employeeId, site.id, 'SYNTHETIC-LEGACY', at);
  const ids = modules.map(() => randomUUID());
  await db.run(`INSERT INTO hse_events (id, site_id, type, severity, occurred_on, created_at, updated_at)
    VALUES (?, ?, 'observation', 'low', '2026-11-01', ?, ?)`, ids[0], site.id, at, at);
  await db.run(`INSERT INTO employee_certifications (id, site_id, employee_id, category, name, created_at, updated_at)
    VALUES (?, ?, ?, 'training', 'Synthetic legacy training', ?, ?)`, ids[1], site.id, employeeId, at, at);
  await db.run(`INSERT INTO tools (id, site_id, name, status, created_at, updated_at)
    VALUES (?, ?, 'Synthetic legacy tool', 'available', ?, ?)`, ids[2], site.id, at, at);
  const before = await Promise.all(modules.map(module => db.get(`SELECT * FROM ${module.table}`)));
  t.assert.strictEqual(await migrate(db, { driver }), 1);
  for (let index = 0; index < modules.length; index++) {
    t.assert.deepStrictEqual(plain(await db.get(`SELECT * FROM ${modules[index].table}`)), plain({ ...before[index], deleted_at: null }));
  }
  t.assert.deepStrictEqual(await db.all('SELECT * FROM audit_events'), []);
  t.assert.strictEqual(await migrate(db, { driver }), 0);
  const { users } = await authFixture(db, site);
  for (let index = 0; index < modules.length; index++) {
    await modules[index].remove(db, ids[index], users.owner);
    t.assert.strictEqual((await listAuditEvents(db, { siteId: site.id, entityId: ids[index] }, users.owner))[0].action, 'delete');
  }
  t.assert.strictEqual(await migrate(db, { driver }), 0);
  t.assert.strictEqual(await countAuditEvents(db, { siteId: site.id }, users.owner), 3);
});
