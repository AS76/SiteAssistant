import { EDIT_ROLES, RepositoryError, requireRole } from './repository.mjs';

export function fail(status, code, message) {
  throw new RepositoryError(status, message, code);
}

export function invalid(message) {
  fail(400, 'VALIDATION_ERROR', message);
}

export function uuid(value, field) {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value)) {
    invalid(`${field} must be a UUID.`);
  }
  return value.toLowerCase();
}

export function validateInput(input, fields) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid('Expected a JSON object.');
  for (const key of Object.keys(input)) {
    if (!fields.includes(key)) invalid(`Unsupported field: ${key}.`);
  }
}

export function text(value, field, { optional = false, max = 200 } = {}) {
  if (optional && value == null) return null;
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    invalid(`${field} must be a nonempty string of at most ${max} characters.`);
  }
  return value.trim();
}

export function instant(value, field) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
      value.startsWith('0000') || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    invalid(`${field} must be a UTC timestamp in ISO format with milliseconds.`);
  }
  return value;
}

export function requireUser(user) {
  if (!user?.id) fail(401, 'UNAUTHENTICATED', 'Authentication required.');
}

export async function lockSite(tx, siteId, user) {
  await requireRole(tx, siteId, user, EDIT_ROLES);
  // Serialize hierarchy and position writes with one another and membership updates.
  await tx.run('UPDATE sites SET id = id WHERE id = ?', siteId);
  await requireRole(tx, siteId, user, EDIT_ROLES);
}

export async function scopedReference(db, row, siteId, user, label) {
  if (row?.site_id === siteId) return row;
  if (row && await db.get('SELECT 1 FROM accessible_site_members WHERE site_id = ? AND user_id = ?', row.site_id, user.id)) {
    fail(422, 'CROSS_SITE_REFERENCE', `${label} belongs to a different site.`);
  }
  fail(404, 'REFERENCE_NOT_FOUND', `${label} not found.`);
}

export function checkSite(input, siteId) {
  if (Object.hasOwn(input, 'siteId') && uuid(input.siteId, 'siteId') !== siteId) {
    fail(422, 'SITE_IMMUTABLE', 'The site cannot change.');
  }
}
