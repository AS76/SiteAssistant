import { requireModule } from './module-access.mjs';
import { appendAuditEvent } from './audit.mjs';
import { randomUUID } from 'node:crypto';
import { RepositoryError, requireRole, WRITE_ROLES } from './repository.mjs';

const statuses = new Set(['available', 'in_use', 'maintenance', 'retired']);
const COLUMNS = 'id, site_id, name, code, company, status, location, notes, created_at, updated_at';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail = (status, message, code) => { throw new RepositoryError(status, message, code); };
const invalid = message => fail(400, message, 'TOOL_INVALID');

function requireUser(user) {
  if (!user?.id) fail(401, 'Authentication required.', 'UNAUTHENTICATED');
}

function object(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('Expected a JSON object.');
}

function validId(value, field) {
  if (typeof value !== 'string' || !uuid.test(value)) invalid(`${field} must be a UUID.`);
  return value.toLowerCase();
}

function validName(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 120) {
    invalid('name must contain between 1 and 120 characters.');
  }
  return value.trim();
}

function validStatus(value) {
  if (!statuses.has(value)) invalid('status must be available, in_use, maintenance or retired.');
  return value;
}

function optionalText(value, field) {
  if (value == null) return null;
  if (typeof value !== 'string' || value.length > 10000) invalid(`${field} must be a string of at most 10000 characters.`);
  return value.trim() || null;
}

async function toolRole(db, siteId, user, roles) {
  try {
    await requireRole(db, siteId, user, roles);
  } catch (error) {
    if (error instanceof RepositoryError && error.status === 403) {
      fail(403, 'Insufficient site role for tools.', 'TOOL_FORBIDDEN');
    }
    if (error instanceof RepositoryError && error.status === 404) {
      fail(404, 'Tool site not found.', 'TOOL_NOT_FOUND');
    }
    throw error;
  }
  await requireModule(db, siteId, user, 'tools');
}

export async function listTools(db, { siteId, company } = {}, user) {
  requireUser(user);
  const site = validId(siteId, 'site_id');
  const clauses = ['site_id = ?', 'deleted_at IS NULL'], values = [site];
  if (company != null && company !== '') {
    if (typeof company !== 'string') invalid('company must be a string.');
    clauses.push('company = ?'); values.push(company);
  }
  await toolRole(db, site, user);
  return await db.all(`SELECT ${COLUMNS} FROM tools WHERE ${clauses.join(' AND ')}
    ORDER BY company IS NULL, company, name, id`, ...values);
}

export async function createTool(db, input, user) {
  requireUser(user);
  object(input);
  const site = validId(input.site_id ?? input.siteId, 'site_id');
  const name = validName(input.name);
  const status = input.status === undefined ? 'available' : validStatus(input.status);
  const code = optionalText(input.code, 'code');
  const company = optionalText(input.company, 'company');
  const location = optionalText(input.location, 'location');
  const notes = optionalText(input.notes, 'notes');
  return await db.transaction(async tx => {
    await toolRole(tx, site, user, WRITE_ROLES);
    const now = new Date().toISOString();
    const row = await tx.get(`INSERT INTO tools
      (id, site_id, name, code, company, status, location, notes, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING ${COLUMNS}`,
    randomUUID(), site, name, code, company, status, location, notes, now, now);
    await appendAuditEvent(tx, { entityType: 'tool', action: 'create', after: row, actor: user.id, at: now });
    return row;
  });
}

export async function updateTool(db, id, input, user) {
  requireUser(user);
  const toolId = validId(id, 'id');
  object(input);
  const fields = new Map([
    ['name', value => validName(value)],
    ['code', value => optionalText(value, 'code')],
    ['company', value => optionalText(value, 'company')],
    ['status', value => validStatus(value)],
    ['location', value => optionalText(value, 'location')],
    ['notes', value => optionalText(value, 'notes')],
  ]);
  return await db.transaction(async tx => {
    // Serialize writers before reading the snapshot, including on PostgreSQL.
    await tx.run('UPDATE tools SET id = id WHERE id = ? AND deleted_at IS NULL', toolId);
    const row = await tx.get(`SELECT ${COLUMNS} FROM tools WHERE id = ? AND deleted_at IS NULL`, toolId);
    if (!row) fail(404, 'Tool not found.', 'TOOL_NOT_FOUND');
    await toolRole(tx, row.site_id, user, WRITE_ROLES);
    const changes = [], values = [];
    for (const [field, validate] of fields) {
      if (!Object.hasOwn(input, field)) continue;
      changes.push(`${field} = ?`); values.push(validate(input[field]));
    }
    if (!changes.length) {
      await appendAuditEvent(tx, { entityType: 'tool', action: 'update', before: row, after: row, actor: user.id });
      return row;
    }
    changes.push('updated_at = ?'); values.push(new Date().toISOString(), toolId);
    const updated = await tx.get(`UPDATE tools SET ${changes.join(', ')} WHERE id = ? RETURNING ${COLUMNS}`, ...values);
    if (!updated) fail(404, 'Tool not found.', 'TOOL_NOT_FOUND');
    await appendAuditEvent(tx, { entityType: 'tool', action: 'update', before: row, after: updated, actor: user.id });
    return updated;
  });
}

export async function deleteTool(db, id, user) {
  requireUser(user);
  const toolId = validId(id, 'id');
  return await db.transaction(async tx => {
    await tx.run('UPDATE tools SET id = id WHERE id = ? AND deleted_at IS NULL', toolId);
    const row = await tx.get(`SELECT ${COLUMNS} FROM tools WHERE id = ? AND deleted_at IS NULL`, toolId);
    if (!row) fail(404, 'Tool not found.', 'TOOL_NOT_FOUND');
    await toolRole(tx, row.site_id, user, WRITE_ROLES);
    const at = new Date().toISOString();
    const result = await tx.run('UPDATE tools SET deleted_at = ? WHERE id = ?', at, toolId);
    if (!result.rowCount) fail(404, 'Tool not found.', 'TOOL_NOT_FOUND');
    await appendAuditEvent(tx, { entityType: 'tool', action: 'delete', before: row, actor: user.id, at });
    return { deleted: true, id: toolId };
  });
}
