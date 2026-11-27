import { randomUUID } from 'node:crypto';
import { appendAuditEvent } from './audit.mjs';
import { activePlace, recordedPlacePath } from './places.mjs';
import { requireRole } from './repository.mjs';
import { checkSite, fail, instant, invalid, lockSite, requireUser, text, uuid, validateInput } from './place-asset-scope.mjs';

const transitions = {
  planned: ['installed', 'decommissioned'],
  installed: ['replaced', 'decommissioned'],
  replaced: [],
  decommissioned: [],
};
const fields = {
  tag: 'tag', name: 'name', category: 'category', status: 'status',
  serialNumber: 'serial_number', manufacturer: 'manufacturer', model: 'model',
  installedOn: 'installed_on', commissionedOn: 'commissioned_on', warrantyStart: 'warranty_start',
  warrantyEnd: 'warranty_end', warrantyProvider: 'warranty_provider',
};
const dateFields = new Set(['installedOn', 'commissionedOn', 'warrantyStart', 'warrantyEnd']);
const columns = Object.values(fields);
const calendarColumns = new Set([...dateFields].map(field => fields[field]));
const positionFields = ['placeId', 'validFrom', 'reason'];

function assetColumns(prefix = '') {
  return ['id', 'site_id', ...columns, 'archived_at', 'created_at', 'updated_at'].map(column =>
    calendarColumns.has(column) ? `CAST(${prefix}${column} AS TEXT) AS ${column}` : `${prefix}${column}`).join(', ');
}

function date(value, field) {
  if (value === null) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000')) {
    invalid(`${field} must be a calendar date (YYYY-MM-DD).`);
  }
  instant(`${value}T00:00:00.000Z`, field);
  return value;
}

function values(input, before = {}) {
  const asset = {};
  for (const [field, column] of Object.entries(fields)) {
    const value = Object.hasOwn(input, field) ? input[field] : before[column] ?? null;
    if (field === 'status') {
      asset.status = value ?? 'planned';
      if (!Object.hasOwn(transitions, asset.status) || (Object.hasOwn(input, field) && value === null)) invalid('Invalid asset status.');
    } else if (dateFields.has(field)) {
      asset[column] = date(value, field);
    } else {
      asset[column] = text(value, field, { optional: !['name', 'tag', 'category'].includes(field) });
    }
  }
  if (asset.warranty_start && asset.warranty_end && asset.warranty_end < asset.warranty_start) {
    fail(422, 'INVALID_WARRANTY_PERIOD', 'Warranty end must be on or after warranty start.');
  }
  if (asset.status === 'installed' && !asset.installed_on) {
    fail(422, 'INSTALLATION_DATE_REQUIRED', 'An installed asset requires installedOn.');
  }
  return asset;
}

function canHavePosition(status) {
  return status === 'planned' || status === 'installed';
}

const asIso = value => value instanceof Date ? value.toISOString() : value;

async function currentPosition(tx, assetId) {
  return await tx.get('SELECT * FROM asset_positions WHERE asset_id = ? AND valid_to IS NULL', assetId);
}

async function closePosition(tx, position, end) {
  if (!position) return;
  if (end <= asIso(position.valid_from)) {
    fail(409, 'POSITION_TIME_CONFLICT', 'The position must end after it began.');
  }
  await tx.run('UPDATE asset_positions SET valid_to = ? WHERE asset_id = ? AND valid_to IS NULL', end, position.asset_id);
}

async function setPosition(tx, asset, before, input, user, now) {
  const place = uuid(input.placeId, 'placeId');
  const at = input.validFrom === undefined ? now : instant(input.validFrom, 'validFrom');
  if (at > now) fail(422, 'POSITION_IN_FUTURE', 'Position start cannot be in the future.');
  const reason = text(input.reason, 'reason', { optional: true, max: 2000 });
  const path = await recordedPlacePath(tx, place, asset.site_id, user);
  if (before?.place_id === place) fail(409, 'POSITION_UNCHANGED', 'The asset already occupies this place.');
  await closePosition(tx, before, at);
  return await tx.get(`INSERT INTO asset_positions
    (asset_id, place_id, site_id, valid_from, created_by, reason, recorded_path)
    VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`, asset.id, place, asset.site_id, at, user.id, reason, path);
}

function requireInstalledPosition(asset, position) {
  if (asset.status === 'installed' && !position) {
    fail(422, 'ASSET_POSITION_REQUIRED', 'An installed asset requires a current place.');
  }
}

async function writeWithTag(tx, write) {
  try {
    return await write();
  } catch (error) {
    if (tx.isUniqueViolation(error) &&
        (error.constraint === 'assets_site_active_tag' || error.message.includes('assets.site_id, assets.tag'))) {
      fail(409, 'DUPLICATE_ASSET_TAG', 'An active asset already uses this tag at the site.');
    }
    throw error;
  }
}

