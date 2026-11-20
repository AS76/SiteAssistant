import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { SqliteStorage } from '../server/storage/sqlite.mjs';
import { translatePlaceholders } from '../server/storage/pg.mjs';
import { migrate } from '../server/migrations/index.mjs';
import { createSite, getSite, listSites, updateSite } from '../server/repository.mjs';
import { listAuditEvents } from '../server/audit.mjs';
import { createServer } from '../server/http.mjs';
import { authFixture, requestListener } from './helpers/auth.mjs';

// Same in-process PostgreSQL adapter as the other suites; no database service required.
async function database(t, driver) {
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
  await migrate(db, { driver });
  return db;
}

for (const driver of ['sqlite', 'pg']) test(`Site jurisdiction ${driver === 'pg' ? 'PGlite' : driver}`, async t => {
  const db = await database(t, driver);
  const { users, cookies } = await authFixture(db);
  const api = requestListener(createServer(db));

  const site = async (code = randomUUID(), input = {}) => {
    const created = await createSite(db, { code, name: `Synthetic site ${code.slice(0, 8)}`, ...input });
    for (const role of ['owner', 'editor', 'verifier', 'viewer']) {
      await db.run('INSERT INTO site_members (site_id, user_id, role) VALUES (?, ?, ?)', created.id, users[role].id, role);
    }
    return created;
  };

  await t.test('a site is Italian when the field is omitted', async () => {
    const created = await site();
    assert.equal(created.jurisdiction, 'IT');
    assert.equal((await getSite(db, created.id)).jurisdiction, 'IT');
    const listed = await listSites(db, users.owner);
    assert.equal(listed.find(row => row.id === created.id).jurisdiction, 'IT');
  });

  await t.test('a British site keeps its jurisdiction on read', async () => {
    const created = await site(randomUUID(), { jurisdiction: 'UK' });
    assert.equal(created.jurisdiction, 'UK');
    assert.equal((await getSite(db, created.id)).jurisdiction, 'UK');
  });

  await t.test('an unknown jurisdiction is rejected', async () => {
    await assert.rejects(() => site(randomUUID(), { jurisdiction: 'FR' }),
      error => error.status === 400 && error.code === 'VALIDATION_ERROR');
  });

  await t.test('an owner changes the jurisdiction over HTTP and the change is audited', async () => {
    const created = await site();
    const response = await api(`/api/sites/${created.id}`, {
      method: 'PATCH', body: { jurisdiction: 'UK' }, cookie: cookies.owner,
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.jurisdiction, 'UK');
    assert.equal((await getSite(db, created.id)).jurisdiction, 'UK');

    const events = await listAuditEvents(db, { siteId: created.id }, users.owner);
    const update = events.filter(row => row.entity_type === 'site' && row.action === 'update');
    assert.equal(update.length, 1);
    const changes = typeof update[0].changes === 'string' ? JSON.parse(update[0].changes) : update[0].changes;
    assert.equal(changes.jurisdiction.from, 'IT');
    assert.equal(changes.jurisdiction.to, 'UK');
  });

  await t.test('a verifier cannot change the jurisdiction', async () => {
    const created = await site();
    const response = await api(`/api/sites/${created.id}`, {
      method: 'PATCH', body: { jurisdiction: 'UK' }, cookie: cookies.verifier,
    });
    assert.equal(response.status, 403);
    assert.equal((await getSite(db, created.id)).jurisdiction, 'IT');
  });

  await t.test('the route refuses fields other than jurisdiction', async () => {
    const created = await site();
    const response = await api(`/api/sites/${created.id}`, {
      method: 'PATCH', body: { jurisdiction: 'IT', name: 'Renamed' }, cookie: cookies.owner,
    });
    assert.equal(response.status, 400);
    assert.equal((await getSite(db, created.id)).name, `Synthetic site ${created.code.slice(0, 8)}`);
  });

  await t.test('a row inserted without the column reads as Italian', async () => {
    const id = randomUUID();
    await db.run(`INSERT INTO sites (id, code, name, created_at) VALUES (?, ?, ?, ?)`,
      id, `LEGACY-${id.slice(0, 8)}`, 'Synthetic legacy site', new Date().toISOString());
    assert.equal((await getSite(db, id)).jurisdiction, 'IT');
  });

  await t.test('updateSite guards the role itself', async () => {
    const created = await site();
    await assert.rejects(() => updateSite(db, created.id, { jurisdiction: 'UK' }, users.editor),
      error => error.status === 403);
  });
});
