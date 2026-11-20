import { randomUUID } from 'node:crypto';
import { RepositoryError, requireRole } from './repository.mjs';
import { requireModule } from './module-access.mjs';
import { appendAuditEvent } from './audit.mjs';
import { recomputePurchaseOrder } from './purchase-orders.mjs';

const WRITE_ROLES = ['owner', 'editor'];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail = (status, message, code) => { throw new RepositoryError(status, message, code); };
const invalid = message => fail(400, message, 'VALIDATION_ERROR');
const ITEM_COLUMNS = `id, purchase_order_id, line_no, material_no, description, unit, quantity, wbs_id,
  status, CAST(execution_started_on AS TEXT) AS execution_started_on,
  CAST(completed_on AS TEXT) AS completed_on, CAST(not_relevant_on AS TEXT) AS not_relevant_on,
  created_at, updated_at`;

function requireUser(user) {
  if (!user?.id) fail(401, 'Authentication required.', 'UNAUTHENTICATED');
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

function quantity(value) {
  if (!['number', 'string'].includes(typeof value) || !/^\d+(?:\.\d{1,3})?$/.test(String(value)) ||
      !Number.isFinite(Number(value)) || Number(value) <= 0 || Number(value) > 999999999.999) {
    invalid('quantityPacked must be positive, at most 999999999.999, with at most three decimal places.');
  }
  return value;
}

// Sum integer thousandths: SQLite SUM on NUMERIC values can introduce rounding error.
const thousandths = value => BigInt(Math.round(Number(value) * 1000));

async function access(db, siteId, user, roles) {
  await requireRole(db, siteId, user, roles);
  await requireModule(db, siteId, user, 'logistics');
}

async function lockSite(tx, siteId, user) {
  await access(tx, siteId, user, WRITE_ROLES);
  await tx.run('UPDATE sites SET id = id WHERE id = ?', siteId);
  await access(tx, siteId, user, WRITE_ROLES);
}

async function findPackage(db, id) {
  const row = typeof id === 'string' && uuid.test(id)
    ? await db.get('SELECT * FROM packages WHERE id = ?', id.toLowerCase()) : null;
  if (!row) fail(404, 'Package not found.', 'PACKAGE_NOT_FOUND');
  return row;
}

async function detail(db, row) {
  return { ...row, items: await db.all('SELECT * FROM package_items WHERE package_id = ? ORDER BY created_at, id', row.id) };
}

async function audit(tx, entityType, action, before, after, siteId, user, now) {
  await appendAuditEvent(tx, { entityType, action, before: before && { ...before, site_id: siteId },
    after: { ...after, site_id: siteId }, actor: user.id, at: now });
}

export async function createPackage(db, input, user) {
  requireUser(user);
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid('Expected a JSON object.');
  const siteId = validId(input.siteId, 'siteId'), orderId = validId(input.purchaseOrderId, 'purchaseOrderId');
  const suppliedNumber = input.packageNo === undefined ? null : text(input.packageNo, 'packageNo', 80, true);
  const notes = text(input.notes, 'notes');
  if (!Array.isArray(input.items) || !input.items.length) invalid('At least one package item is required.');
  const seen = new Set();
  const lines = input.items.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) invalid('Invalid package item.');
    const id = validId(item.purchaseOrderItemId, 'purchaseOrderItemId');
    if (seen.has(id)) invalid('Each purchase order item must occur once.');
    seen.add(id);
    return { id, amount: quantity(item.quantityPacked) };
  });
  try {
    return await db.transaction(async tx => {
      await lockSite(tx, siteId, user);
      const order = await tx.get(`SELECT id, site_id, po_no, supplier_name, CAST(ordered_on AS TEXT) AS ordered_on,
        status, notes, closed_at, created_at, updated_at FROM purchase_orders WHERE id = ? AND site_id = ?`, orderId, siteId);
      if (!order) fail(404, 'Purchase order not found.', 'PO_NOT_FOUND');
      let packageNo = suppliedNumber;
      if (packageNo == null) {
        const numbers = await tx.all('SELECT package_no FROM packages WHERE purchase_order_id = ?', orderId);
        const max = numbers.reduce((value, row) => /^PKG-\d+$/.test(row.package_no)
          ? (BigInt(row.package_no.slice(4)) > value ? BigInt(row.package_no.slice(4)) : value) : value, 0n);
        packageNo = `PKG-${String(max + 1n).padStart(3, '0')}`;
      }
      if (await tx.get('SELECT id FROM packages WHERE purchase_order_id = ? AND package_no = ?', orderId, packageNo)) {
        fail(409, 'Package number already exists in this order.', 'PACKAGE_DUPLICATE_NUMBER');
      }
      const now = new Date().toISOString();
      const row = await tx.get(`INSERT INTO packages
        (id, site_id, purchase_order_id, package_no, status, notes, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'open', ?, ?, ?) RETURNING *`, randomUUID(), siteId, orderId, packageNo, notes, now, now);
      await audit(tx, 'package', 'create', null, row, siteId, user, now);
      for (const line of lines) {
        const item = await tx.get(`SELECT ${ITEM_COLUMNS} FROM purchase_order_items WHERE id = ? AND purchase_order_id = ?`, line.id, orderId);
        if (!item) fail(404, 'Package item not found in this order and site.', 'PACKAGE_ITEM_NOT_FOUND');
        const packed = await tx.all('SELECT quantity_packed FROM package_items WHERE purchase_order_item_id = ?', item.id);
        const total = packed.reduce((sum, part) => sum + thousandths(part.quantity_packed), thousandths(line.amount));
        if (total > thousandths(item.quantity)) fail(400, 'Packed quantity exceeds ordered quantity.', 'PACKAGE_QUANTITY_EXCEEDED');
        const stored = await tx.get(`INSERT INTO package_items
          (id, package_id, purchase_order_item_id, quantity_packed, unit, material_no, description, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`, randomUUID(), row.id, item.id, line.amount,
        item.unit, item.material_no, item.description, now);
        await audit(tx, 'package_item', 'create', null, stored, siteId, user, now);
        // Existing execution dates and final item states remain authoritative.
        if (!packed.length && item.status === 'open') {
          const after = await tx.get(`UPDATE purchase_order_items SET status = 'in_execution',
            execution_started_on = ?, updated_at = ? WHERE id = ? RETURNING ${ITEM_COLUMNS}`,
          now.slice(0, 10), now, item.id);
          await audit(tx, 'purchase_order_item', 'update', item, after, siteId, user, now);
        }
      }
      await recomputePurchaseOrder(tx, order, user, now);
      return await detail(tx, row);
    });
  } catch (error) {
    if (db.isUniqueViolation(error)) fail(409, 'Package number already exists in this order.', 'PACKAGE_DUPLICATE_NUMBER');
    throw error;
  }
}

