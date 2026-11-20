import { randomUUID } from 'node:crypto';
import { RepositoryError, requireRole } from './repository.mjs';
import { requireModule } from './module-access.mjs';
import { appendAuditEvent } from './audit.mjs';

const WRITE_ROLES = ['owner', 'editor'];
const STATUSES = ['planned', 'in_transit', 'arrived', 'received'];
const COLUMNS = `id, site_id, shipment_no, carrier, CAST(shipped_on AS TEXT) AS shipped_on,
  CAST(expected_on AS TEXT) AS expected_on, CAST(arrived_on AS TEXT) AS arrived_on,
  status, notes, created_at, updated_at`;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail = (status, message, code) => { throw new RepositoryError(status, message, code); };
const invalid = message => fail(400, message, 'VALIDATION_ERROR');

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

function text(value, field, max = 10000, required = false) {
  if (value == null && !required) return null;
  if (typeof value !== 'string') invalid(`${field} must be a string.`);
  const result = value.trim();
  if ((required && !result) || result.length > max) invalid(`Invalid ${field} length.`);
  return result || null;
}

function date(value, field) {
  if (value == null) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\d$/.test(value) || value.startsWith('0000')) {
    invalid(`${field} must be a valid YYYY-MM-DD date.`);
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) invalid(`Invalid ${field} date.`);
  return value;
}

function quantity(value) {
  if (!['number', 'string'].includes(typeof value) || !/^\d+(?:\.\d{1,3})?$/.test(String(value)) ||
      !Number.isFinite(Number(value)) || Number(value) < 0 || Number(value) > 999999999.999) {
    invalid('quantityReceived must be nonnegative, at most 999999999.999, with at most three decimal places.');
  }
  return value;
}

async function access(db, siteId, user, roles) {
  await requireRole(db, siteId, user, roles);
  await requireModule(db, siteId, user, 'logistics');
}

async function lockSite(tx, siteId, user) {
  await access(tx, siteId, user, WRITE_ROLES);
  await tx.run('UPDATE sites SET id = id WHERE id = ?', siteId);
  await access(tx, siteId, user, WRITE_ROLES);
}

async function findShipment(db, id) {
  const row = typeof id === 'string' && uuid.test(id)
    ? await db.get(`SELECT ${COLUMNS} FROM shipments WHERE id = ?`, id.toLowerCase()) : null;
  if (!row) fail(404, 'Shipment not found.', 'SHIPMENT_NOT_FOUND');
  return row;
}

async function lockShipment(tx, id, user) {
  const initial = await findShipment(tx, id);
  await lockSite(tx, initial.site_id, user);
  return await findShipment(tx, initial.id);
}

async function detail(db, row) {
  const packages = await db.all(`SELECT p.* FROM packages p JOIN shipment_packages sp ON sp.package_id = p.id
    WHERE sp.shipment_id = ? ORDER BY p.created_at, p.id`, row.id);
  const receipts = await db.all('SELECT * FROM shipment_receipts WHERE shipment_id = ? ORDER BY created_at, id', row.id);
  return { ...row, packages, receipts };
}

export async function createShipment(db, input, user) {
  requireUser(user);
  object(input);
  const siteId = validId(input.siteId, 'siteId');
  const shipmentNo = text(input.shipmentNo, 'shipmentNo', 80, true), carrier = text(input.carrier, 'carrier', 200);
  const shippedOn = date(input.shippedOn, 'shippedOn'), expectedOn = date(input.expectedOn, 'expectedOn');
  const notes = text(input.notes, 'notes');
  if (!Array.isArray(input.packageIds) || !input.packageIds.length) invalid('At least one package is required.');
  const ids = input.packageIds.map(id => validId(id, 'packageId'));
  if (new Set(ids).size !== ids.length) invalid('Each package must occur once.');
  try {
    return await db.transaction(async tx => {
      await lockSite(tx, siteId, user);
      for (const id of ids) {
        const row = await tx.get('SELECT site_id FROM packages WHERE id = ?', id);
        if (!row) fail(404, 'Shipment package not found.', 'SHIPMENT_PACKAGE_NOT_FOUND');
        if (row.site_id !== siteId) fail(400, 'All packages must belong to the shipment site.', 'SHIPMENT_PACKAGE_SITE_MISMATCH');
        if (await tx.get('SELECT shipment_id FROM shipment_packages WHERE package_id = ?', id)) {
          fail(409, 'Package already belongs to a shipment.', 'SHIPMENT_PACKAGE_TAKEN');
        }
      }
      const now = new Date().toISOString();
      const row = await tx.get(`INSERT INTO shipments
        (id, site_id, shipment_no, carrier, shipped_on, expected_on, status, notes, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'planned', ?, ?, ?) RETURNING ${COLUMNS}`,
      randomUUID(), siteId, shipmentNo, carrier, shippedOn, expectedOn, notes, now, now);
      for (const id of ids) await tx.run('INSERT INTO shipment_packages (shipment_id, package_id) VALUES (?, ?)', row.id, id);
      await appendAuditEvent(tx, { entityType: 'shipment', action: 'create', after: row, actor: user.id, at: now });
      return await detail(tx, row);
    });
  } catch (error) {
    if (db.isUniqueViolation(error)) fail(409, 'Shipment number already exists in this site.', 'SHIPMENT_DUPLICATE_NUMBER');
    throw error;
  }
}

