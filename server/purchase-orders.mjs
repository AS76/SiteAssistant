import { randomUUID } from 'node:crypto';
import { EDIT_ROLES, RepositoryError, requireRole } from './repository.mjs';
import { requireModule } from './module-access.mjs';
import { appendAuditEvent } from './audit.mjs';

const STATUSES = ['open', 'template_generated', 'in_execution', 'completed', 'not_relevant'];
const FINAL = ['completed', 'not_relevant'];
const ORDER_COLUMNS = `id, site_id, po_no, supplier_name, CAST(ordered_on AS TEXT) AS ordered_on,
  status, notes, closed_at, created_at, updated_at`;
const ITEM_COLUMNS = `id, purchase_order_id, line_no, material_no, description, unit, quantity, wbs_id,
  status, CAST(execution_started_on AS TEXT) AS execution_started_on,
  CAST(completed_on AS TEXT) AS completed_on, CAST(not_relevant_on AS TEXT) AS not_relevant_on,
  created_at, updated_at`;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail = (status, message, code) => { throw new RepositoryError(status, message, code); };
const invalid = message => fail(400, message, 'VALIDATION_ERROR');
const conflict = () => fail(409, 'Purchase order transition is not allowed.', 'PO_STATUS_CONFLICT');

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
  if ((required && !result) || result.length > max) invalid(`${field} must contain ${required ? '1' : '0'} to ${max} characters.`);
  return result || null;
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

function quantity(value) {
  // Reject extra precision instead of silently rounding differently across drivers.
  if (!['number', 'string'].includes(typeof value) || !/^\d+(?:\.\d{1,3})?$/.test(String(value)) ||
      !Number.isFinite(Number(value)) || Number(value) <= 0 || Number(value) > 999999999.999) {
    invalid('quantity must be positive, at most 999999999.999, with at most three decimal places.');
  }
  return value;
}

function lineNo(value) {
  if (!Number.isInteger(value) || value < 1 || value > 2147483647) invalid('lineNo must be a positive 32-bit integer.');
  return value;
}

async function access(db, siteId, user, roles) {
  await requireRole(db, siteId, user, roles);
  await requireModule(db, siteId, user, 'logistics');
}

async function findOrder(db, id) {
  const row = typeof id === 'string' && uuid.test(id)
    ? await db.get(`SELECT ${ORDER_COLUMNS} FROM purchase_orders WHERE id = ?`, id.toLowerCase()) : null;
  if (!row) fail(404, 'Purchase order not found.', 'PO_NOT_FOUND');
  return row;
}

async function findItem(db, id) {
  const row = typeof id === 'string' && uuid.test(id)
    ? await db.get(`SELECT ${ITEM_COLUMNS} FROM purchase_order_items WHERE id = ?`, id.toLowerCase()) : null;
  if (!row) fail(404, 'Purchase order item not found.', 'PO_ITEM_NOT_FOUND');
  return row;
}

async function items(db, poId) {
  return await db.all(`SELECT ${ITEM_COLUMNS} FROM purchase_order_items WHERE purchase_order_id = ? ORDER BY line_no`, poId);
}

async function lockSite(tx, siteId, user) {
  await access(tx, siteId, user, EDIT_ROLES);
  // Site first, as in the other domain writers. Recheck authorization after waiting.
  await tx.run('UPDATE sites SET id = id WHERE id = ?', siteId);
  await access(tx, siteId, user, EDIT_ROLES);
}

async function lockOrder(tx, id, user) {
  const row = await findOrder(tx, id);
  await lockSite(tx, row.site_id, user);
  return await findOrder(tx, row.id);
}

async function audit(tx, entityType, action, before, after, siteId, user, now, note) {
  // Items inherit their audit scope from the immutable parent, without adding a stored site_id.
  await appendAuditEvent(tx, { entityType, action,
    before: before && { ...before, site_id: siteId }, after: { ...after, site_id: siteId }, actor: user.id, at: now, note });
}

async function uniqueWrite(db, operation, code, message) {
  try { return await operation(); }
  catch (error) {
    if (db.isUniqueViolation(error)) fail(409, message, code);
    throw error;
  }
}

async function validateWbs(tx, wbsId, siteId) {
  if (wbsId == null) return null;
  const id = validId(wbsId, 'wbsId');
  if (!await tx.get('SELECT id FROM project_structure WHERE id = ? AND site_id = ?', id, siteId)) {
    invalid('wbsId must belong to the purchase order site.');
  }
  return id;
}

