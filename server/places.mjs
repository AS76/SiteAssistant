import { createHash, randomUUID } from 'node:crypto';
import { appendAuditEvent } from './audit.mjs';
import { requireRole } from './repository.mjs';
import { checkSite, fail, invalid, lockSite, requireUser, scopedReference, text, uuid, validateInput } from './place-asset-scope.mjs';

const kinds = ['building', 'floor', 'zone', 'room'];

async function placeById(db, id) {
  return await db.get('SELECT * FROM places WHERE id = ?', id);
}

export async function activePlace(db, id, siteId, user, { includeArchived = false } = {}) {
  const place = await scopedReference(db, await placeById(db, id), siteId, user, 'Place');
  if (place.archived_at && !includeArchived) fail(409, 'PLACE_ARCHIVED', 'The place is archived.');
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

export async function recordedPlacePath(db, id, siteId, user, options) {
  return JSON.stringify(await ancestors(db, await activePlace(db, id, siteId, user, options)));
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

export async function listPlaces(db, { siteId, includeArchived = false, includeAliases = false }, user) {
  requireUser(user);
  const site = uuid(siteId, 'siteId');
  await requireRole(db, site, user);
  const places = await db.all(`SELECT * FROM places WHERE site_id = ?
    ${includeArchived ? '' : 'AND archived_at IS NULL'} ORDER BY name, id`, site);
  if (!includeAliases) return places;
  const byPlace = new Map(places.map(place => [place.id, []]));
  for (const alias of await db.all(`SELECT * FROM place_aliases WHERE site_id = ? AND valid_to IS NULL
    ORDER BY namespace, canonical_code`, site)) {
    byPlace.get(alias.place_id)?.push(alias);
  }
  return places.map(place => ({ ...place, aliases: byPlace.get(place.id) }));
}

async function readablePlace(db, id, user) {
  requireUser(user);
  const place = await db.get(`SELECT places.*, sites.name AS site_name FROM places
    JOIN sites ON sites.id = places.site_id
    JOIN accessible_site_members AS member ON member.site_id = places.site_id
    WHERE places.id = ? AND member.user_id = ?`, uuid(id, 'id'), user.id);
  if (!place) fail(404, 'PLACE_NOT_FOUND', 'Place not found.');
  return place;
}

async function placeDependencies(db, place) {
  const counts = await db.get(`WITH RECURSIVE subtree(id) AS (
      SELECT id FROM places WHERE id = ?
      UNION
      SELECT child.id FROM places AS child JOIN subtree ON child.parent_id = subtree.id
      WHERE child.site_id = ?
    )
    SELECT (SELECT COUNT(*) - 1 FROM subtree) AS descendants,
      (SELECT COUNT(*) FROM places WHERE site_id = ? AND parent_id = ? AND archived_at IS NULL) AS active_children,
      COUNT(CASE WHEN position.place_id = ? THEN 1 END) AS current_assets,
      COUNT(*) AS subtree_current_assets
    FROM asset_positions AS position JOIN subtree ON subtree.id = position.place_id
    WHERE position.site_id = ? AND position.valid_to IS NULL`,
  place.id, place.site_id, place.site_id, place.id, place.id, place.site_id);
  return Object.fromEntries(Object.entries(counts).map(([name, count]) => [name, Number(count)]));
}

export async function getPlace(db, id, user) {
  const { site_name, ...place } = await readablePlace(db, id, user);
  const path = JSON.parse(await recordedPlacePath(db, place.id, place.site_id, user, { includeArchived: true }));
  const aliases = await db.all(`SELECT * FROM place_aliases WHERE site_id = ? AND place_id = ?
    ORDER BY namespace, canonical_code`, place.site_id, place.id);
  return { ...place, path: [{ id: place.site_id, kind: 'site', name: site_name }, ...path],
    aliases, dependencies: await placeDependencies(db, place) };
}

export async function placeHistory(db, id, user) {
  const place = await readablePlace(db, id, user);
  const events = await db.all(`SELECT event.*, users.name AS actor_name FROM audit_events AS event
    LEFT JOIN users ON users.id = event.actor
    WHERE event.site_id = ? AND event.entity_type = 'place' AND event.entity_id = ?
    ORDER BY event.at, event.id`, place.site_id, place.id);
  return events.map(event => ({
    ...event, changes: typeof event.changes === 'string' ? JSON.parse(event.changes) : event.changes,
  }));
}

async function writePlaceAlias(db, id, user, write) {
  const place = await readablePlace(db, id, user);
  return await db.transaction(async tx => {
    await lockSite(tx, place.site_id, user);
    return await write(tx, await activePlace(tx, place.id, place.site_id, user, { includeArchived: true }));
  });
}

async function auditAlias(tx, place, user, before, after, at) {
  const snapshot = alias => ({ id: place.id, site_id: place.site_id, alias });
  await appendAuditEvent(tx, { entityType: 'place', action: 'update', actor: user.id, at,
    before: snapshot(before), after: snapshot(after) });
}

const aliasRoute = 'POST /api/places/:id/aliases';
const digest = parts => createHash('sha256').update(JSON.stringify(parts)).digest('hex');

function aliasText(value, field) {
  const trimmed = text(value, field);
  if (!value.isWellFormed() || value.includes('\0')) invalid(`${field} must contain valid Unicode text.`);
  return trimmed;
}

export async function addPlaceAlias(db, id, input, user, { key } = {}) {
  validateInput(input, ['namespace', 'canonicalCode', 'originalCode', 'source']);
  const namespace = aliasText(input.namespace, 'namespace').normalize('NFC');
  const canonical = aliasText(input.canonicalCode, 'canonicalCode').normalize('NFC');
  const { originalCode: original } = input;
  aliasText(original, 'originalCode');
  const source = aliasText(input.source, 'source');
  const requestKey = key === undefined ? null : text(key, 'Idempotency-Key');
  return await writePlaceAlias(db, id, user, async (tx, place) => {
    const storageKey = requestKey && `place-alias:${digest([place.id, user.id, requestKey])}`;
    const requestHash = storageKey && digest([namespace, canonical, original, source]);
    if (storageKey) {
      const previous = await tx.get('SELECT * FROM idempotency_keys WHERE key = ?', storageKey);
      if (previous) {
        if (previous.route !== aliasRoute || previous.request_hash !== requestHash) {
          fail(409, 'IDEMPOTENCY_KEY_REUSED', 'Idempotency key was already used for another request.');
        }
        return { alias: JSON.parse(previous.body), status: previous.status };
      }
    }
    if (place.archived_at) fail(409, 'PLACE_ARCHIVED', 'The place is archived.');
    const now = new Date().toISOString();
    const alias = await tx.get(`INSERT INTO place_aliases
      (id, site_id, place_id, namespace, canonical_code, original_code, source, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (site_id, namespace, canonical_code) DO NOTHING RETURNING *`,
    randomUUID(), place.site_id, place.id, namespace, canonical, original, source, now);
    if (!alias) fail(409, 'PLACE_ALIAS_CONFLICT', 'The canonical code is already reserved in this namespace.');
    await auditAlias(tx, place, user, null, alias, now);
    if (storageKey) {
      await tx.run(`INSERT INTO idempotency_keys (key, route, request_hash, status, body, created_at)
        VALUES (?, ?, ?, ?, ?, ?)`, storageKey, aliasRoute, requestHash, 201, JSON.stringify(alias), now);
    }
    return { alias, status: 201 };
  });
}

export async function removePlaceAlias(db, id, aliasId, user) {
  const target = uuid(aliasId, 'aliasId');
  return await writePlaceAlias(db, id, user, async (tx, place) => {
    const before = await tx.get(`SELECT * FROM place_aliases
      WHERE site_id = ? AND place_id = ? AND id = ? AND valid_to IS NULL`, place.site_id, place.id, target);
    if (!before) return { removed: false };
    if (place.archived_at) fail(409, 'PLACE_ARCHIVED', 'The place is archived.');
    const now = new Date(Math.max(Date.now(), Date.parse(before.created_at))).toISOString();
    const after = await tx.get('UPDATE place_aliases SET valid_to = ? WHERE id = ? RETURNING *', now, target);
    await auditAlias(tx, place, user, before, after, now);
    return { removed: true };
  });
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
