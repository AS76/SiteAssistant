import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from '../server/http.mjs';
import { createSite } from '../server/repository.mjs';
import { archiveAsset, createAsset, getAsset, listAssetPositions, listAssets, moveAsset, updateAsset } from '../server/assets.mjs';
import { createPlace, updatePlace } from '../server/places.mjs';
import { authFixture } from './helpers/auth.mjs';
import { isPg, openTestDb } from './helpers/db.mjs';
import { database } from './helpers/procurement.mjs';

const start = '2026-01-01T08:00:00.000Z';
const transfer = '2026-01-02T08:00:00.000Z';
const beforeStart = '2026-01-01T07:59:59.999Z';
const missing = { status: 404, code: 'ASSET_NOT_FOUND' };

async function fixture(db) {
  const site = await createSite(db, { code: randomUUID(), name: 'Synthetic site' });
  const other = await createSite(db, { code: randomUUID(), name: 'Synthetic restricted site' });
  const { users, cookies } = await authFixture(db, site);
  const owner = users.owner;
  await db.run("INSERT INTO site_members VALUES (?, ?, 'owner')", other.id, owner.id);
  const place = (kind, name, parentId, siteId = site.id) => createPlace(db, { siteId, kind, name, parentId }, owner);
  const asset = (tag, extra = {}) => createAsset(db, { siteId: site.id, tag, name: tag, category: 'synthetic', ...extra }, owner);
  const building = await place('building', 'Synthetic building');
  const floor = await place('floor', 'Synthetic floor', building.id);
  const room = await place('room', 'Synthetic room', floor.id);
  const yard = await place('zone', 'Synthetic yard');
  const foreignPlace = await place('zone', 'Synthetic restricted zone', null, other.id);
  const foreignAsset = await asset('PUMP-1', { siteId: other.id, placeId: foreignPlace.id, validFrom: start });
  const moved = await asset('PUMP-1', {
    status: 'installed', installedOn: '2026-01-01', placeId: room.id, validFrom: start, reason: 'Synthetic initial position',
    serialNumber: 'SER-1', manufacturer: 'Synthetic maker', model: 'M1',
    warrantyStart: '2026-01-01', warrantyEnd: '2027-01-01', warrantyProvider: 'Synthetic provider',
  });
  await moveAsset(db, moved.id, { placeId: yard.id, validFrom: transfer, reason: 'Synthetic transfer' }, owner);
  await updatePlace(db, yard.id, { name: 'Synthetic renamed yard' }, owner);
  const root = await asset('PUMP-10', { placeId: building.id, validFrom: start, serialNumber: 'SER-1' });
  const descendant = await asset('VALVE-1', { placeId: room.id, validFrom: start, serialNumber: 'SER-10' });
  const unpositioned = await asset('EMPTY-1');
  const archived = await asset('ARCHIVED-1', { placeId: room.id, validFrom: start });
  await archiveAsset(db, archived.id, {}, owner);
  return { site, other, users, cookies, building, floor, room, yard, foreignPlace, foreignAsset, moved, root, descendant, unpositioned, archived };
}