export async function listAssets(db, { siteId, includeArchived = false, asOf, tag, serial, status, placeId }, user) {
  requireUser(user);
  const site = uuid(siteId, 'siteId');
  await requireRole(db, site, user);
  const at = asOf == null ? null : instant(asOf, 'asOf');
  const validity = at === null ? 'p.valid_to IS NULL' : 'p.valid_from <= ? AND (p.valid_to IS NULL OR p.valid_to > ?)';
  const subtree = placeId == null ? null : uuid(placeId, 'placeId');
  if (subtree) await activePlace(db, subtree, site, user, { includeArchived: true });
  if (status != null && (typeof status !== 'string' || !Object.hasOwn(transitions, status))) invalid('Invalid asset status.');
  const filters = { tag: text(tag, 'tag', { optional: true }),
    serial_number: text(serial, 'serial', { optional: true }), status };
  const predicates = Object.entries(filters).filter(([, value]) => value != null);
  return await db.all(`${subtree ? `WITH RECURSIVE subtree(id) AS (
      SELECT id FROM places WHERE site_id = ? AND id = ?
      UNION
      SELECT p.id FROM places p JOIN subtree s ON p.parent_id = s.id WHERE p.site_id = ?
    )` : ''}
    SELECT ${assetColumns('a.')}, p.place_id, p.valid_from, p.valid_to, p.recorded_path
    FROM assets a LEFT JOIN asset_positions p ON p.asset_id = a.id AND ${validity}
    WHERE a.site_id = ? ${includeArchived ? '' : 'AND a.archived_at IS NULL'}
    ${predicates.map(([column]) => `AND a.${column} = ?`).join(' ')}
    ${subtree ? 'AND p.place_id IN (SELECT id FROM subtree)' : ''}
    ORDER BY a.tag, a.id`, ...(subtree ? [site, subtree, site] : []), ...(at === null ? [] : [at, at]), site,
    ...predicates.map(([, value]) => value));
}

const assetReadScope = `a.id = ? AND EXISTS (
  SELECT 1 FROM accessible_site_members m WHERE m.site_id = a.site_id AND m.user_id = ?
)`;

function requireReadableAsset(row) {
  if (!row) fail(404, 'ASSET_NOT_FOUND', 'Asset not found.');
  return row;
}

export async function getAsset(db, id, user) {
  requireUser(user);
  const row = requireReadableAsset(await db.get(`SELECT ${assetColumns('a.')}, s.name AS site_name,
    p.place_id, p.valid_from, p.reason, p.recorded_path,
    (SELECT COUNT(*) FROM asset_positions h WHERE h.asset_id = a.id AND h.valid_to IS NOT NULL) AS history_count
    FROM assets a JOIN sites s ON s.id = a.site_id
    LEFT JOIN asset_positions p ON p.asset_id = a.id AND p.valid_to IS NULL
    WHERE ${assetReadScope}`, uuid(id, 'id'), user.id));
  const { site_name, place_id, valid_from, reason, recorded_path, history_count, ...asset } = row;
  let currentPosition = null;
  if (place_id) {
    const path = JSON.parse(await recordedPlacePath(db, place_id, asset.site_id, user, { includeArchived: true }));
    currentPosition = { place_id, valid_from, valid_to: null, reason, recorded_path,
      path: [{ id: asset.site_id, kind: 'site', name: site_name }, ...path] };
  }
  return { ...asset, currentPosition, historyCount: Number(history_count) };
}

export async function listAssetPositions(db, id, user) {
  requireUser(user);
  const rows = await db.all(`SELECT p.place_id, p.valid_from, p.valid_to, p.reason, p.recorded_path
    FROM assets a LEFT JOIN asset_positions p ON p.asset_id = a.id
    WHERE ${assetReadScope} ORDER BY p.valid_from, p.place_id`, uuid(id, 'id'), user.id);
  requireReadableAsset(rows[0]);
  return rows.filter(row => row.place_id != null);
}

