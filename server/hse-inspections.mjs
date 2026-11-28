import { HSE_READ_ROLES, HSE_WRITE_ROLES } from '../app/hse-permissions.mjs';
import { inspectionSuggestion } from '../app/domain.mjs';
import { randomUUID } from 'node:crypto';
import { RepositoryError, requireRole } from './repository.mjs';
import { requireModule } from './module-access.mjs';
import { appendAuditEvent } from './audit.mjs';
import { templateForSite } from './hse-assets.mjs';

const COLUMNS = `id, site_id, asset_id, CAST(performed_on AS TEXT) AS performed_on,
  performed_by, performer_role, mode, outcome, notes, CAST(next_due_on AS TEXT) AS next_due_on,
  hse_event_id, created_at, updated_at, computed_outcome, declared_outcome, outcome_source, template_status`;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail = (status, message, code) => { throw new RepositoryError(status, message, code); };
const invalid = message => fail(400, message, 'VALIDATION_ERROR');

function requireUser(user) {
  if (!user?.id) fail(401, 'Authentication required.', 'UNAUTHENTICATED');
}

function validId(value, field) {
  if (typeof value !== 'string' || !uuid.test(value)) invalid(`${field} must be a UUID.`);
  return value.toLowerCase();
}

function text(value, field) {
  if (value == null) return null;
  if (typeof value !== 'string') invalid(`${field} must be a string.`);
  return value.trim() || null;
}

function choice(value, values, field) {
  if (!values.includes(value)) invalid(`Invalid ${field}.`);
  return value;
}

function date(value, field) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\d$/.test(value) || value.startsWith('0000')) {
    invalid(`${field} must be a valid YYYY-MM-DD date.`);
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    invalid(`${field} must be a valid YYYY-MM-DD date.`);
  }
  return value;
}

function addMonths(value, months) {
  const parsed = new Date(`${value}T00:00:00Z`);
  const day = parsed.getUTCDate();
  parsed.setUTCDate(1);
  parsed.setUTCMonth(parsed.getUTCMonth() + months);
  const lastDay = new Date(parsed);
  lastDay.setUTCMonth(lastDay.getUTCMonth() + 1, 0);
  parsed.setUTCDate(Math.min(day, lastDay.getUTCDate()));
  return date(parsed.toISOString().slice(0, 10), 'nextDueOn');
}

async function inspectionRole(db, siteId, user, roles = HSE_READ_ROLES) {
  await requireRole(db, siteId, user, roles);
  await requireModule(db, siteId, user, 'hse');
}

async function findAsset(db, siteId, assetId) {
  const asset = await db.get(`SELECT id, name, code, template_code FROM hse_assets
    WHERE id = ? AND site_id = ? AND deleted_at IS NULL`, assetId, siteId);
  if (!asset) fail(404, 'Asset not found.', 'ASSET_NOT_FOUND');
  return asset;
}

function snapshotItems(input, template) {
  if (!Array.isArray(input)) fail(400, 'Every template item is required exactly once.', 'INSPECTION_ITEMS_INCOMPLETE');
  const codes = new Set(template.items.map(item => item.code));
  const submitted = new Map();
  for (const item of input) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) invalid('Invalid inspection item.');
    if (!codes.has(item.code)) fail(400, 'Unknown inspection item code.', 'INSPECTION_ITEMS_UNKNOWN');
    if (submitted.has(item.code)) fail(400, 'Every template item is required exactly once.', 'INSPECTION_ITEMS_INCOMPLETE');
    submitted.set(item.code, {
      result: item.result == null || item.result === '' ? null : choice(item.result, ['ok', 'not_ok', 'na'], 'result'),
      note: text(item.note, 'note'),
    });
  }
  if (submitted.size !== codes.size) fail(400, 'Every template item is required exactly once.', 'INSPECTION_ITEMS_INCOMPLETE');
  return template.items.map((item, position) => ({
    code: item.code, label: item.label, critical: item.critical, ...submitted.get(item.code), position,
  }));
}

function withFrequencyVerification(row) {
  // A stored due date has no record of a verified frequency.
  return { ...row, frequency_verified: false };
}

