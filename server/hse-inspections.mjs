import { HSE_READ_ROLES, HSE_WRITE_ROLES } from '../app/hse-permissions.mjs';
import { randomUUID } from 'node:crypto';
import { RepositoryError, requireRole } from './repository.mjs';
import { requireModule } from './module-access.mjs';
import { appendAuditEvent } from './audit.mjs';
import { findTemplate } from './checklists.mjs';

const COLUMNS = `id, site_id, asset_id, CAST(performed_on AS TEXT) AS performed_on,
  performed_by, performer_role, mode, outcome, notes, CAST(next_due_on AS TEXT) AS next_due_on,
  hse_event_id, created_at, updated_at`;
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
      result: choice(item.result, ['ok', 'not_ok', 'na'], 'result'),
      note: text(item.note, 'note'),
    });
  }
  if (submitted.size !== codes.size) fail(400, 'Every template item is required exactly once.', 'INSPECTION_ITEMS_INCOMPLETE');
  return template.items.map((item, position) => ({
    item_code: item.code, label: item.label, ...submitted.get(item.code), position,
  }));
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
  const outcome = choice(input.outcome, ['pass', 'pass_with_notes', 'fail'], 'outcome');
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
    const template = findTemplate(asset.template_code);
    if (!template) invalid('Unknown asset template.');
    const items = snapshotItems(input.items, template);
    const nextDueOn = suppliedDue ? due : addMonths(performedOn, template.intervalMonths);
    const id = randomUUID(), now = new Date().toISOString();
    // Like manually created HSE events, an omitted event number stays null.
    const event = await tx.get(`INSERT INTO hse_events
      (id, site_id, event_no, type, severity, occurred_on, location, persons_involved,
        measures, notes, deviation_id, created_at, updated_at)
      VALUES (?, ?, NULL, ?, ?, ?, ?, NULL, NULL, ?, NULL, ?, ?)
      RETURNING id, site_id, event_no, type, severity, CAST(occurred_on AS TEXT) AS occurred_on,
        location, persons_involved, measures, notes, deviation_id, created_at, updated_at`,
    randomUUID(), siteId, mode === 'internal' ? 'inspection' : 'external_visit',
    { fail: 'high', pass_with_notes: 'medium', pass: 'low' }[outcome], performedOn,
    asset.code || asset.name, `${asset.name} — ${template.title}`, now, now);
    await appendAuditEvent(tx, { entityType: 'hse_event', action: 'create', after: event, actor: user.id, at: now });
    const row = await tx.get(`INSERT INTO hse_inspections
      (id, site_id, asset_id, performed_on, performed_by, performer_role, mode, outcome, notes, next_due_on, hse_event_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING ${COLUMNS}`,
    id, siteId, assetId, performedOn, performedBy, performerRole, mode, outcome, notes, nextDueOn, event.id, now, now);
    const storedItems = [];
    for (const item of items) {
      storedItems.push(await tx.get(`INSERT INTO hse_inspection_items
        (id, inspection_id, item_code, label, result, note, position) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`,
      randomUUID(), id, item.item_code, item.label, item.result, item.note, item.position));
    }
    await appendAuditEvent(tx, { entityType: 'hse_inspection', action: 'create', after: row, actor: user.id, at: now });
    return { ...row, items: storedItems, asset };
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
  return await db.all(`SELECT ${COLUMNS} FROM hse_inspections WHERE site_id = ?${filter}
    ORDER BY performed_on DESC, created_at DESC, id DESC`, ...values);
}

export async function getInspection(db, id, user) {
  requireUser(user);
  const row = await db.get(`SELECT ${COLUMNS} FROM hse_inspections WHERE id = ?`, validId(id, 'id'));
  if (!row) fail(404, 'Inspection not found.', 'INSPECTION_NOT_FOUND');
  await inspectionRole(db, row.site_id, user);
  // Historical inspections remain readable after an asset is soft-deleted.
  const asset = await db.get('SELECT id, name, code, template_code FROM hse_assets WHERE id = ?', row.asset_id);
  const items = await db.all('SELECT * FROM hse_inspection_items WHERE inspection_id = ? ORDER BY position', row.id);
  return { ...row, items, asset };
}
