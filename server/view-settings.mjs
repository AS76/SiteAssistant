import { randomUUID } from 'node:crypto';
import { RepositoryError, requireRole, WRITE_ROLES } from './repository.mjs';

const modules = new Set(['tasks', 'deviations', 'progress', 'bookings', 'impacts', 'wbs']);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail = (status, message, code) => { throw new RepositoryError(status, message, code); };
const invalid = message => fail(400, message, 'VIEW_INVALID');
const publicView = row => ({ ...row, shared: Boolean(row.shared), payload: JSON.parse(row.payload) });

function requireUser(user) {
  if (!user?.id) fail(401, 'Authentication required.', 'UNAUTHENTICATED');
}

function validId(value, field) {
  if (typeof value !== 'string' || !uuid.test(value)) invalid(`${field} must be a UUID.`);
  return value.toLowerCase();
}

function validModule(value) {
  if (!modules.has(value)) invalid('Unknown view module.');
  return value;
}

function validName(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 80) {
    invalid('name must contain between 1 and 80 characters.');
  }
  return value.trim();
}

function validShared(value) {
  if (typeof value !== 'boolean') invalid('shared must be a boolean.');
  return value;
}

function object(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('Expected a JSON object.');
}

function validPayload(value) {
  object(value);
  let serialized;
  try { serialized = JSON.stringify(value); }
  catch { invalid('payload must be JSON serializable.'); }
  if (typeof serialized !== 'string') invalid('payload must be a JSON object.');
  // Validate the serialized top level too (e.g. objects with a toJSON method).
  object(JSON.parse(serialized));
  if (Buffer.byteLength(serialized, 'utf8') >= 16 * 1024) invalid('payload must be smaller than 16 KB.');
  return serialized;
}

async function viewRole(db, siteId, user, roles) {
  try { return await requireRole(db, siteId, user, roles); }
  catch (error) {
    if (error instanceof RepositoryError && error.status === 403) {
      fail(403, 'Insufficient site role for this view.', 'VIEW_FORBIDDEN');
    }
    if (error instanceof RepositoryError && error.status === 404) {
      fail(404, 'View site not found.', 'VIEW_NOT_FOUND');
    }
    throw error;
  }
}

async function uniqueWrite(db, write) {
  try { return await write(); }
  catch (error) {
    if (db.isUniqueViolation(error)) fail(409, 'A view with this name already exists.', 'VIEW_NAME_TAKEN');
    throw error;
  }
}

export async function listViews(db, { siteId, module } = {}, user) {
  requireUser(user);
  const site = validId(siteId, 'site_id');
  validModule(module);
  const role = await viewRole(db, site, user);
  return (await db.all(`SELECT * FROM view_settings WHERE site_id = ? AND module = ?
    ${role === 'owner' ? '' : 'AND (shared = TRUE OR owner_id = ?)'} ORDER BY name, id`,
  site, module, ...(role === 'owner' ? [] : [user.id]))).map(publicView);
}

export async function createView(db, { siteId, module, name, shared = false, payload } = {}, user) {
  requireUser(user);
  const site = validId(siteId, 'site_id');
  validModule(module);
  const viewName = validName(name), isShared = validShared(shared), state = validPayload(payload);
  await viewRole(db, site, user, WRITE_ROLES);
  const now = new Date().toISOString();
  return publicView(await uniqueWrite(db, () => db.get(`INSERT INTO view_settings
    (id, site_id, module, name, owner_id, shared, payload, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ${isShared ? 'TRUE' : 'FALSE'}, ?, ?, ?) RETURNING *`,
  randomUUID(), site, module, viewName, user.id, state, now, now)));
}

async function editableView(db, id, user) {
  const row = await db.get('SELECT * FROM view_settings WHERE id = ?', id);
  if (!row) fail(404, 'View not found.', 'VIEW_NOT_FOUND');
  const role = await viewRole(db, row.site_id, user);
  if (row.owner_id !== user.id && role !== 'owner') fail(403, 'Only the view owner or a site owner may change this view.', 'VIEW_FORBIDDEN');
  return row;
}

export async function updateView(db, id, input, user) {
  requireUser(user);
  const viewId = validId(id, 'id');
  object(input);
  return await db.transaction(async tx => {
    const row = await editableView(tx, viewId, user);
    const changes = [], values = [];
    if (Object.hasOwn(input, 'name')) { changes.push('name = ?'); values.push(validName(input.name)); }
    if (Object.hasOwn(input, 'shared')) changes.push(`shared = ${validShared(input.shared) ? 'TRUE' : 'FALSE'}`);
    if (Object.hasOwn(input, 'payload')) { changes.push('payload = ?'); values.push(validPayload(input.payload)); }
    if (!changes.length) return publicView(row);
    changes.push('updated_at = ?'); values.push(new Date().toISOString(), viewId);
    const updated = await uniqueWrite(tx, () => tx.get(`UPDATE view_settings SET ${changes.join(', ')} WHERE id = ? RETURNING *`, ...values));
    if (!updated) fail(404, 'View not found.', 'VIEW_NOT_FOUND');
    return publicView(updated);
  });
}

export async function deleteView(db, id, user) {
  requireUser(user);
  const viewId = validId(id, 'id');
  return await db.transaction(async tx => {
    await editableView(tx, viewId, user);
    const result = await tx.run('DELETE FROM view_settings WHERE id = ?', viewId);
    if (!result.rowCount) fail(404, 'View not found.', 'VIEW_NOT_FOUND');
    return { deleted: true };
  });
}
