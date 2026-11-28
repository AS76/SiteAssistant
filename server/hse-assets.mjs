import { HSE_READ_ROLES, HSE_WRITE_ROLES } from '../app/hse-permissions.mjs';
import { randomUUID } from 'node:crypto';
import { RepositoryError, getSite, requireRole } from './repository.mjs';
import { requireModule } from './module-access.mjs';
import { appendAuditEvent } from './audit.mjs';
import { findTemplate } from './checklists.mjs';

const COLUMNS = `id, site_id, kind, category, name, code, tool_id, template_code, active,
  notes, deleted_at, created_at, updated_at`;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail = (status, message, code) => { throw new RepositoryError(status, message, code); };
const invalid = message => fail(400, message, 'VALIDATION_ERROR');
const duplicate = () => fail(409, 'Asset name already exists in this site.', 'DUPLICATE_ASSET_NAME');

function requireUser(user) {
  if (!user?.id) fail(401, 'Authentication required.', 'UNAUTHENTICATED');
}

function object(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid('Expected a JSON object.');
}

function validId(value, field) {
  if (typeof value !== 'string' || !uuid.test(value)) invalid(`${field} must be a UUID.`);
  return value.toLowerCase();
}

function name(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 200) {
    invalid('name must contain between 1 and 200 characters.');
  }
  return value.trim();
}

function text(value, field, max) {
  if (value == null) return null;
  if (typeof value !== 'string' || value.length > max) invalid(`${field} must be a string of at most ${max} characters.`);
  return value.trim() || null;
}

function active(value) {
  if (typeof value !== 'boolean') invalid('active must be a boolean.');
  return value;
}

async function assetRole(db, siteId, user, roles = HSE_READ_ROLES) {
  await requireRole(db, siteId, user, roles);
  await requireModule(db, siteId, user, 'hse');
}

async function writableSite(tx, siteId, user) {
  await assetRole(tx, siteId, user, HSE_WRITE_ROLES);
  // Share the site lock with jurisdiction and membership changes.
  await tx.run('UPDATE sites SET id = id WHERE id = ?', siteId);
  await assetRole(tx, siteId, user, HSE_WRITE_ROLES);
}

export async function templateForSite(db, code, siteId) {
  const template = typeof code === 'string' ? findTemplate(code) : undefined;
  if (!template) invalid('Unknown templateCode.');
  const { jurisdiction } = await getSite(db, siteId);
  if (template.jurisdiction !== jurisdiction) {
    fail(400, 'Template jurisdiction must match the site.', 'TEMPLATE_JURISDICTION_MISMATCH');
  }
  return template;
}

function withTemplate(row) {
  const template = findTemplate(row.template_code);
  return { ...row, templateTitle: template?.title ?? null, jurisdiction: template?.jurisdiction ?? null,
    frequencyVerified: template?.frequency_verified ?? false };
}

async function findAsset(db, id) {
  const row = await db.get(`SELECT ${COLUMNS} FROM hse_assets WHERE id = ? AND deleted_at IS NULL`, id);
  if (!row) fail(404, 'HSE asset not found.', 'HSE_ASSET_NOT_FOUND');
  return row;
}

// PostgreSQL requires a savepoint before a unique violation can be recovered.
async function writeWithName(tx, siteId, assetName, write) {
  for (let attempt = 0; attempt < 2; attempt++) {
    await tx.exec('SAVEPOINT hse_asset_name');
    try {
      const row = await write();
      await tx.exec('RELEASE SAVEPOINT hse_asset_name');
      return row;
    } catch (error) {
      await tx.exec('ROLLBACK TO SAVEPOINT hse_asset_name');
      await tx.exec('RELEASE SAVEPOINT hse_asset_name');
      if (!tx.isUniqueViolation(error)) throw error;
      if (attempt) duplicate();
      const existing = await tx.get('SELECT id, deleted_at FROM hse_assets WHERE site_id = ? AND name = ?', siteId, assetName);
      if (!existing?.deleted_at) duplicate();
      try {
        await tx.run("UPDATE hse_assets SET name = name || ' (deleted ' || id || ')' WHERE id = ? AND deleted_at IS NOT NULL", existing.id);
      } catch (renameError) {
        if (tx.isUniqueViolation(renameError)) duplicate();
        throw renameError;
      }
    }
  }
}