export async function listPackages(db, { siteId, purchaseOrderId } = {}, user) {
  requireUser(user);
  const site = validId(siteId, 'siteId');
  await access(db, site, user);
  const order = purchaseOrderId == null ? null : validId(purchaseOrderId, 'purchaseOrderId');
  return await db.all(`SELECT * FROM packages WHERE site_id = ?${order == null ? '' : ' AND purchase_order_id = ?'}
    ORDER BY created_at, id`, site, ...(order == null ? [] : [order]));
}

export async function getPackage(db, id, user) {
  requireUser(user);
  const row = await findPackage(db, id);
  await access(db, row.site_id, user);
  return await detail(db, row);
}

export async function closePackage(db, id, user) {
  requireUser(user);
  return await db.transaction(async tx => {
    const initial = await findPackage(tx, id);
    await lockSite(tx, initial.site_id, user);
    const row = await findPackage(tx, initial.id);
    if (row.status !== 'open') fail(409, 'Package is already closed.', 'PACKAGE_STATUS_CONFLICT');
    const now = new Date().toISOString();
    const after = await tx.get(`UPDATE packages SET status = 'closed', closed_at = ?, updated_at = ?
      WHERE id = ? RETURNING *`, now, now, row.id);
    await audit(tx, 'package', 'update', row, after, row.site_id, user, now);
    return await detail(tx, after);
  });
}
