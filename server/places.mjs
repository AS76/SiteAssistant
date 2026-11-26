import { randomUUID } from 'node:crypto';
import { appendAuditEvent } from './audit.mjs';
import { requireRole } from './repository.mjs';
import { checkSite, fail, invalid, lockSite, requireUser, scopedReference, text, uuid, validateInput } from './place-asset-scope.mjs';

const kinds = ['building', 'floor', 'zone', 'room'];

async function placeById(db, id) {
  return await db.get('SELECT * FROM places WHERE id = ?', id);
}

export async function activePlace(db, id, siteId, user) {
  const place = await scopedReference(db, await placeById(db, id), siteId, user, 'Place');
  if (place.archived_at) fail(409, 'PLACE_ARCHIVED', 'The place is archived.');
  return place;
}

async function ancestors(db, place) {
  const path = [];
  for (let node = place; node; node = node.parent_id ? await placeById(db, node.parent_id) : null) {
    if (path.some(ancestor => ancestor.id === node.id)) fail(409, 'PLACE_CYCLE', 'The place hierarchy contains a cycle.');
    path.push({ id: node.id, kind: node.kind, name: node.name });
  }
  return path.reverse();
}

export async function recordedPlacePath(db, id, siteId, user) {
  return JSON.stringify(await ancestors(db, await activePlace(db, id, siteId, user)));
}

async function validateParent(tx, place, parentId, user) {
  if (parentId === null) return;
  const parent = await activePlace(tx, parentId, place.site_id, user);
  if ((await ancestors(tx, parent)).some(node => node.id === place.id)) {
    fail(409, 'PLACE_CYCLE', 'A place cannot move below itself or a descendant.');
  }
  if (kinds.indexOf(parent.kind) >= kinds.indexOf(place.kind)) {
    fail(422, 'PLACE_KIND_ORDER', 'The parent kind must precede the child kind.');
  }
}

function parentId(value) {
  return value == null ? null : uuid(value, 'parentId');
}

export async function listPlaces(db, { siteId, includeArchived = false }, user) {
  requireUser(user);
  const site = uuid(siteId, 'siteId');
  await requireRole(db, site, user);
  return await db.all(`SELECT * FROM places WHERE site_id = ?
    ${includeArchived ? '' : 'AND archived_at IS NULL'} ORDER BY name, id`, site);
}

export async function createPlace(db, input, user) {
  requireUser(user);
  validateInput(input, ['siteId', 'parentId', 'kind', 'name']);
  const siteId = uuid(input.siteId, 'siteId');
  const name = text(input.name, 'name');
  if (!kinds.includes(input.kind)) invalid('kind must be building, floor, zone or room.');
  const parent = parentId(input.parentId);
  return await db.transaction(async tx => {
    await lockSite(tx, siteId, user);
    const id = randomUUID();
    await validateParent(tx, { id, site_id: siteId, kind: input.kind }, parent, user);
    const now = new Date().toISOString();
    const after = await tx.get(`INSERT INTO places (id, site_id, parent_id, kind, name, created_at, updated_at, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`, id, siteId, parent, input.kind, name, now, now, user.id);
    await appendAuditEvent(tx, { entityType: 'place', action: 'create', after, actor: user.id, at: now });
    return after;
  });
}

async function writePlace(db, id, user, write) {
  requireUser(user);
  const placeId = uuid(id, 'id');
  const initial = await placeById(db, placeId);
  if (!initial) fail(404, 'PLACE_NOT_FOUND', 'Place not found.');
  return await db.transaction(async tx => {
    await lockSite(tx, initial.site_id, user);
    return await write(tx, await activePlace(tx, placeId, initial.site_id, user));
  });
}

export async function updatePlace(db, id, input, user) {
  validateInput(input, ['siteId', 'name', 'parentId', 'reason']);
  return await writePlace(db, id, user, async (tx, before) => {
    checkSite(input, before.site_id);
    const name = Object.hasOwn(input, 'name') ? text(input.name, 'name') : before.name;
    const parent = Object.hasOwn(input, 'parentId') ? parentId(input.parentId) : before.parent_id;
    const reason = text(input.reason, 'reason', { optional: true, max: 2000 });
    const moved = parent !== before.parent_id;
    if (moved) await validateParent(tx, before, parent, user);
    if (!moved && name === before.name) return before;
    const now = new Date().toISOString();
    const after = await tx.get('UPDATE places SET name = ?, parent_id = ?, updated_at = ? WHERE id = ? RETURNING *',
      name, parent, now, before.id);
    await appendAuditEvent(tx, { entityType: 'place', action: moved ? 'move' : 'update',
      before, after, actor: user.id, at: now, note: reason });
    return after;
  });
}

export async function archivePlace(db, id, input, user) {
  validateInput(input, ['reason']);
  const reason = text(input.reason, 'reason', { optional: true, max: 2000 });
  return await writePlace(db, id, user, async (tx, before) => {
    if (await tx.get('SELECT 1 FROM places WHERE site_id = ? AND parent_id = ? AND archived_at IS NULL',
      before.site_id, before.id)) {
      fail(409, 'PLACE_HAS_ACTIVE_CHILDREN', 'The place has active children.');
    }
    if (await tx.get('SELECT 1 FROM asset_positions WHERE site_id = ? AND place_id = ? AND valid_to IS NULL',
      before.site_id, before.id)) {
      fail(409, 'PLACE_HAS_CURRENT_ASSETS', 'The place has assets with a current position.');
    }
    const now = new Date().toISOString();
    const after = await tx.get('UPDATE places SET archived_at = ?, updated_at = ? WHERE id = ? RETURNING *',
      now, now, before.id);
    await appendAuditEvent(tx, { entityType: 'place', action: 'archive', before, after, actor: user.id, at: now, note: reason });
    return after;
  });
}