for (const driver of ['sqlite', 'pg']) test(`asset reads on ${driver === 'pg' && !isPg ? 'PGlite' : driver}`, async t => {
  let db;
  if (driver === 'pg' && isPg) {
    const opened = await openTestDb();
    db = opened.db;
    t.after(opened.close);
  } else db = await database(t, driver);
  const { site, users, building, floor, room, yard, foreignAsset, foreignPlace,
    moved, root, descendant, unpositioned, archived } = await fixture(db);
  const { owner, viewer } = users;
  const list = (filter = {}, user = viewer) => listAssets(db, { siteId: site.id, ...filter }, user);
  const tags = async filter => (await list(filter)).map(row => row.tag);

  await t.test('asset sheet exposes warranty, archive and live path separately from the recorded path', async () => {
    const detail = await getAsset(db, moved.id, viewer);
    assert.equal(detail.status, 'installed');
    assert.equal(detail.archived_at, null);
    assert.equal(detail.serial_number, 'SER-1');
    assert.equal(detail.manufacturer, 'Synthetic maker');
    assert.equal(detail.model, 'M1');
    assert.equal(detail.installed_on, '2026-01-01');
    assert.equal(detail.warranty_start, '2026-01-01');
    assert.equal(detail.warranty_end, '2027-01-01');
    assert.equal(detail.warranty_provider, 'Synthetic provider');
    assert.equal(detail.historyCount, 1);
    assert.equal(detail.currentPosition.place_id, yard.id);
    assert.deepEqual(detail.currentPosition.path.map(node => [node.id, node.name]), [
      [site.id, site.name], [yard.id, 'Synthetic renamed yard'],
    ]);
    assert.equal(JSON.parse(detail.currentPosition.recorded_path).at(-1).name, 'Synthetic yard');
    const archivedDetail = await getAsset(db, archived.id, viewer);
    assert.ok(archivedDetail.archived_at);
    assert.equal(archivedDetail.currentPosition, null);
    assert.equal(archivedDetail.historyCount, 1);
    assert.equal((await getAsset(db, unpositioned.id, viewer)).historyCount, 0);
  });

  await t.test('position history orders intervals and preserves each recorded path and reason', async () => {
    const positions = await listAssetPositions(db, moved.id, viewer);
    assert.deepEqual(positions.map(row => ({
      placeId: row.place_id, from: new Date(row.valid_from).toISOString(),
      to: row.valid_to && new Date(row.valid_to).toISOString(), reason: row.reason,
      path: JSON.parse(row.recorded_path).map(node => node.id),
    })), [
      { placeId: room.id, from: start, to: transfer, reason: 'Synthetic initial position', path: [building.id, floor.id, room.id] },
      { placeId: yard.id, from: transfer, to: null, reason: 'Synthetic transfer', path: [yard.id] },
    ]);
    assert.deepEqual(await listAssetPositions(db, unpositioned.id, viewer), []);
    assert.ok((await listAssetPositions(db, archived.id, viewer))[0].valid_to);
  });

  await t.test('metadata filters are exact, site scoped and combined with AND', async () => {
    assert.deepEqual(await tags({ tag: ' PUMP-1 ' }), ['PUMP-1']);
    assert.deepEqual(await tags({ tag: 'pump-1' }), []);
    assert.deepEqual(await tags({ tag: 'PUMP' }), []);
    assert.deepEqual(await tags({ serial: 'SER-1' }), ['PUMP-1', 'PUMP-10']);
    assert.deepEqual(await tags({ serial: 'SER-1', status: 'planned' }), ['PUMP-10']);
    assert.deepEqual(await tags({ tag: 'VALVE-1', serial: 'SER-1' }), []);
    assert.deepEqual(await tags({ status: 'installed' }), ['PUMP-1']);
    assert.deepEqual(await tags({ tag: 'ARCHIVED-1' }), []);
    assert.deepEqual(await tags({ tag: 'ARCHIVED-1', includeArchived: true }), ['ARCHIVED-1']);
    for (const filter of [{ status: 'unknown' }, { placeId: 'invalid' }, { asOf: '2026-01-01' }, { serial: ' ' }]) {
      await assert.rejects(list(filter), { status: 400, code: 'VALIDATION_ERROR' });
    }
  });

  await t.test('subtree includes its root and descendants and applies to the half-open asOf position', async () => {
    assert.deepEqual(await tags({ placeId: building.id }), ['PUMP-10', 'VALVE-1']);
    assert.deepEqual(await tags({ placeId: building.id, asOf: start }), ['PUMP-1', 'PUMP-10', 'VALVE-1']);
    assert.deepEqual(await tags({ placeId: building.id, asOf: beforeStart }), []);
    assert.deepEqual(await tags({ placeId: room.id, asOf: transfer }), ['VALVE-1']);
    assert.deepEqual(await tags({ placeId: yard.id, asOf: transfer, status: 'installed' }), ['PUMP-1']);
    assert.deepEqual(await tags({ placeId: building.id, includeArchived: true, asOf: start }), ['ARCHIVED-1', 'PUMP-1', 'PUMP-10', 'VALVE-1']);
    assert.equal((await list({ tag: moved.tag, asOf: beforeStart }))[0].place_id, null);
    await assert.rejects(list({ placeId: foreignPlace.id }), { status: 404, code: 'REFERENCE_NOT_FOUND' });
    await assert.rejects(list({ placeId: foreignPlace.id }, owner), { status: 422, code: 'CROSS_SITE_REFERENCE' });

    await updatePlace(db, room.id, { parentId: yard.id }, owner);
    assert.deepEqual(await tags({ placeId: building.id }), ['PUMP-10']);
    assert.deepEqual(await tags({ placeId: yard.id }), ['PUMP-1', 'VALVE-1']);
    assert.deepEqual(JSON.parse((await listAssetPositions(db, moved.id, viewer))[0].recorded_path)
      .map(node => node.id), [building.id, floor.id, room.id]);
  });

  await t.test('membership grants reads to all site roles and conceals assets outside their scope', async () => {
    for (const user of Object.values(users)) {
      assert.equal((await getAsset(db, moved.id, user)).id, moved.id);
      assert.equal((await listAssetPositions(db, moved.id, user)).length, 2);
      assert.equal((await list({ tag: root.tag }, user)).length, 1);
    }
    for (const read of [getAsset, listAssetPositions]) {
      await assert.rejects(read(db, foreignAsset.id, viewer), missing);
      await assert.rejects(read(db, randomUUID(), viewer), missing);
      await assert.rejects(read(db, 'invalid', viewer), { status: 400, code: 'VALIDATION_ERROR' });
      await assert.rejects(read(db, moved.id, null), { status: 401, code: 'UNAUTHENTICATED' });
    }
    for (const user of [users.verifier, viewer]) {
      await assert.rejects(updateAsset(db, moved.id, { status: 'replaced' }, user), { status: 403, code: 'FORBIDDEN' });
      await assert.rejects(moveAsset(db, moved.id, { placeId: room.id }, user), { status: 403, code: 'FORBIDDEN' });
    }
    assert.equal((await updateAsset(db, unpositioned.id, { status: 'decommissioned', reason: 'Synthetic cancellation' }, users.editor)).status,
      'decommissioned');
  });

  await t.test('demo reads and writes are restricted to eligible sandbox memberships', async () => {
    const sandbox = await createSite(db, { code: randomUUID(), name: 'Synthetic sandbox' }, { demoSandbox: true });
    const demo = { id: randomUUID() };
    await db.run(`INSERT INTO users (id, email, name, password_hash, password_algo, created_at, demo_sandbox)
      SELECT ?, 'asset-sandbox@example.invalid', 'Synthetic sandbox user', password_hash, password_algo, created_at, TRUE
      FROM users WHERE id = ?`, demo.id, viewer.id);
    await db.run("INSERT INTO site_members VALUES (?, ?, 'demo_user')", sandbox.id, demo.id);
    await db.run("INSERT INTO site_members VALUES (?, ?, 'demo_user')", site.id, demo.id);
    const record = await createAsset(db, { siteId: sandbox.id, tag: 'DEMO-1', name: 'Synthetic asset', category: 'synthetic' }, demo);
    assert.equal((await getAsset(db, record.id, demo)).id, record.id);
    assert.deepEqual(await listAssetPositions(db, record.id, demo), []);
    assert.equal((await updateAsset(db, record.id, { status: 'decommissioned', reason: 'Synthetic cancellation' }, demo)).status,
      'decommissioned');
    await assert.rejects(getAsset(db, moved.id, demo), missing);
    await assert.rejects(listAssetPositions(db, moved.id, demo), missing);
    await assert.rejects(updateAsset(db, moved.id, { status: 'replaced' }, demo), { status: 403, code: 'FORBIDDEN' });
  });
});

