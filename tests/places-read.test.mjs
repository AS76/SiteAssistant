import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { appendAuditEvent } from '../server/audit.mjs';
import { createAsset } from '../server/assets.mjs';
import { hashPassword } from '../server/auth.mjs';
import { createServer } from '../server/http.mjs';
import { createSite } from '../server/repository.mjs';
import { addPlaceAlias, archivePlace, createPlace, getPlace, listPlaces, placeHistory, removePlaceAlias, updatePlace } from '../server/places.mjs';
import { authFixture } from './helpers/auth.mjs';
import { openTestDb } from './helpers/db.mjs';

let db, close, site, other, users, cookies, building, room, hidden;
const placeInput = { kind: 'room', name: 'Example room' };
const aliasInput = { namespace: 'example', canonicalCode: 'A-01', originalCode: 'A-01', source: 'Synthetic sample' };
const notFound = { status: 404, code: 'PLACE_NOT_FOUND' };
const forbidden = { status: 403, code: 'FORBIDDEN' };

test.before(async () => {
  ({ db, close } = await openTestDb());
  site = await createSite(db, { code: 'TEST-READ', name: 'Example site' });
  other = await createSite(db, { code: 'TEST-OTHER', name: 'Second example site' });
  ({ users, cookies } = await authFixture(db, site));
  await db.run("INSERT INTO site_members VALUES (?, ?, 'owner')", other.id, users.owner.id);
  const create = (siteId, input) => createPlace(db, { siteId, ...input }, users.owner);
  building = await create(site.id, { kind: 'building', name: 'Example building' });
  room = await create(site.id, { ...placeInput, parentId: building.id });
  hidden = await create(other.id, placeInput);
});

test.after(() => close?.());

test('single read includes site, ancestors, place, aliases and scoped dependency counts', async () => {
  await createAsset(db, { siteId: site.id, tag: 'TEST-ASSET', name: 'Example asset', category: 'pump', placeId: room.id }, users.owner);
  const { alias } = await addPlaceAlias(db, room.id, aliasInput, users.editor);
  const detail = await getPlace(db, room.id, users.viewer);
  assert.deepEqual(detail.path.map(node => [node.id, node.kind, node.name]), [
    [site.id, 'site', site.name], [building.id, 'building', building.name], [room.id, 'room', room.name],
  ]);
  assert.equal(detail.aliases[0].id, alias.id);
  assert.deepEqual(detail.dependencies, { descendants: 0, active_children: 0, current_assets: 1, subtree_current_assets: 1 });
  const parent = await getPlace(db, building.id, users.verifier);
  assert.deepEqual(parent.dependencies, { descendants: 1, active_children: 1, current_assets: 0, subtree_current_assets: 1 });
});

test('single place and history conceal inaccessible IDs like nonexistent IDs', async () => {
  for (const read of [getPlace, placeHistory]) {
    await assert.rejects(read(db, hidden.id, users.viewer), notFound);
    await assert.rejects(read(db, randomUUID(), users.viewer), notFound);
    await assert.rejects(read(db, hidden.id), { status: 401, code: 'UNAUTHENTICATED' });
    await assert.rejects(read(db, 'bad-id', users.viewer), { status: 400, code: 'VALIDATION_ERROR' });
  }
});

test('history is chronological, scoped to the place, and retains before and after', async () => {
  const place = await createPlace(db, { siteId: site.id, name: 'First name', kind: 'zone' }, users.owner);
  const middle = { ...place, name: 'Middle name' };
  const last = { ...middle, name: 'Latest name' };
  const earlier = new Date(Date.parse(place.created_at) + 1000).toISOString();
  const later = new Date(Date.parse(place.created_at) + 2000).toISOString();
  await appendAuditEvent(db, { entityType: 'place', action: 'update', before: middle, after: last, actor: users.editor.id, at: later });
  await appendAuditEvent(db, { entityType: 'place', action: 'update', before: place, after: middle, actor: users.editor.id, at: earlier });
  const history = await placeHistory(db, place.id, users.verifier);
  assert.equal(history.length, 3);
  assert.deepEqual(history.map(event => event.entity_id), Array(3).fill(place.id));
  const updates = history.filter(event => event.action === 'update');
  assert.deepEqual(history.map(event => new Date(event.at).toISOString()), [place.created_at, earlier, later]);
  assert.deepEqual(updates[0].changes.name, { from: place.name, to: middle.name });
  assert.equal(updates[0].actor, users.editor.id);
  assert.equal(updates[0].actor_name, users.editor.name);
});