export async function listHseAssets(db, { siteId } = {}, user) {
  requireUser(user);
  const site = validId(siteId, 'siteId');
  await assetRole(db, site, user);
  const rows = await db.all(`SELECT asset.*,
      CAST(inspection.performed_on AS TEXT) AS last_inspection_on,
      inspection.outcome AS last_outcome, CAST(inspection.next_due_on AS TEXT) AS next_due_on
    FROM (SELECT ${COLUMNS} FROM hse_assets WHERE site_id = ? AND deleted_at IS NULL) asset
    LEFT JOIN hse_inspections inspection ON inspection.id = (
      SELECT latest.id FROM hse_inspections latest
      WHERE latest.site_id = asset.site_id AND latest.asset_id = asset.id
      ORDER BY latest.performed_on DESC, latest.created_at DESC, latest.id DESC LIMIT 1
    ) ORDER BY asset.category, asset.name, asset.id`, site);
  // Local calendar arithmetic keeps the window independent of UTC and DST shifts.
  const calendarDate = date => `${String(date.getFullYear()).padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  const now = new Date(), today = calendarDate(now);
  now.setDate(now.getDate() + 30);
  const dueSoonThrough = calendarDate(now);
  return rows.map(({ last_inspection_on: lastInspectionOn, last_outcome: lastOutcome, next_due_on: nextDueOn, ...row }) => {
    const status = lastInspectionOn === null ? 'never'
      : lastOutcome === 'fail' ? 'failed'
        : nextDueOn !== null && nextDueOn < today ? 'overdue'
          : nextDueOn !== null && nextDueOn <= dueSoonThrough ? 'due_soon' : 'ok';
    return { ...withTemplate(row), lastInspectionOn, lastOutcome, nextDueOn, status };
  });
}

export async function getHseAsset(db, id, user) {
  requireUser(user);
  const row = await findAsset(db, validId(id, 'id'));
  await assetRole(db, row.site_id, user);
  return withTemplate(row);
}

export async function createHseAsset(db, input, user) {
  requireUser(user);
  object(input);
  const siteId = validId(input.siteId ?? input.site_id, 'siteId');
  const assetName = name(input.name);
  const code = text(input.code, 'code', 60);
  const notes = text(input.notes, 'notes', 2000);
  const toolId = input.toolId == null ? null : validId(input.toolId, 'toolId');
  const enabled = input.active === undefined ? true : active(input.active);
  return await db.transaction(async tx => {
    await writableSite(tx, siteId, user);
    const template = await templateForSite(tx, input.templateCode, siteId);
    if (toolId && !await tx.get('SELECT id FROM tools WHERE id = ? AND site_id = ? AND deleted_at IS NULL', toolId, siteId)) {
      invalid('toolId must reference a tool in the same site.');
    }
    const now = new Date().toISOString(), id = randomUUID();
    const row = await writeWithName(tx, siteId, assetName, () => tx.get(`INSERT INTO hse_assets
      (id, site_id, kind, category, name, code, tool_id, template_code, active, notes, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ${enabled ? 'TRUE' : 'FALSE'}, ?, ?, ?) RETURNING ${COLUMNS}`,
    id, siteId, template.kind, template.category, assetName, code, toolId, template.code, notes, now, now));
    await appendAuditEvent(tx, { entityType: 'hse_asset', action: 'create', after: row, actor: user.id, at: now });
    return row;
  });
}

export async function updateHseAsset(db, id, input, user) {
  requireUser(user);
  const assetId = validId(id, 'id');
  object(input);
  return await db.transaction(async tx => {
    const initial = await findAsset(tx, assetId);
    await writableSite(tx, initial.site_id, user);
    await tx.run('UPDATE hse_assets SET id = id WHERE id = ? AND deleted_at IS NULL', assetId);
    const before = await findAsset(tx, assetId);
    const changes = [], values = [];
    let assetName = before.name;
    for (const [field, validate] of [
      ['name', name], ['code', value => text(value, 'code', 60)],
      ['notes', value => text(value, 'notes', 2000)],
    ]) {
      if (!Object.hasOwn(input, field)) continue;
      const value = validate(input[field]);
      if (field === 'name') assetName = value;
      changes.push(`${field} = ?`); values.push(value);
    }
    if (Object.hasOwn(input, 'active')) changes.push(`active = ${active(input.active) ? 'TRUE' : 'FALSE'}`);
    if (Object.hasOwn(input, 'templateCode')) {
      const template = await templateForSite(tx, input.templateCode, before.site_id);
      changes.push('template_code = ?', 'kind = ?', 'category = ?');
      values.push(template.code, template.kind, template.category);
    }
    let after = before;
    if (changes.length) {
      changes.push('updated_at = ?');
      values.push(new Date().toISOString(), assetId);
      after = await writeWithName(tx, before.site_id, assetName, () => tx.get(
        `UPDATE hse_assets SET ${changes.join(', ')} WHERE id = ? RETURNING ${COLUMNS}`, ...values));
    }
    await appendAuditEvent(tx, { entityType: 'hse_asset', action: 'update', before, after, actor: user.id });
    return after;
  });
}

export async function deleteHseAsset(db, id, user) {
  requireUser(user);
  const assetId = validId(id, 'id');
  return await db.transaction(async tx => {
    const initial = await findAsset(tx, assetId);
    await writableSite(tx, initial.site_id, user);
    await tx.run('UPDATE hse_assets SET id = id WHERE id = ? AND deleted_at IS NULL', assetId);
    const before = await findAsset(tx, assetId);
    const now = new Date().toISOString();
    const row = await tx.get(`UPDATE hse_assets SET deleted_at = ?, updated_at = ? WHERE id = ? RETURNING ${COLUMNS}`,
      now, now, assetId);
    await appendAuditEvent(tx, { entityType: 'hse_asset', action: 'delete', before, actor: user.id, at: now });
    return row;
  });
}