test('asset list, detail and position history return HTTP contracts over a real socket', async t => {
  const { db, close } = await openTestDb();
  t.after(close);
  const { site, other, cookies, building, room, moved, foreignAsset, foreignPlace, unpositioned } = await fixture(db);
  const server = createServer(db);
  t.after(async () => {
    if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const base = `http://127.0.0.1:${server.address().port}/api/assets`;
  async function request(path, role, status, code, { method = 'GET', body } = {}) {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { ...(role ? { cookie: cookies[role] } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body && JSON.stringify(body),
    });
    const result = await response.json();
    assert.equal(response.status, status);
    if (code) assert.equal(result.code, code);
    return result;
  }

  for (const role of ['owner', 'editor', 'verifier', 'viewer']) {
    assert.equal((await request(`/${moved.id}`, role, 200)).historyCount, 1);
    assert.equal((await request(`/${moved.id}/positions`, role, 200))[0].place_id, room.id);
  }
  assert.deepEqual(await request(`/${unpositioned.id}/positions`, 'viewer', 200), []);
  for (const suffix of ['', '/positions']) {
    await request(`/${foreignAsset.id}${suffix}`, 'viewer', 404, 'ASSET_NOT_FOUND');
    await request(`/${randomUUID()}${suffix}`, 'viewer', 404, 'ASSET_NOT_FOUND');
    await request(`/invalid${suffix}`, 'viewer', 400, 'VALIDATION_ERROR');
    await request(`/${moved.id}${suffix}`, undefined, 401, 'AUTH_REQUIRED');
  }
  const search = `?${new URLSearchParams({ siteId: site.id, placeId: building.id, asOf: start,
    tag: moved.tag, serial: 'SER-1', status: 'installed' })}`;
  assert.deepEqual((await request(search, 'viewer', 200)).map(row => row.id), [moved.id]);
  await request(`?siteId=${site.id}&status=unknown`, 'viewer', 400, 'VALIDATION_ERROR');
  await request(`?siteId=${other.id}`, 'viewer', 403, 'FORBIDDEN');
  await request(`?siteId=${randomUUID()}`, 'viewer', 404, 'SITE_NOT_FOUND');
  await request(`?siteId=${site.id}&placeId=${foreignPlace.id}`, 'viewer', 404, 'REFERENCE_NOT_FOUND');
  await request(`?siteId=${site.id}&placeId=${foreignPlace.id}`, 'owner', 422, 'CROSS_SITE_REFERENCE');
  await request(`/${moved.id}`, 'viewer', 403, 'FORBIDDEN', { method: 'PATCH', body: { status: 'replaced' } });
});
