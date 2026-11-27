import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from '../server/http.mjs';
import { createSite } from '../server/repository.mjs';
import { createAsset, moveAsset } from '../server/assets.mjs';
import { archivePlace, createPlace, getPlace, listPlaceHistory, updatePlace } from '../server/places.mjs';
import { authFixture } from './helpers/auth.mjs';
import { isPg, openTestDb } from './helpers/db.mjs';
import { database } from './helpers/procurement.mjs';

const start = '2026-01-01T08:00:00.000Z';
const transfer = '2026-01-02T08:00:00.000Z';
const missing = { status: 404, code: 'PLACE_NOT_FOUND' };

async function fixture(db) {
  const site = await createSite(db, { code: randomUUID(), name: 'Synthetic construction site' });
  const other = await createSite(db, { code: randomUUID(), name: 'Synthetic restricted site' });
  const { users, cookies } = await authFixture(db, site);
  const owner = users.owner;
  await db.run("INSERT INTO site_members VALUES (?, ?, 'owner')", other.id, owner.id);
  const place = (kind, name, parentId, siteId = site.id) => createPlace(db, { siteId, kind, name, parentId }, owner);
  const building = await place('building', 'Synthetic building');
  const zone = await place('zone', 'Synthetic zone', building.id);
  const room = await place('room', 'Synthetic room', zone.id);
  const oldRoom = await place('room', 'Synthetic archived room', building.id);
  const exterior = await place('zone', 'Synthetic exterior');
  const foreign = await place('building', 'Synthetic restricted building', null, other.id);
  await archivePlace(db, oldRoom.id, { reason: 'Synthetic archive' }, owner);
  return { site, other, users, cookies, building, zone, room, oldRoom, exterior, foreign };
}

async function readDatabase(t, driver) {
  if (driver !== 'pg' || !isPg) return database(t, driver);
  const { db, close } = await openTestDb();
  t.after(close);
  return db;
}

for (const driver of ['sqlite', 'pg']) test(`place read model on ${driver === 'pg' && !isPg ? 'PGlite' : driver}`, async t => {
  const db = await readDatabase(t, driver);
  const { site, other, users, building, zone, room, oldRoom, exterior, foreign } = await fixture(db);

  await t.test('detail includes the site root, direct active children and current positions throughout the subtree', async () => {
    const asset = (tag, placeId) => createAsset(db, { siteId: site.id, tag, name: tag, category: 'synthetic',
      placeId, validFrom: start }, users.owner);
    const historical = await asset('SYN-HIST', room.id);
    await moveAsset(db, historical.id, { placeId: exterior.id, validFrom: transfer }, users.owner);
    await asset('SYN-ROOT', building.id);
    await asset('SYN-DESC', room.id);

    const detail = await getPlace(db, building.id, users.viewer);
    assert.equal(detail.status, 'active');
    assert.deepEqual(detail.dependencies, { activeChildren: 1, currentAssets: 2 });
    const roomDetail = await getPlace(db, room.id, users.viewer);
    assert.equal(roomDetail.kind, 'room');
    assert.deepEqual(roomDetail.dependencies, { activeChildren: 0, currentAssets: 1 });
    assert.deepEqual(roomDetail.path, [
      { id: site.id, kind: 'site', name: site.name },
      ...[building, zone, room].map(({ id, kind, name }) => ({ id, kind, name })),
    ]);

    await updatePlace(db, room.id, { name: 'Synthetic moved room', parentId: exterior.id }, users.owner);
    const moved = await getPlace(db, room.id, users.viewer);
    assert.equal(moved.id, room.id);
    assert.deepEqual(moved.path.map(node => node.id), [site.id, exterior.id, room.id]);
    assert.equal(moved.path.at(-1).name, 'Synthetic moved room');
    assert.equal((await getPlace(db, building.id, users.viewer)).dependencies.currentAssets, 1);
  });

  await t.test('the archived place remains readable with its original path and audit', async () => {
    const detail = await getPlace(db, oldRoom.id, users.verifier);
    assert.equal(detail.status, 'archived');
    assert.deepEqual(detail.path.map(node => node.id), [site.id, building.id, oldRoom.id]);
    assert.deepEqual(detail.dependencies, { activeChildren: 0, currentAssets: 0 });
    const history = await listPlaceHistory(db, oldRoom.id, users.verifier);
    assert.deepEqual(new Set(history.map(event => event.action)), new Set(['create', 'archive']));
    assert.equal(history.find(event => event.action === 'archive').changes.note, 'Synthetic archive');
  });

  await t.test('history orders by timestamp then ID and is scoped to the place, entity type and site', async () => {
    const tied = '2026-01-03T08:00:00.000Z';
    const firstId = '00000000-0000-4000-8000-000000000001';
    const secondId = '00000000-0000-4000-8000-000000000002';
    const insert = (id, siteId, entityType, entityId, at) => db.run(
      `INSERT INTO audit_events (id, site_id, entity_type, entity_id, action, at, actor, changes)
       VALUES (?, ?, ?, ?, 'update', ?, ?, ?)`,
      id, siteId, entityType, entityId, at, users.owner.id,
      JSON.stringify({ name: { from: 'Synthetic prior', to: 'Synthetic after' } }),
    );
    await insert(secondId, site.id, 'place', building.id, tied);
    await insert(firstId, site.id, 'place', building.id, tied);
    await insert(randomUUID(), other.id, 'place', building.id, tied);
    await insert(randomUUID(), site.id, 'asset', building.id, tied);
    const history = await listPlaceHistory(db, building.id, users.viewer);
    assert.equal(history.length, 3);
    assert.deepEqual(history.filter(event => event.at === tied).map(event => event.id), [firstId, secondId]);
    assert.deepEqual(history.map(event => event.at), history.map(event => event.at).sort());
    assert.deepEqual(history.find(event => event.id === firstId).changes.name,
      { from: 'Synthetic prior', to: 'Synthetic after' });
  });

  await t.test('site membership grants read access across roles and conceals inaccessible places', async () => {
    for (const read of [getPlace, listPlaceHistory]) {
      for (const role of ['owner', 'editor', 'verifier', 'viewer']) assert.ok(await read(db, room.id, users[role]));
      await assert.rejects(read(db, foreign.id, users.viewer), missing);
      await assert.rejects(read(db, randomUUID(), users.viewer), missing);
      await assert.rejects(read(db, 'invalid', users.viewer), { status: 400, code: 'VALIDATION_ERROR' });
      await assert.rejects(read(db, room.id, null), { status: 401, code: 'UNAUTHENTICATED' });
      assert.ok(await read(db, foreign.id, users.owner));
    }
  });

  await t.test('sandbox membership grants reads inside its scope', async () => {
    const sandbox = await createSite(db, { code: randomUUID(), name: 'Synthetic sandbox' }, { demoSandbox: true });
    const demo = { id: randomUUID() };
    await db.run(`INSERT INTO users (id, email, name, password_hash, password_algo, created_at, demo_sandbox)
      SELECT ?, 'sandbox@example.invalid', 'Synthetic sandbox user', password_hash, password_algo, created_at, TRUE
      FROM users WHERE id = ?`, demo.id, users.viewer.id);
    await db.run("INSERT INTO site_members VALUES (?, ?, 'demo_user')", sandbox.id, demo.id);
    await db.run("INSERT INTO site_members VALUES (?, ?, 'viewer')", site.id, demo.id);
    const sandboxRoom = await createPlace(db, { siteId: sandbox.id, kind: 'room', name: 'Synthetic sandbox room' }, demo);
    assert.equal((await getPlace(db, sandboxRoom.id, demo)).id, sandboxRoom.id);
    assert.equal((await listPlaceHistory(db, sandboxRoom.id, demo))[0].action, 'create');
    await assert.rejects(getPlace(db, room.id, demo), missing);
    await assert.rejects(listPlaceHistory(db, room.id, demo), missing);
  });
});