test('detail updates the path on move and remains readable after archive', async () => {
  const place = await createPlace(db, { siteId: site.id, ...placeInput, parentId: building.id }, users.owner);
  const moved = await updatePlace(db, place.id, { parentId: null, name: 'Moved example' }, users.editor);
  assert.equal(moved.id, place.id);
  await archivePlace(db, place.id, { reason: 'Synthetic archive' }, users.editor);
  const detail = await getPlace(db, place.id, users.viewer);
  assert.ok(detail.archived_at);
  assert.deepEqual(detail.path.map(node => [node.id, node.name]), [[site.id, site.name], [place.id, moved.name]]);
  assert.equal((await listPlaces(db, { siteId: site.id }, users.viewer)).some(row => row.id === place.id), false);
  assert.ok((await placeHistory(db, place.id, users.viewer)).some(event => event.action === 'archive'));
});

test('owner and editor can write aliases while viewer and verifier can only read', async () => {
  const place = await createPlace(db, { siteId: site.id, ...placeInput }, users.owner);
  const { alias } = await addPlaceAlias(db, place.id, { ...aliasInput, canonicalCode: 'ROLES' }, users.owner);
  for (const role of ['viewer', 'verifier']) {
    const user = users[role];
    assert.equal((await getPlace(db, place.id, user)).id, place.id);
    assert.ok((await placeHistory(db, place.id, user)).length);
    await assert.rejects(addPlaceAlias(db, place.id, aliasInput, user), forbidden);
    await assert.rejects(removePlaceAlias(db, place.id, alias.id, user), forbidden);
  }
  assert.deepEqual(await removePlaceAlias(db, place.id, alias.id, users.editor), { removed: true });
  await assert.rejects(addPlaceAlias(db, hidden.id, aliasInput, users.editor), notFound);
});

test('demo_user can read and write aliases only with sandbox membership', async () => {
  const sandbox = await createSite(db, { code: 'TEST-SANDBOX', name: 'Example sandbox' }, { demoSandbox: true });
  const demo = { id: randomUUID() };
  await db.run(`INSERT INTO users (id, email, name, password_hash, password_algo, demo_sandbox, created_at)
    VALUES (?, ?, ?, ?, 'scrypt', TRUE, ?)`, demo.id, 'place-demo@example.invalid', 'Example demo',
  await hashPassword('Synthetic-demo-password!'), new Date().toISOString());
  await db.run("INSERT INTO site_members VALUES (?, ?, 'demo_user')", sandbox.id, demo.id);
  await db.run("INSERT INTO site_members VALUES (?, ?, 'demo_user')", site.id, demo.id);
  const place = await createPlace(db, { siteId: sandbox.id, ...placeInput }, demo);
  const { alias } = await addPlaceAlias(db, place.id, aliasInput, demo);
  assert.equal((await getPlace(db, place.id, demo)).aliases[0].id, alias.id);
  assert.ok((await placeHistory(db, place.id, demo)).length);
  await assert.rejects(getPlace(db, room.id, demo), notFound);
  await assert.rejects(addPlaceAlias(db, room.id, aliasInput, demo), notFound);
  await assert.rejects(removePlaceAlias(db, room.id, alias.id, demo), notFound);
});

test('HTTP routes return codes for authorized, forbidden, duplicate and hidden requests', async t => {
  const server = createServer(db);
  t.after(() => new Promise(resolve => server.close(resolve)));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}/api/places`;
  const api = async (path, { role, method = 'GET', body, key } = {}) => {
    const headers = {
      ...(role ? { cookie: cookies[role] } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(key ? { 'idempotency-key': key } : {}),
    };
    const response = await fetch(base + path, { method, headers, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const place = '/' + room.id;
  assert.equal((await api(place)).status, 401);
  assert.equal((await api(place, { role: 'viewer' })).status, 200);
  assert.equal((await api(place + '/history', { role: 'verifier' })).status, 200);
  assert.equal((await api('/' + hidden.id, { role: 'viewer' })).status, 404);
  assert.equal((await api('/' + hidden.id + '/history', { role: 'viewer' })).status, 404);
  const aliases = place + '/aliases';
  const body = { ...aliasInput, canonicalCode: 'WIRE' };
  assert.equal((await api(aliases, { role: 'viewer', body, method: 'POST' })).status, 403);
  const creation = { role: 'editor', body, method: 'POST', key: 'wire-request' };
  const created = await api(aliases, creation);
  assert.equal(created.status, 201);
  assert.deepEqual(await api(aliases, creation), created);
  const duplicate = await api(aliases, { ...creation, key: 'wire-duplicate' });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.body.code, 'PLACE_ALIAS_CONFLICT');
  const alias = aliases + '/' + created.body.id;
  assert.deepEqual(await api(alias, { role: 'editor', method: 'DELETE' }), { status: 200, body: { removed: true } });
  assert.deepEqual(await api(alias, { role: 'editor', method: 'DELETE' }), { status: 200, body: { removed: false } });
});