export async function createAsset(db, input, user) {
  requireUser(user);
  validateInput(input, ['siteId', ...Object.keys(fields), ...positionFields]);
  const siteId = uuid(input.siteId, 'siteId');
  const asset = values(input);
  if (!canHavePosition(asset.status)) fail(422, 'ASSET_STATUS_TRANSITION', 'A new asset must be planned or installed.');
  if (input.placeId == null && (input.validFrom !== undefined || input.reason !== undefined)) {
    invalid('Position metadata requires placeId.');
  }
  requireInstalledPosition(asset, input.placeId);
  return await db.transaction(async tx => {
    await lockSite(tx, siteId, user);
    const now = new Date().toISOString();
    const after = await writeWithTag(tx, () => tx.get(`INSERT INTO assets
      (id, site_id, ${columns.join(', ')}, created_at, updated_at)
      VALUES (?, ?, ${columns.map(() => '?').join(', ')}, ?, ?) RETURNING ${assetColumns()}`,
    randomUUID(), siteId, ...columns.map(column => asset[column]), now, now));
    const position = input.placeId == null ? null : await setPosition(tx, after, null, input, user, now);
    await appendAuditEvent(tx, { entityType: 'asset', action: 'create', after: { ...after,
      place_id: position?.place_id, valid_from: position?.valid_from }, actor: user.id, at: now, note: position?.reason });
    return after;
  });
}

async function writeAsset(db, id, user, write) {
  requireUser(user);
  const assetId = uuid(id, 'id');
  const initial = await db.get('SELECT site_id FROM assets WHERE id = ?', assetId);
  if (!initial) fail(404, 'ASSET_NOT_FOUND', 'Asset not found.');
  return await db.transaction(async tx => {
    await lockSite(tx, initial.site_id, user);
    const before = await tx.get(`SELECT ${assetColumns()} FROM assets WHERE id = ?`, assetId);
    if (before.archived_at) fail(409, 'ASSET_ARCHIVED', 'The asset is archived.');
    return await write(tx, before);
  });
}

export async function updateAsset(db, id, input, user) {
  validateInput(input, ['siteId', ...Object.keys(fields), 'reason']);
  return await writeAsset(db, id, user, async (tx, before) => {
    checkSite(input, before.site_id);
    const asset = values(input, before);
    const reason = text(input.reason, 'reason', { optional: true, max: 2000 });
    if (asset.status !== before.status && !transitions[before.status].includes(asset.status)) {
      fail(422, 'ASSET_STATUS_TRANSITION', 'Invalid asset status transition.');
    }
    if (before.status === 'planned' && asset.status === 'decommissioned' && !reason) {
      fail(422, 'ASSET_TRANSITION_REASON_REQUIRED', 'Cancelling a planned asset requires a reason.');
    }
    const position = await currentPosition(tx, before.id);
    requireInstalledPosition(asset, position);
    const now = new Date().toISOString();
    const closesPosition = position && !canHavePosition(asset.status);
    if (closesPosition) await closePosition(tx, position, now);
    const after = await writeWithTag(tx, () => tx.get(`UPDATE assets SET
      ${columns.map(column => `${column} = ?`).join(', ')}, updated_at = ? WHERE id = ? RETURNING ${assetColumns()}`,
    ...columns.map(column => asset[column]), now, before.id));
    await appendAuditEvent(tx, { entityType: 'asset', action: 'update',
      before: { ...before, place_id: position?.place_id ?? null },
      after: { ...after, place_id: closesPosition ? null : position?.place_id ?? null },
      actor: user.id, at: now, note: reason });
    return after;
  });
}

export async function archiveAsset(db, id, input, user) {
  validateInput(input, ['reason']);
  const reason = text(input.reason, 'reason', { optional: true, max: 2000 });
  return await writeAsset(db, id, user, async (tx, before) => {
    const now = new Date().toISOString();
    const position = await currentPosition(tx, before.id);
    await closePosition(tx, position, now);
    const after = await tx.get(`UPDATE assets SET archived_at = ?, updated_at = ? WHERE id = ? RETURNING ${assetColumns()}`, now, now, before.id);
    await appendAuditEvent(tx, { entityType: 'asset', action: 'archive', before: { ...before, place_id: position?.place_id ?? null },
      after: { ...after, place_id: null }, actor: user.id, at: now, note: reason });
    return after;
  });
}

export async function moveAsset(db, id, input, user) {
  validateInput(input, positionFields);
  return await writeAsset(db, id, user, async (tx, asset) => {
    if (!canHavePosition(asset.status)) fail(409, 'ASSET_STATUS_POSITION', 'This asset status cannot have a current position.');
    const before = await currentPosition(tx, asset.id);
    const now = new Date().toISOString();
    const after = await setPosition(tx, asset, before, input, user, now);
    await tx.run('UPDATE assets SET updated_at = ? WHERE id = ?', now, asset.id);
    await appendAuditEvent(tx, { entityType: 'asset', action: 'move',
      before: { ...asset, place_id: before?.place_id ?? null, valid_from: before?.valid_from ?? null },
      after: { ...asset, place_id: after.place_id, valid_from: after.valid_from },
      actor: user.id, at: now, note: after.reason });
    return after;
  });
}