export async function recomputePurchaseOrder(tx, order, user, now) {
  // Callers hold the site write lock and pass the header read in the same transaction.
  // Only explicit header closure sets closed_at; derived final states may change when items are added.
  if (order.closed_at != null) return;
  const rows = await items(tx, order.id);
  let status;
  if (rows.some(row => row.status === 'in_execution')) status = 'in_execution';
  else if (rows.length && rows.every(row => row.status === 'not_relevant')) status = 'not_relevant';
  else if (rows.length && rows.every(row => FINAL.includes(row.status))) status = 'completed';
  else {
    const history = await tx.all(`SELECT changes FROM audit_events
      WHERE entity_type = 'purchase_order' AND entity_id = ?`, order.id);
    const generated = order.status === 'template_generated' || history.some(event => JSON.parse(event.changes).status?.to === 'template_generated');
    status = generated ? 'template_generated' : 'open';
  }
  if (status === order.status) return;
  const after = await tx.get(`UPDATE purchase_orders SET status = ?, updated_at = ? WHERE id = ? RETURNING ${ORDER_COLUMNS}`,
    status, now, order.id);
  await audit(tx, 'purchase_order', 'update', order, after, order.site_id, user, now);
}

export async function listPurchaseOrders(db, { siteId, status } = {}, user) {
  requireUser(user);
  const site = validId(siteId, 'siteId');
  await access(db, site, user);
  if (status != null && !STATUSES.includes(status)) invalid('Unknown purchase order status.');
  return await db.all(`SELECT ${ORDER_COLUMNS} FROM purchase_orders WHERE site_id = ?${status == null ? '' : ' AND status = ?'}
    ORDER BY created_at, id`, site, ...(status == null ? [] : [status]));
}

export async function getPurchaseOrder(db, id, user) {
  requireUser(user);
  const row = await findOrder(db, id);
  await access(db, row.site_id, user);
  return { ...row, items: await items(db, row.id) };
}

export async function createPurchaseOrder(db, input, user) {
  requireUser(user);
  object(input);
  const site = validId(input.siteId, 'siteId');
  const poNo = text(input.poNo, 'poNo', 80, true);
  const supplierName = text(input.supplierName, 'supplierName', 200, true);
  const orderedOn = date(input.orderedOn, 'orderedOn'), notes = text(input.notes, 'notes');
  return await uniqueWrite(db, () => db.transaction(async tx => {
    await lockSite(tx, site, user);
    const now = new Date().toISOString();
    const row = await tx.get(`INSERT INTO purchase_orders
      (id, site_id, po_no, supplier_name, ordered_on, status, notes, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?) RETURNING ${ORDER_COLUMNS}`,
    randomUUID(), site, poNo, supplierName, orderedOn, notes, now, now);
    await audit(tx, 'purchase_order', 'create', null, row, site, user, now);
    return { ...row, items: [] };
  }), 'PO_DUPLICATE_NUMBER', 'Purchase order number already exists in this site.');
}

export async function updatePurchaseOrder(db, id, input, user) {
  requireUser(user);
  object(input);
  return await db.transaction(async tx => {
    const row = await lockOrder(tx, id, user), now = new Date().toISOString();
    const supplier = input.supplierName === undefined ? row.supplier_name : text(input.supplierName, 'supplierName', 200, true);
    const ordered = input.orderedOn === undefined ? row.ordered_on : date(input.orderedOn, 'orderedOn');
    const notes = input.notes === undefined ? row.notes : text(input.notes, 'notes');
    const after = await tx.get(`UPDATE purchase_orders SET supplier_name = ?, ordered_on = ?, notes = ?, updated_at = ?
      WHERE id = ? RETURNING ${ORDER_COLUMNS}`, supplier, ordered, notes, now, row.id);
    await audit(tx, 'purchase_order', 'update', row, after, row.site_id, user, now);
    return { ...after, items: await items(tx, row.id) };
  });
}

export async function transitionPurchaseOrder(db, id, input, user) {
  requireUser(user);
  object(input);
  return await db.transaction(async tx => {
    const row = await lockOrder(tx, id, user), status = input.status;
    if (!STATUSES.includes(status)) invalid('Unknown purchase order status.');
    const note = text(input.note, 'note');
    if (row.closed_at != null || !['open', 'template_generated', 'in_execution'].includes(row.status)) conflict();
    const rows = await items(tx, row.id);
    const allowed = status === 'template_generated' ? row.status === 'open'
      : status === 'completed' ? rows.every(item => FINAL.includes(item.status))
        : status === 'not_relevant' && rows.every(item => item.status === 'not_relevant');
    if (!allowed) conflict();
    const now = new Date().toISOString();
    const after = await tx.get(`UPDATE purchase_orders SET status = ?, closed_at = ?, updated_at = ?
      WHERE id = ? RETURNING ${ORDER_COLUMNS}`, status, FINAL.includes(status) ? now : row.closed_at, now, row.id);
    await audit(tx, 'purchase_order', 'update', row, after, row.site_id, user, now, note);
    return { ...after, items: rows };
  });
}