export async function createInspection(db, input, user) {
  requireUser(user);
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid('Expected a JSON object.');
  const siteId = validId(input.siteId, 'siteId');
  const assetId = validId(input.assetId, 'assetId');
  const performedOn = date(input.performedOn, 'performedOn');
  const performedBy = text(input.performedBy, 'performedBy');
  if (!performedBy || performedBy.length > 200) invalid('performedBy must contain between 1 and 200 characters.');
  const performerRole = text(input.performerRole, 'performerRole');
  const mode = choice(input.mode, ['internal', 'external'], 'mode');
  const declaredOutcome = choice(input.outcome, ['pass', 'pass_with_notes', 'fail'], 'outcome');
  const notes = text(input.notes, 'notes');
  // nextOn is accepted as an alias for nextDueOn; explicit null is not omission.
  if (Object.hasOwn(input, 'nextDueOn') && Object.hasOwn(input, 'nextOn') && input.nextDueOn !== input.nextOn) {
    invalid('Conflicting nextDueOn and nextOn values.');
  }
  const suppliedDue = Object.hasOwn(input, 'nextDueOn') || Object.hasOwn(input, 'nextOn');
  const due = suppliedDue ? date(Object.hasOwn(input, 'nextDueOn') ? input.nextDueOn : input.nextOn, 'nextDueOn') : null;
  return await db.transaction(async tx => {
    await inspectionRole(tx, siteId, user, HSE_WRITE_ROLES);
    // Use the same lock order as asset edits and membership/module changes.
    await tx.run('UPDATE sites SET id = id WHERE id = ?', siteId);
    await inspectionRole(tx, siteId, user, HSE_WRITE_ROLES);
    await tx.run('UPDATE hse_assets SET id = id WHERE id = ? AND site_id = ? AND deleted_at IS NULL', assetId, siteId);
    const asset = await findAsset(tx, siteId, assetId);
    const template = await templateForSite(tx, asset.template_code, siteId);
    const items = snapshotItems(input.items, template);
    const { outcome: computedOutcome, reasons } = inspectionSuggestion(items);
    if (reasons.some(reason => reason.code === 'INSPECTION_ITEMS_INCOMPLETE')) {
      fail(400, 'Every template item must have a result.', 'INSPECTION_ITEMS_INCOMPLETE');
    }
    if (reasons.some(reason => reason.code === 'INSPECTION_NA_NOTE_REQUIRED')) {
      fail(400, 'Every not-applicable item requires a note.', 'INSPECTION_NA_NOTE_REQUIRED');
    }
    if (declaredOutcome !== computedOutcome) {
      fail(400, 'The declared outcome contradicts the checklist outcome.', 'OUTCOME_CONTRADICTS_ITEMS');
    }
    const nextDueOn = suppliedDue ? due : addMonths(performedOn, template.intervalMonths);
    const id = randomUUID(), now = new Date().toISOString();
    const row = await tx.get(`INSERT INTO hse_inspections
      (id, site_id, asset_id, performed_on, performed_by, performer_role, mode, outcome, notes, next_due_on,
        created_at, updated_at, computed_outcome, declared_outcome, outcome_source, template_status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'computed', ?) RETURNING ${COLUMNS}`,
    id, siteId, assetId, performedOn, performedBy, performerRole, mode, computedOutcome, notes, nextDueOn,
    now, now, computedOutcome, declaredOutcome, template.status);
    const storedItems = [];
    for (const item of items) {
      storedItems.push(await tx.get(`INSERT INTO hse_inspection_items
        (id, inspection_id, item_code, label, result, note, position) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`,
      randomUUID(), id, item.code, item.label, item.result, item.note, item.position));
    }
    await appendAuditEvent(tx, { entityType: 'hse_inspection', action: 'create', after: row, actor: user.id, at: now });
    return { ...withFrequencyVerification(row), items: storedItems, asset };
  });
}

export async function listInspections(db, { siteId, assetId } = {}, user) {
  requireUser(user);
  const site = validId(siteId, 'siteId');
  await inspectionRole(db, site, user);
  const values = [site];
  let filter = '';
  if (assetId != null) {
    const asset = validId(assetId, 'assetId');
    await findAsset(db, site, asset);
    filter = ' AND asset_id = ?';
    values.push(asset);
  }
  const rows = await db.all(`SELECT ${COLUMNS} FROM hse_inspections WHERE site_id = ?${filter}
    ORDER BY performed_on DESC, created_at DESC, id DESC`, ...values);
  return rows.map(withFrequencyVerification);
}

export async function getInspection(db, id, user) {
  requireUser(user);
  const row = await db.get(`SELECT ${COLUMNS} FROM hse_inspections WHERE id = ?`, validId(id, 'id'));
  if (!row) fail(404, 'Inspection not found.', 'INSPECTION_NOT_FOUND');
  await inspectionRole(db, row.site_id, user);
  // Historical inspections remain readable after an asset is soft-deleted.
  const asset = await db.get('SELECT id, name, code, template_code FROM hse_assets WHERE id = ?', row.asset_id);
  const items = await db.all('SELECT * FROM hse_inspection_items WHERE inspection_id = ? ORDER BY position', row.id);
  return { ...withFrequencyVerification(row), items, asset };
}
