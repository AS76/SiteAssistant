import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { createServer } from '../server/http.mjs';
import { createSite } from '../server/repository.mjs';
import { migrate } from '../server/migrations/index.mjs';
import { translatePlaceholders } from '../server/storage/pg.mjs';
import { archivePlace, createPlace, updatePlace } from '../server/places.mjs';
import { archiveAsset, createAsset, listAssets, moveAsset, updateAsset } from '../server/assets.mjs';
import { listAuditEvents } from '../server/audit.mjs';
import { authFixture, requestListener } from './helpers/auth.mjs';
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
      isUniqueViolation: error => error.code === '23505',
    };
  };
  const db = { ...adapt(pg), transaction: fn => pg.transaction(tx => fn(adapt(tx))) };
  await migrate(db, { driver });
  return db;
}

const conflict = (code, status = 409) => ({ code, status });
const start = '2024-02-01T10:00:00.000Z';
const transfer = '2024-02-02T10:00:00.000Z';

for (const driver of ['sqlite', 'pg']) test(`places and assets (${driver === 'pg' && !isPg ? 'PGlite' : driver})`, async t => {
  const db = await openDatabase(t, driver);
  const newSite = () => createSite(db, { code: randomUUID(), name: 'Example site' });
  const site = await newSite();
  const other = await newSite();
  const { users, cookies } = await authFixture(db, site);
  const owner = users.owner;
  await db.run("INSERT INTO site_members VALUES (?, ?, 'owner')", other.id, owner.id);
  const place = (kind, name, parentId, siteId = site.id) => createPlace(db, { siteId, kind, name, parentId }, owner);
  const asset = (tag, extra = {}) => createAsset(db, { siteId: site.id, tag, category: 'pump', name: tag, ...extra }, owner);
  const building = await place('building', 'Example building');
  const room = await place('room', 'Original room', building.id);
  const secondRoom = await place('room', 'Destination');
  const foreign = await place('zone', 'Other site', null, other.id);

  await t.test('hierarchy rejects cycles, reversed types, foreign references and site changes', async () => {
    await assert.rejects(updatePlace(db, building.id, { parentId: building.id }, owner), conflict('PLACE_CYCLE'));
    await assert.rejects(updatePlace(db, building.id, { parentId: room.id }, owner), conflict('PLACE_CYCLE'));
    await assert.rejects(updatePlace(db, secondRoom.id, { parentId: room.id }, owner), conflict('PLACE_KIND_ORDER', 422));
    await assert.rejects(updatePlace(db, room.id, { parentId: foreign.id }, owner), conflict('CROSS_SITE_REFERENCE', 422));
    await assert.rejects(updatePlace(db, room.id, { siteId: other.id }, owner), conflict('SITE_IMMUTABLE', 422));
    await assert.rejects(archivePlace(db, building.id, {}, owner), conflict('PLACE_HAS_ACTIVE_CHILDREN'));
  });

  await t.test('catalog validates installation, warranty and asset tags', async () => {
    await assert.rejects(asset('INST', { status: 'installed', installedOn: '2024-02-01' }),
      conflict('ASSET_POSITION_REQUIRED', 422));
    await assert.rejects(asset('WARRANTY', { warrantyStart: '2024-03-01', warrantyEnd: '2024-02-01' }),
      conflict('INVALID_WARRANTY_PERIOD', 422));
    const results = await Promise.allSettled([asset('SAME'), asset('SAME')]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(results.find(result => result.status === 'rejected').reason.code, 'DUPLICATE_ASSET_TAG');
    await asset('SAME', { siteId: other.id });
  });

  await t.test('moves are atomic, preserve paths and use half-open intervals', async () => {
    const row = await asset('MOVE', { status: 'installed', installedOn: '2024-02-01', placeId: room.id, validFrom: start });
    await assert.rejects(archivePlace(db, room.id, {}, owner), conflict('PLACE_HAS_CURRENT_ASSETS'));
    await assert.rejects(moveAsset(db, row.id, { placeId: foreign.id, validFrom: transfer }, owner),
      conflict('CROSS_SITE_REFERENCE', 422));
    await assert.rejects(moveAsset(db, row.id, { placeId: secondRoom.id, validFrom: start }, owner),
      conflict('POSITION_TIME_CONFLICT'));
    assert.equal((await db.get('SELECT place_id FROM asset_positions WHERE asset_id = ? AND valid_to IS NULL', row.id)).place_id, room.id);
    const unique = error => db.isUniqueViolation(error);
    await assert.rejects(db.run(`INSERT INTO asset_positions
      (asset_id, place_id, site_id, valid_from, created_by, recorded_path) VALUES (?, ?, ?, ?, ?, '[]')`,
    row.id, secondRoom.id, site.id, transfer, owner.id), unique);

    await updatePlace(db, room.id, { name: 'Renamed room', parentId: null }, owner);
    await moveAsset(db, row.id, { placeId: secondRoom.id, validFrom: transfer, reason: 'Synthetic move' }, owner);
    const at = async asOf => (await listAssets(db, { siteId: site.id, asOf }, owner)).find(item => item.id === row.id);
    const history = await at(start);
    assert.equal(history.place_id, room.id);
    assert.equal(JSON.parse(history.recorded_path).at(-1).name, 'Original room');
    assert.equal((await at(transfer)).place_id, secondRoom.id);
    assert.equal((await at(transfer)).installed_on, '2024-02-01');
    assert.equal((await at('2024-02-01T09:59:59.999Z')).place_id, null);
    assert.equal((await db.all('SELECT 1 FROM asset_positions WHERE asset_id = ? AND valid_to IS NULL', row.id)).length, 1);

    await archivePlace(db, room.id, {}, owner);
    await archiveAsset(db, row.id, { reason: 'Retired from register' }, owner);
    assert.equal(await db.get('SELECT 1 FROM asset_positions WHERE asset_id = ? AND valid_to IS NULL', row.id), undefined);
    await assert.rejects(updateAsset(db, row.id, { name: 'Blocked' }, owner), conflict('ASSET_ARCHIVED'));
    await asset('MOVE');
    const events = await listAuditEvents(db, { siteId: site.id, entityId: row.id, entityType: 'asset' }, owner);
    const changes = event => typeof event.changes === 'string' ? JSON.parse(event.changes) : event.changes;
    assert.deepEqual(changes(events.find(event => event.action === 'move')).place_id, { from: room.id, to: secondRoom.id });
    assert.equal(changes(events.find(event => event.action === 'archive')).archived_at.from, null);
    const placeEvents = await listAuditEvents(db, { siteId: site.id, entityId: room.id, entityType: 'place' }, owner);
    assert.deepEqual(changes(placeEvents.find(event => event.action === 'move')).parent_id, { from: building.id, to: null });
  });

  await t.test('concurrent moves at the same instant leave exactly one successor', async () => {
    const first = await place('room', 'Concurrent origin');
    const left = await place('room', 'Concurrent destination A');
    const right = await place('room', 'Concurrent destination B');
    const row = await asset('RACE', { placeId: first.id, validFrom: start });
    const results = await Promise.allSettled([left, right].map(place =>
      moveAsset(db, row.id, { placeId: place.id, validFrom: transfer }, owner)));
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(results.find(result => result.status === 'rejected').reason.code, 'POSITION_TIME_CONFLICT');
    const history = await db.all('SELECT place_id, valid_to FROM asset_positions WHERE asset_id = ? ORDER BY valid_from', row.id);
    assert.equal(history.length, 2);
    assert.equal(new Date(history[0].valid_to).toISOString(), transfer);
    assert.equal(history[1].valid_to, null);
    assert.equal(history[1].place_id, results.find(result => result.status === 'fulfilled').value.place_id);
    await assert.rejects(db.run(`INSERT INTO asset_positions
      (asset_id, place_id, site_id, valid_from, valid_to, created_by, recorded_path)
      VALUES (?, ?, ?, ?, ?, ?, '[]')`, row.id, foreign.id, site.id,
    '2024-01-01T10:00:00.000Z', start, owner.id), /foreign key/i);
  });

  await t.test('HTTP routes implement role checks and omit archived rows by default', async () => {
    const request = requestListener(createServer(db));
    const api = (path, method = 'GET', body, role = 'editor') => request(`/api/${path}`, { method, body, cookie: cookies[role] });
    const body = { siteId: site.id, kind: 'room', name: 'HTTP location' };
    assert.equal((await api('places', 'POST', body, 'viewer')).status, 403);
    assert.equal((await api('places', 'POST', body, 'verifier')).status, 403);
    const created = await api('places', 'POST', body);
    assert.equal(created.status, 201);
    const placeId = created.body.id;
    assert.equal((await api(`places/${placeId}`, 'PATCH', { name: 'HTTP rename' })).status, 200);
    const createdAsset = await api('assets', 'POST', { siteId: site.id, name: 'Example', tag: 'HTTP', category: 'pump' });
    assert.equal(createdAsset.status, 201);
    const id = createdAsset.body.id;
    assert.equal((await api(`assets/${id}`, 'PATCH', { model: 'Synthetic' })).status, 200);
    assert.equal((await api(`assets/${id}/move`, 'POST', { placeId, validFrom: start })).status, 201);
    assert.equal((await api(`assets?siteId=${site.id}`, 'GET', undefined, 'viewer')).body.find(row => row.id === id).place_id, placeId);
    assert.equal((await api(`places/${placeId}/archive`, 'POST', {})).status, 409);
    assert.equal((await api(`assets/${id}/archive`, 'POST', {})).status, 200);
    assert.equal((await api(`places/${placeId}/archive`, 'POST', {})).status, 200);
    assert.equal((await api(`places?siteId=${site.id}`, 'GET', undefined, 'viewer')).body.some(row => row.id === placeId), false);
    assert.equal((await api(`places?siteId=${site.id}&includeArchived=1`, 'GET', undefined, 'viewer')).body.some(row => row.id === placeId), true);
    assert.equal((await api(`places/${placeId}`, 'DELETE')).status, 404);
  });

  await t.test('demo_user writes only in the sandbox through accessible memberships', async () => {
    const sandbox = await createSite(db, { code: randomUUID(), name: 'Example sandbox' }, { demoSandbox: true });
    const user = users.viewer;
    await db.run('UPDATE users SET demo_sandbox = TRUE WHERE id = ?', user.id);
    await db.run("INSERT INTO site_members VALUES (?, ?, 'demo_user')", sandbox.id, user.id);
    await db.run("UPDATE site_members SET role = 'demo_user' WHERE site_id = ? AND user_id = ?", site.id, user.id);
    const input = { kind: 'zone', name: 'Example zone' };
    assert.equal((await createPlace(db, { ...input, siteId: sandbox.id }, user)).site_id, sandbox.id);
    await assert.rejects(createPlace(db, { ...input, siteId: site.id }, user), conflict('FORBIDDEN', 403));
  });
});