export async function addPurchaseOrderItem(db, poId, input, user) {
  requireUser(user);
  object(input);
  return await uniqueWrite(db, () => db.transaction(async tx => {
    const order = await lockOrder(tx, poId, user), rows = await items(tx, order.id);
    const number = lineNo(input.lineNo === undefined ? (rows.at(-1)?.line_no ?? 0) + 1 : input.lineNo);
    const material = text(input.materialNo, 'materialNo'), description = text(input.description, 'description', 500, true);
    const unit = text(input.unit, 'unit', 20), amount = quantity(input.quantity);
    const wbs = await validateWbs(tx, input.wbsId, order.site_id), now = new Date().toISOString();
    const row = await tx.get(`INSERT INTO purchase_order_items
      (id, purchase_order_id, line_no, material_no, description, unit, quantity, wbs_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING ${ITEM_COLUMNS}`,
    randomUUID(), order.id, number, material, description, unit, amount, wbs, now, now);
    await audit(tx, 'purchase_order_item', 'create', null, row, order.site_id, user, now);
    await recomputePurchaseOrder(tx, order, user, now);
    return row;
  }), 'PO_DUPLICATE_LINE', 'Purchase order line number already exists.');
}

export async function updatePurchaseOrderItem(db, id, input, user) {
  requireUser(user);
  object(input);
  return await uniqueWrite(db, () => db.transaction(async tx => {
    const initial = await findItem(tx, id), order = await lockOrder(tx, initial.purchase_order_id, user);
    const row = await findItem(tx, initial.id), now = new Date().toISOString();
    const number = input.lineNo === undefined ? row.line_no : lineNo(input.lineNo);
    const material = input.materialNo === undefined ? row.material_no : text(input.materialNo, 'materialNo');
    const description = input.description === undefined ? row.description : text(input.description, 'description', 500, true);
    const unit = input.unit === undefined ? row.unit : text(input.unit, 'unit', 20);
    const amount = input.quantity === undefined ? row.quantity : quantity(input.quantity);
    const wbs = input.wbsId === undefined ? row.wbs_id : await validateWbs(tx, input.wbsId, order.site_id);
    const after = await tx.get(`UPDATE purchase_order_items SET line_no = ?, material_no = ?, description = ?,
      unit = ?, quantity = ?, wbs_id = ?, updated_at = ? WHERE id = ? RETURNING ${ITEM_COLUMNS}`,
    number, material, description, unit, amount, wbs, now, row.id);
    await audit(tx, 'purchase_order_item', 'update', row, after, order.site_id, user, now);
    await recomputePurchaseOrder(tx, order, user, now);
    return after;
  }), 'PO_DUPLICATE_LINE', 'Purchase order line number already exists.');
}

export async function transitionPurchaseOrderItem(db, id, input, user) {
  requireUser(user);
  object(input);
  return await db.transaction(async tx => {
    const initial = await findItem(tx, id), order = await lockOrder(tx, initial.purchase_order_id, user);
    const row = await findItem(tx, initial.id), status = input.status;
    if (!['open', 'in_execution', 'completed', 'not_relevant'].includes(status)) invalid('Unknown purchase order item status.');
    const allowed = !FINAL.includes(row.status) && (status === 'not_relevant' ||
      (row.status === 'open' && status === 'in_execution') || (row.status === 'in_execution' && status === 'completed'));
    if (!allowed) conflict();
    const now = new Date().toISOString(), today = now.slice(0, 10);
    const after = await tx.get(`UPDATE purchase_order_items SET status = ?, execution_started_on = ?,
      completed_on = ?, not_relevant_on = ?, updated_at = ? WHERE id = ? RETURNING ${ITEM_COLUMNS}`,
    status, status === 'in_execution' ? today : row.execution_started_on,
    status === 'completed' ? today : row.completed_on, status === 'not_relevant' ? today : row.not_relevant_on, now, row.id);
    await audit(tx, 'purchase_order_item', 'update', row, after, order.site_id, user, now);
    await recomputePurchaseOrder(tx, order, user, now);
    return after;
  });
}
