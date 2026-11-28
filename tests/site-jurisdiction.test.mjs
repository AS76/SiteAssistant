import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { SqliteStorage } from '../server/storage/sqlite.mjs';
import { translatePlaceholders } from '../server/storage/pg.mjs';
import { migrate } from '../server/migrations/index.mjs';
import { createSite, getSite, listSites, updateSite } from '../server/repository.mjs';
import { listAuditEvents } from '../server/audit.mjs';
import { findTemplate } from '../server/checklists.mjs';
import { createHseAsset } from '../server/hse-assets.mjs';
import { createInspection, getInspection } from '../server/hse-inspections.mjs';
import { createServer } from '../server/http.mjs';
import { authFixture, requestListener } from './helpers/auth.mjs';
import { observeMigrations } from './helpers/migrations.mjs';

// Same in-process PostgreSQL adapter as the other suites; no database service required.
async function database(t, driver, afterCommit) {
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
  await migrate(afterCommit ? observeMigrations(db, [], version => afterCommit(db, version)) : db, { driver });
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

  await t.test('an omitted jurisdiction retains the historical IT value without a declaration', async () => {
    const created = await site();
    assert.equal(created.jurisdiction, 'IT');
    assert.equal(created.jurisdiction_declared, false);
    assert.equal(created.content_language, null);
    assert.equal((await getSite(db, created.id)).jurisdiction, 'IT');
    const listed = await listSites(db, users.owner);
    assert.equal(listed.find(row => row.id === created.id).jurisdiction, 'IT');
  });

  await t.test('a British site with territory to confirm keeps its exact code', async () => {
    const created = await site(randomUUID(), { jurisdiction: 'UK' });
    assert.equal(created.jurisdiction, 'UK');
    assert.equal(created.time_zone, 'Europe/Rome', 'the omitted time zone has a fixed, separate default');
    assert.equal((await getSite(db, created.id)).jurisdiction, 'UK');
  });

  await t.test('site metadata and profile language are independent for all explicit territories', async () => {
    await site();
    const catalogue = await api('/api/jurisdictions', { cookie: cookies.owner });
    assert.equal(catalogue.status, 200);
    assert.deepEqual(catalogue.body.map(({ code, country_code, territory_code }) => [code, country_code, territory_code]), [
      ['IT', 'IT', null], ['UK', 'UK', null], ['UK-GB', 'UK', 'GB'], ['UK-NI', 'UK', 'NI'],
    ]);
    for (const [jurisdiction, language, content_language, time_zone] of [
      ['IT', 'en', 'it', 'Europe/London'],
      ['UK-GB', 'it', 'en', 'Europe/Rome'],
      ['UK-NI', 'it', 'en', 'UTC'],
    ]) {
      const preference = await api('/api/auth/me/preferences', {
        method: 'PATCH', cookie: cookies.owner, body: { language },
      });
      assert.equal(preference.body.user.language, language);
      const response = await api('/api/sites', {
        method: 'POST', cookie: cookies.owner,
        body: { code: randomUUID(), name: 'Synthetic site', jurisdiction, content_language, time_zone },
      });
      assert.equal(response.status, 201);
      const read = await api(`/api/sites/${response.body.id}`, { cookie: cookies.owner });
      assert.equal(read.status, 200);
      assert.deepEqual(read.body, response.body);
      assert.deepEqual(
        [read.body.jurisdiction, read.body.jurisdiction_declared, read.body.content_language, read.body.time_zone],
        [jurisdiction, true, content_language, time_zone],
      );
    }
  });

  await t.test('unsupported values are rejected without aliasing or inference', async () => {
    const created = await site();
    for (const jurisdiction of ['FR', 'GB', 'UK-SCT', 'uk-ni', null]) {
      await assert.rejects(() => site(randomUUID(), { jurisdiction }), {
        status: 400, code: 'VALIDATION_ERROR', message: /Unsupported jurisdiction code/,
      });
      const response = await api(`/api/sites/${created.id}`, {
        method: 'PATCH', cookie: cookies.owner, body: { jurisdiction },
      });
      assert.equal(response.status, 400);
      assert.match(response.body.message, /Unsupported jurisdiction code/);
    }
    await assert.rejects(() => site(randomUUID(), { content_language: 'en-GB' }), {
      status: 400, code: 'VALIDATION_ERROR', message: /content_language/,
    });
    await assert.rejects(() => db.run('UPDATE sites SET jurisdiction_code = ? WHERE id = ?', 'GB', created.id), /foreign key/i);
    assert.equal((await getSite(db, created.id)).jurisdiction_declared, false);
  });

  await t.test('catalogue entries extend the accepted codes through the same route', async () => {
    await db.run(`INSERT INTO jurisdictions (code, country_code, label_it, label_en)
      VALUES ('ZZ', 'ZZ', 'Territorio sintetico', 'Synthetic territory')`);
    const created = await site(randomUUID(), { jurisdiction: 'ZZ', content_language: 'en', time_zone: 'UTC' });
    assert.equal(created.jurisdiction, 'ZZ');
    assert.deepEqual((await api('/api/jurisdictions', { cookie: cookies.owner })).body.at(-1), {
      code: 'ZZ', country_code: 'ZZ', territory_code: null, label_it: 'Territorio sintetico', label_en: 'Synthetic territory',
    });
  });

  await t.test('GB and NI have no inherited templates and historical inspection snapshots stay readable', async () => {
    const created = await site(randomUUID(), { jurisdiction: 'UK' });
    const owner = users.owner;
    const asset = await createHseAsset(db, { siteId: created.id, name: 'Synthetic asset', templateCode: 'uk_lifting' }, owner);
    const input = {
      siteId: created.id, assetId: asset.id, performedOn: '2026-10-20', performedBy: 'Example inspector',
      mode: 'internal', outcome: 'pass', items: findTemplate('uk_lifting').items.map(({ code }) => ({ code, result: 'ok' })),
    };
    const inspection = await createInspection(db, input, owner);
    const historical = await getInspection(db, inspection.id, owner);
    for (const jurisdiction of ['UK-GB', 'UK-NI']) {
      await updateSite(db, created.id, { jurisdiction }, owner);
      const result = await api(`/api/hse/inspection-templates?siteId=${created.id}`, { cookie: cookies.owner });
      assert.equal(result.status, 200);
      assert.deepEqual(result.body, { jurisdiction, templates: [] });
      for (const templateCode of ['uk_lifting', 'it_lifting']) {
        await assert.rejects(() => createHseAsset(db, { siteId: created.id, name: 'Synthetic new asset', templateCode }, owner),
          { status: 400, code: 'TEMPLATE_JURISDICTION_MISMATCH' });
      }
      await assert.rejects(() => createInspection(db, input, owner), { status: 400, code: 'TEMPLATE_JURISDICTION_MISMATCH' });
      assert.deepEqual(await getInspection(db, inspection.id, owner), historical);
    }
  });

  await t.test('an owner changes the jurisdiction over HTTP and the change is audited', async () => {
    const created = await site(randomUUID(), { content_language: 'it', time_zone: 'UTC' });
    const response = await api(`/api/sites/${created.id}`, {
      method: 'PATCH', body: { jurisdiction: 'UK-NI' }, cookie: cookies.owner,
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.jurisdiction, 'UK-NI');
    assert.equal((await getSite(db, created.id)).jurisdiction, 'UK-NI');
    assert.equal(response.body.content_language, 'it');
    assert.equal(response.body.time_zone, 'UTC');
    assert.equal((await db.get('SELECT jurisdiction FROM sites WHERE id = ?', created.id)).jurisdiction, 'IT');

    const events = await listAuditEvents(db, { siteId: created.id }, users.owner);
    const update = events.filter(row => row.entity_type === 'site' && row.action === 'update');
    assert.equal(update.length, 1);
    const changes = typeof update[0].changes === 'string' ? JSON.parse(update[0].changes) : update[0].changes;
    assert.equal(changes.jurisdiction.from, 'IT');
    assert.equal(changes.jurisdiction.to, 'UK-NI');
    assert.deepEqual(changes.jurisdiction_declared, { from: false, to: true });
  });

  await t.test('a verifier cannot change the jurisdiction', async () => {
    const created = await site();
    const response = await api(`/api/sites/${created.id}`, {
      method: 'PATCH', body: { jurisdiction: 'UK' }, cookie: cookies.verifier,
    });
    assert.equal(response.status, 403);
    assert.equal((await getSite(db, created.id)).jurisdiction, 'IT');
  });

  await t.test('the route refuses fields outside site settings', async () => {
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

for (const driver of ['sqlite', 'pg']) test(`058 preserves original site and diary values on ${driver}`, async t => {
  const at = '2026-10-20T01:00:00.000Z';
  let beforeSites, beforeDiary;
  const db = await database(t, driver, async (db, version) => {
    if (version !== '057') return;
    for (const [jurisdiction, zone] of [['IT', 'Europe/London'], ['UK', 'UTC']]) {
      const id = randomUUID();
      await db.run(`INSERT INTO sites (id, code, name, jurisdiction, time_zone, day_cutoff_time, created_at)
        VALUES (?, ?, 'Synthetic legacy site', ?, ?, '07:00', ?)`, id, jurisdiction, jurisdiction, zone, at);
      await db.run(`INSERT INTO diary (id, site_id, operational_date, shift, created_at, time_zone)
        VALUES (?, ?, '2026-10-20', 'night', ?, ?)`, randomUUID(), id, at, zone);
    }
    beforeSites = await db.all('SELECT * FROM sites ORDER BY code');
    beforeDiary = await db.all('SELECT * FROM diary ORDER BY id');
  });
  assert.deepEqual((await db.all('SELECT * FROM sites ORDER BY code')).map(row => ({ ...row })),
    beforeSites.map(site => ({ ...site, jurisdiction_code: null, content_language: null })));
  assert.deepEqual(await db.all('SELECT * FROM diary ORDER BY id'), beforeDiary);
  for (const { id, jurisdiction, time_zone } of beforeSites) {
    const site = await getSite(db, id);
    assert.deepEqual([site.jurisdiction, site.time_zone, site.jurisdiction_declared], [jurisdiction, time_zone, false]);
  }
});
