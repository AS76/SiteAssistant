import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { migrate } from '../server/migrations/index.mjs';
import { translatePlaceholders } from '../server/storage/pg.mjs';
import { createSite } from '../server/repository.mjs';
import { addPlaceAlias, archivePlace, createPlace, getPlace, listPlaces, placeHistory, removePlaceAlias } from '../server/places.mjs';
import { authFixture } from './helpers/auth.mjs';
import { isPg, openSqliteTestDb, openTestDb } from './helpers/db.mjs';

async function openDatabase(t, driver) {
  if (driver === 'sqlite' || isPg) {
    const fixture = await (driver === 'sqlite' ? openSqliteTestDb() : openTestDb());
    t.after(fixture.close);
    return fixture.db;
  }
  const pg = new PGlite();
  t.after(() => pg.close());
  const adapt = connection => {
    const query = (sql, params) => connection.query(translatePlaceholders(sql), params);
    return {
      exec: sql => connection.exec(sql),
      run: (sql, ...params) => query(sql, params),
      all: async (sql, ...params) => (await query(sql, params)).rows,
      get: async (sql, ...params) => (await query(sql, params)).rows[0],
    };
  };
  const db = { ...adapt(pg), transaction: fn => pg.transaction(tx => fn(adapt(tx))) };
  await migrate(db, { driver });
  return db;
}

const duplicate = { status: 409, code: 'PLACE_ALIAS_CONFLICT' };
const sample = (canonicalCode, namespace = 'catalogue') => ({
  namespace, canonicalCode, originalCode: '  ' + canonicalCode + '  ', source: 'Synthetic export',
});

for (const driver of ['sqlite', 'pg']) test(`place aliases (${driver === 'pg' && !isPg ? 'PGlite' : driver})`, async t => {
  const db = await openDatabase(t, driver);
  const site = await createSite(db, { code: 'TEST-01', name: 'Example site' });
  const other = await createSite(db, { code: 'TEST-02', name: 'Second example site' });
  const { users } = await authFixture(db, site);
  const { owner } = users;
  await db.run("INSERT INTO site_members VALUES (?, ?, 'owner')", other.id, owner.id);
  const create = (name, siteId = site.id) => createPlace(db, { siteId, kind: 'room', name }, owner);
  const first = await create('First example');
  const second = await create('Second example');
  const foreign = await create('Other site', other.id);
  const add = (place, input, key) => addPlaceAlias(db, place.id, input, owner, { key });

  await t.test('migration is applied and directly enforces same-site foreign keys and interval validity', async () => {
    assert.equal((await db.get('SELECT MAX(version) AS version FROM schema_migrations')).version, '058');
    const insert = (siteId, placeId, validTo) => db.run(`INSERT INTO place_aliases
      (id, site_id, place_id, namespace, canonical_code, original_code, source, created_at, valid_to)
      VALUES (?, ?, ?, 'constraints', 'X', 'X', 'Synthetic', ?, ?)`,
    randomUUID(), siteId, placeId, '2026-11-27T10:00:00.000Z', validTo);
    await assert.rejects(insert(site.id, foreign.id, null), /foreign key/i);
    await assert.rejects(insert(site.id, first.id, '2026-11-27T09:00:00.000Z'), /check constraint/i);
  });

  await t.test('same-site duplicate returns 409 across places or without a retry key', async () => {
    const input = sample('CODE-01');
    const { alias, status } = await add(first, input);
    assert.equal(status, 201);
    assert.equal(alias.original_code, input.originalCode);
    assert.equal(alias.source, input.source);
    await assert.rejects(add(first, input), duplicate);
    await assert.rejects(add(second, input), duplicate);
  });

  await t.test('isolates namespaces and sites, preserving case and normalizing canonical Unicode', async () => {
    await add(second, sample('CODE-01', 'another-catalogue'));
    await add(foreign, sample('CODE-01'));
    await add(second, sample('code-01'));
    await add(first, sample('Café'));
    await assert.rejects(add(second, sample('Cafe\u0301')), duplicate);
    await assert.rejects(add(first, sample('invalid\0code')), { status: 400, code: 'VALIDATION_ERROR' });
  });

  await t.test('two concurrent reservations have one winner for a code', async () => {
    const outcomes = await Promise.allSettled([add(first, sample('RACE')), add(second, sample('RACE'))]);
    assert.deepEqual(outcomes.map(result => result.status).sort(), ['fulfilled', 'rejected']);
    const error = outcomes.find(result => result.status === 'rejected').reason;
    assert.equal(error.status, 409);
    assert.equal(error.code, duplicate.code);
    assert.equal((await db.all("SELECT id FROM place_aliases WHERE canonical_code = 'RACE'")).length, 1);
  });

  await t.test('concurrent retries with the same key return the same creation and audit once', async () => {
    const input = sample('RETRY');
    const results = await Promise.all([add(first, input, 'original-request'), add(first, input, 'original-request')]);
    assert.equal(results[0].status, 201);
    assert.equal(results[0].alias.id, results[1].alias.id);
    await assert.rejects(add(first, sample('CHANGED'), 'original-request'), { status: 409, code: 'IDEMPOTENCY_KEY_REUSED' });
    const events = await placeHistory(db, first.id, owner);
    const added = events.filter(event => event.changes.alias?.to.id === results[0].alias.id);
    assert.equal(added.length, 1);
    assert.equal(added[0].changes.alias.from, null);
  });

  await t.test('archived places keep their reservation and aliases in their detail', async () => {
    const place = await create('Archived example');
    const input = sample('ARCHIVED');
    const { alias } = await add(place, input, 'archived-retry');
    await archivePlace(db, place.id, {}, owner);
    await assert.rejects(add(second, input), duplicate);
    await assert.rejects(add(place, sample('LATE')), { status: 409, code: 'PLACE_ARCHIVED' });
    assert.equal((await add(place, input, 'archived-retry')).alias.id, alias.id);
    assert.equal((await getPlace(db, place.id, owner)).aliases[0].id, alias.id);
    assert.equal((await listPlaces(db, { siteId: site.id, includeAliases: true }, owner)).some(row => row.id === place.id), false);
  });

  await t.test('retirement is scoped, idempotent, audited and excludes the alias from search data', async () => {
    const input = sample('RETIRE');
    const { alias } = await add(second, input);
    assert.deepEqual(await removePlaceAlias(db, first.id, alias.id, owner), { removed: false });
    const outcomes = await Promise.all([removePlaceAlias(db, second.id, alias.id, owner), removePlaceAlias(db, second.id, alias.id, owner)]);
    assert.deepEqual(outcomes.map(result => result.removed).sort(), [false, true]);
    await assert.rejects(add(first, input), duplicate);
    const detail = await getPlace(db, second.id, owner);
    assert.ok(detail.aliases.find(row => row.id === alias.id).valid_to);
    const { aliases } = (await listPlaces(db, { siteId: site.id, includeAliases: true }, owner)).find(row => row.id === second.id);
    assert.ok(!aliases.some(row => row.id === alias.id));
    const events = await placeHistory(db, second.id, owner);
    const removed = events.filter(event => event.changes.alias?.from?.id === alias.id);
    assert.equal(removed.length, 1);
    assert.equal(removed[0].changes.alias.from.valid_to, null);
    assert.ok(removed[0].changes.alias.to.valid_to);
  });
});