test('place detail and history return their HTTP contracts over a real socket', async t => {
  const { db, close } = await openTestDb();
  t.after(close);
  const { site, cookies, building, room, oldRoom, foreign } = await fixture(db);
  const server = createServer(db);
  t.after(async () => {
    if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const base = `http://127.0.0.1:${server.address().port}/api/places`;
  async function request(path, role, { method = 'GET', body } = {}) {
    const response = await fetch(`${base}/${path}`, {
      method,
      headers: { ...(role ? { cookie: cookies[role] } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body && JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  }
  const expect = async (path, role, status, code) => {
    const result = await request(path, role);
    assert.equal(result.status, status);
    if (code) assert.equal(result.body.code, code);
    return result.body;
  };

  for (const role of ['owner', 'editor', 'verifier', 'viewer']) {
    const detail = await expect(room.id, role, 200);
    assert.deepEqual(detail.path.map(node => node.id), [site.id, building.id, room.parent_id, room.id]);
    const history = await expect(`${room.id}/history`, role, 200);
    assert.deepEqual(history.map(event => event.action), ['create']);
  }
  assert.equal((await expect(oldRoom.id, 'viewer', 200)).status, 'archived');
  assert.equal((await expect(`${oldRoom.id}/history`, 'viewer', 200)).length, 2);
  for (const suffix of ['', '/history']) {
    await expect(`${foreign.id}${suffix}`, 'viewer', 404, 'PLACE_NOT_FOUND');
    await expect(`${randomUUID()}${suffix}`, 'viewer', 404, 'PLACE_NOT_FOUND');
    await expect(`invalid${suffix}`, 'viewer', 400, 'VALIDATION_ERROR');
    await expect(`${room.id}${suffix}`, undefined, 401, 'AUTH_REQUIRED');
  }
  const denied = await request(room.id, 'viewer', { method: 'PATCH', body: { name: 'Synthetic forbidden change' } });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.code, 'FORBIDDEN');
});