export async function listShipments(db, { siteId, status } = {}, user) {
  requireUser(user);
  const site = validId(siteId, 'siteId');
  await access(db, site, user);
  if (status != null && !STATUSES.includes(status)) invalid('Unknown shipment status.');
  return await db.all(`SELECT ${COLUMNS} FROM shipments WHERE site_id = ?${status == null ? '' : ' AND status = ?'}
    ORDER BY created_at, id`, site, ...(status == null ? [] : [status]));
}

export async function getShipment(db, id, user) {
  requireUser(user);
  const row = await findShipment(db, id);
  await access(db, row.site_id, user);
  return await detail(db, row);
}

export async function transitionShipment(db, id, input, user) {
  requireUser(user);
  object(input);
  return await db.transaction(async tx => {
    const row = await lockShipment(tx, id, user), status = input.status;
    if (!STATUSES.includes(status)) invalid('Unknown shipment status.');
    const note = text(input.note, 'note');
    if (STATUSES.indexOf(status) !== STATUSES.indexOf(row.status) + 1 ||
        (status === 'received' && !await tx.get('SELECT id FROM shipment_receipts WHERE shipment_id = ? LIMIT 1', row.id))) {
      fail(409, 'Shipment transition is not allowed or requires a receipt.', 'SHIPMENT_STATUS_CONFLICT');
    }
    const now = new Date().toISOString();
    const after = await tx.get(`UPDATE shipments SET status = ?, arrived_on = ?, updated_at = ?
      WHERE id = ? RETURNING ${COLUMNS}`, status, status === 'arrived' ? now.slice(0, 10) : row.arrived_on, now, row.id);
    await appendAuditEvent(tx, { entityType: 'shipment', action: 'update', before: row, after, actor: user.id, at: now, note });
    return await detail(tx, after);
  });
}

export async function addShipmentReceipt(db, id, input, user) {
  requireUser(user);
  object(input);
  const itemId = validId(input.purchaseOrderItemId, 'purchaseOrderItemId');
  const amount = quantity(input.quantityReceived), note = text(input.note, 'note');
  return await db.transaction(async tx => {
    const shipment = await lockShipment(tx, id, user);
    if (shipment.status === 'received') fail(409, 'Shipment is already received.', 'SHIPMENT_STATUS_CONFLICT');
    const item = await tx.get(`SELECT i.id FROM purchase_order_items i JOIN purchase_orders o ON o.id = i.purchase_order_id
      WHERE i.id = ? AND o.site_id = ? AND EXISTS (
        SELECT 1 FROM shipment_packages sp JOIN packages p ON p.id = sp.package_id
        WHERE sp.shipment_id = ? AND p.purchase_order_id = o.id AND p.site_id = o.site_id
          AND EXISTS (SELECT 1 FROM package_items pi WHERE pi.package_id = p.id AND pi.purchase_order_item_id = i.id)
      )`, itemId, shipment.site_id, shipment.id);
    if (!item) fail(404, 'Item not found in the shipment orders.', 'SHIPMENT_ITEM_NOT_FOUND');
    const now = new Date().toISOString();
    const row = await tx.get(`INSERT INTO shipment_receipts
      (id, shipment_id, purchase_order_item_id, quantity_received, note, created_at)
      VALUES (?, ?, ?, ?, ?, ?) RETURNING *`, randomUUID(), shipment.id, item.id, amount, note, now);
    await appendAuditEvent(tx, { entityType: 'shipment_receipt', action: 'create',
      after: { ...row, site_id: shipment.site_id }, actor: user.id, at: now });
    return row;
  });
}
