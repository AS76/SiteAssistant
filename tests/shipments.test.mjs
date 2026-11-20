import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createServer } from '../server/http.mjs';
import { createSite } from '../server/repository.mjs';
import { createPackage } from '../server/packages.mjs';
import { createShipment, getShipment, listShipments, transitionShipment, addShipmentReceipt } from '../server/shipments.mjs';
import { createPurchaseOrder, addPurchaseOrderItem } from '../server/purchase-orders.mjs';
import { listAuditEvents } from '../server/audit.mjs';
import { saveModuleAccess } from '../server/module-access.mjs';
import { authFixture, requestListener } from './helpers/auth.mjs';
import { database, purchasingFixture, failAudit, auditUpgrade } from './helpers/procurement.mjs';

for (const driver of ['sqlite', 'pg']) test(`shipments ${driver === 'pg' ? 'PGlite' : driver}`, async t => {
  const db = await database(t, driver);
  const { users, cookies } = await authFixture(db);
  const error = (status, code = 'VALIDATION_ERROR') => ({ status, code });
  const fixture = async options => {
    const f = await purchasingFixture(db, users, options);
    const pack = await createPackage(db, f.packageInput, users.owner);
    return { ...f, pack, input: { siteId: f.site.id, shipmentNo: 'SHP-001', packageIds: [pack.id] } };
  };
  const transition = (id, status, user = users.owner) => transitionShipment(db, id, { status }, user);

  await t.test('creates a planned shipment with packages from different orders at the same site', async t => {
    const f = await fixture();
    const order = await createPurchaseOrder(db, {
      siteId: f.site.id, poNo: 'PO-002', supplierName: 'Synthetic supplier', orderedOn: '2026-02-01',
    }, users.owner);
    const item = await addPurchaseOrderItem(db, order.id, { description: 'Other synthetic material', quantity: 3 }, users.owner);
    const pack = await createPackage(db, { siteId: f.site.id, purchaseOrderId: order.id,
      items: [{ purchaseOrderItemId: item.id, quantityPacked: 1 }],
    }, users.owner);
    const row = await createShipment(db, { ...f.input, packageIds: [f.pack.id, pack.id], carrier: ' Synthetic carrier ',
      shippedOn: '2026-02-10', expectedOn: '2026-02-20', notes: ' Synthetic shipment ', status: 'received', arrivedOn: '2026-01-01',
    }, users.editor);
    t.assert.deepStrictEqual([row.status, row.carrier, row.shipped_on, row.expected_on, row.arrived_on, row.notes],
      ['planned', 'Synthetic carrier', '2026-02-10', '2026-02-20', null, 'Synthetic shipment']);
    t.assert.deepStrictEqual(row.packages.map(part => part.id).sort(), [f.pack.id, pack.id].sort());
    t.assert.deepStrictEqual(row.receipts, []);
    const detail = await getShipment(db, row.id, users.viewer);
    t.assert.strictEqual(detail.packages.length, 2);
    t.assert.strictEqual((await listShipments(db, { siteId: f.site.id, status: 'planned' }, users.viewer)).length, 1);
    t.assert.deepStrictEqual(await listShipments(db, { siteId: f.site.id, status: 'arrived' }, users.owner), []);
    const receipt = await addShipmentReceipt(db, row.id, { purchaseOrderItemId: item.id, quantityReceived: 2 }, users.owner);
    t.assert.strictEqual(receipt.purchase_order_item_id, item.id);
  });

  await t.test('requires sequential transitions, sets arrival date and requires a receipt before received', async t => {
    const f = await fixture(), row = await createShipment(db, f.input, users.owner);
    for (const status of ['planned', 'arrived', 'received']) await t.assert.rejects(() => transition(row.id, status), error(409, 'SHIPMENT_STATUS_CONFLICT'));
    t.assert.strictEqual((await transition(row.id, 'in_transit', users.editor)).arrived_on, null);
    await t.assert.rejects(() => transition(row.id, 'received'), error(409, 'SHIPMENT_STATUS_CONFLICT'));
    const arrived = await transition(row.id, 'arrived');
    t.assert.strictEqual(arrived.arrived_on, new Date(arrived.updated_at).toISOString().slice(0, 10));
    await t.assert.rejects(() => transition(row.id, 'received'), error(409, 'SHIPMENT_STATUS_CONFLICT'));
    t.assert.strictEqual((await getShipment(db, row.id, users.owner)).status, 'arrived');
    await addShipmentReceipt(db, row.id, { purchaseOrderItemId: f.item.id, quantityReceived: 0 }, users.owner);
    const received = await transition(row.id, 'received');
    t.assert.strictEqual(received.status, 'received');
    t.assert.strictEqual(received.arrived_on, arrived.arrived_on);
    for (const status of ['planned', 'in_transit', 'arrived', 'received']) {
      await t.assert.rejects(() => transition(row.id, status), error(409, 'SHIPMENT_STATUS_CONFLICT'));
    }
  });

  await t.test('rejects taken packages, mixed sites, missing packages and duplicate shipment numbers', async t => {
    const f = await fixture(), other = await fixture();
    await createShipment(db, f.input, users.owner);
    await t.assert.rejects(() => createShipment(db, { ...f.input, shipmentNo: 'SHP-002' }, users.owner), error(409, 'SHIPMENT_PACKAGE_TAKEN'));
    await t.assert.rejects(() => createShipment(db, { ...f.input, shipmentNo: 'SHP-003', packageIds: [other.pack.id] }, users.owner), error(400, 'SHIPMENT_PACKAGE_SITE_MISMATCH'));
    const free = await createPackage(db, f.packageInput, users.owner);
    await t.assert.rejects(() => createShipment(db, { ...f.input, shipmentNo: 'SHP-004', packageIds: [free.id, other.pack.id] }, users.owner), error(400, 'SHIPMENT_PACKAGE_SITE_MISMATCH'));
    await t.assert.rejects(() => createShipment(db, { ...f.input, packageIds: [randomUUID()] }, users.owner), error(404, 'SHIPMENT_PACKAGE_NOT_FOUND'));
    await t.assert.rejects(() => createShipment(db, { ...f.input, packageIds: [free.id] }, users.owner), error(409, 'SHIPMENT_DUPLICATE_NUMBER'));
    t.assert.strictEqual((await createShipment(db, { ...f.input, shipmentNo: 'SHP-002', packageIds: [free.id] }, users.owner)).packages.length, 1);
    // The same shipment number is independently available in another site.
    t.assert.strictEqual((await createShipment(db, other.input, users.owner)).shipment_no, 'SHP-001');
  });

  await t.test('receipts accept zero, repeated and over-received quantities only for packed items', async t => {
    const f = await fixture(), row = await createShipment(db, f.input, users.owner);
    const unpacked = await addPurchaseOrderItem(db, f.order.id, { description: 'Unpacked synthetic line', quantity: 1 }, users.owner);
    const receipt = await addShipmentReceipt(db, row.id, {
      purchaseOrderItemId: f.item.id, quantityReceived: '999.125', note: ' Synthetic over-receipt ',
    }, users.editor);
    t.assert.strictEqual(Number(receipt.quantity_received), 999.125);
    t.assert.strictEqual(receipt.note, 'Synthetic over-receipt');
    for (const amount of [0, '20.125', '999999999.999']) {
      await addShipmentReceipt(db, row.id, { purchaseOrderItemId: f.item.id, quantityReceived: amount }, users.owner);
    }
    t.assert.strictEqual((await getShipment(db, row.id, users.viewer)).receipts.length, 4);
    const other = await fixture();
    const unrelatedOrder = await createPurchaseOrder(db, {
      siteId: f.site.id, poNo: 'PO-UNSHIPPED', supplierName: 'Synthetic supplier', orderedOn: '2026-01-15',
    }, users.owner);
    const unrelatedItem = await addPurchaseOrderItem(db, unrelatedOrder.id, { description: 'Synthetic unrelated line', quantity: 1 }, users.owner);
    for (const itemId of [unpacked.id, other.item.id, unrelatedItem.id, randomUUID()]) {
      await t.assert.rejects(() => addShipmentReceipt(db, row.id, { purchaseOrderItemId: itemId, quantityReceived: 1 }, users.owner), error(404, 'SHIPMENT_ITEM_NOT_FOUND'));
    }
  });

  await t.test('received shipments reject further receipts without changing receipt or audit history', async t => {
    const f = await fixture(), row = await createShipment(db, f.input, users.owner);
    await addShipmentReceipt(db, row.id, { purchaseOrderItemId: f.item.id, quantityReceived: 1 }, users.owner);
    for (const status of ['in_transit', 'arrived', 'received']) await transition(row.id, status);
    const before = await getShipment(db, row.id, users.owner);
    const audit = await listAuditEvents(db, { siteId: f.site.id }, users.owner);
    await t.assert.rejects(() => addShipmentReceipt(db, row.id, {
      purchaseOrderItemId: f.item.id, quantityReceived: 1,
    }, users.owner), error(409, 'SHIPMENT_STATUS_CONFLICT'));
    t.assert.deepStrictEqual((await getShipment(db, row.id, users.owner)).receipts, before.receipts);
    t.assert.deepStrictEqual(await listAuditEvents(db, { siteId: f.site.id }, users.owner), audit);
  });

  await t.test('enforces site roles, sales isolation, authentication and module denial for every operation', async t => {
    const f = await fixture({ grants: false }), row = await createShipment(db, f.input, users.owner);
    const free = await createPackage(db, f.packageInput, users.owner);
    const calls = user => [() => createShipment(db, { ...f.input, shipmentNo: 'SHP-002', packageIds: [free.id] }, user),
      () => listShipments(db, { siteId: f.site.id }, user), () => getShipment(db, row.id, user),
      () => transition(row.id, 'in_transit', user),
      () => addShipmentReceipt(db, row.id, { purchaseOrderItemId: f.item.id, quantityReceived: 1 }, user)];
    for (const call of calls(null)) await t.assert.rejects(call, error(401, 'UNAUTHENTICATED'));
    for (const call of calls(users.editor)) await t.assert.rejects(call, error(403, 'MODULE_FORBIDDEN'));
    for (const role of ['verifier', 'viewer']) {
      await saveModuleAccess(db, { siteId: f.site.id, memberId: users[role].id, module: 'logistics', allowed: true }, users.owner);
      for (const index of [0, 3, 4]) await t.assert.rejects(calls(users[role])[index], { status: 403 });
    }
    const sales = await createSite(db, { code: randomUUID(), name: 'Synthetic sales site' });
    await db.run('INSERT INTO site_members VALUES (?, ?, ?)', sales.id, users.editor.id, 'editor');
    await db.run('DELETE FROM site_members WHERE site_id = ? AND user_id = ?', f.site.id, users.editor.id);
    for (const call of calls(users.editor)) await t.assert.rejects(call, { status: 403 });
  });

  await t.test('validates shipment dates, numbers, package lists, statuses and receipt quantities', async t => {
    const f = await fixture();
    for (const changes of [{ siteId: 'bad' }, { shipmentNo: '' }, { shipmentNo: null }, { packageIds: [] },
      { packageIds: null }, { packageIds: ['bad'] }, { packageIds: [f.pack.id, f.pack.id] }, { carrier: false },
      { shippedOn: '2026-02-29' }, { expectedOn: '2026-2-01' }, { expectedOn: '0000-01-01' }, { notes: [] }]) {
      await t.assert.rejects(() => createShipment(db, { ...f.input, ...changes }, users.owner), error(400));
    }
    await t.assert.rejects(() => createShipment(db, null, users.owner), error(400));
    const row = await createShipment(db, f.input, users.owner);
    for (const amount of [-1, '1.0001', '1e3', null, false, NaN, 1000000000]) {
      await t.assert.rejects(() => addShipmentReceipt(db, row.id, { purchaseOrderItemId: f.item.id, quantityReceived: amount }, users.owner), error(400));
    }
    await t.assert.rejects(() => addShipmentReceipt(db, row.id, [], users.owner), error(400));
    await t.assert.rejects(() => transition(row.id, 'invalid'), error(400));
    await t.assert.rejects(() => listShipments(db, { siteId: f.site.id, status: 'invalid' }, users.owner), error(400));
    await t.assert.rejects(() => getShipment(db, randomUUID(), users.owner), error(404, 'SHIPMENT_NOT_FOUND'));
  });

  await t.test('writes shipment and receipt audit rows and rolls back every failed audit', async t => {
    const f = await fixture();
    await t.assert.rejects(() => createShipment(failAudit(db, 'shipment'), f.input, users.owner), /Synthetic audit failure/);
    t.assert.deepStrictEqual(await listShipments(db, { siteId: f.site.id }, users.owner), []);
    t.assert.strictEqual(Number((await db.get('SELECT COUNT(*) AS total FROM shipment_packages WHERE package_id = ?', f.pack.id)).total), 0);
    const row = await createShipment(db, f.input, users.editor);
    await t.assert.rejects(() => transitionShipment(failAudit(db, 'shipment'), row.id, { status: 'in_transit' }, users.owner), /Synthetic audit failure/);
    t.assert.strictEqual((await getShipment(db, row.id, users.owner)).status, 'planned');
    await transition(row.id, 'in_transit', users.editor);
    await t.assert.rejects(() => addShipmentReceipt(failAudit(db, 'shipment_receipt'), row.id, {
      purchaseOrderItemId: f.item.id, quantityReceived: 1,
    }, users.owner), /Synthetic audit failure/);
    t.assert.deepStrictEqual((await getShipment(db, row.id, users.owner)).receipts, []);
    const receipt = await addShipmentReceipt(db, row.id, { purchaseOrderItemId: f.item.id, quantityReceived: 15 }, users.editor);
    const events = await listAuditEvents(db, { siteId: f.site.id, entityType: 'shipment', entityId: row.id }, users.owner);
    t.assert.strictEqual(events.length, 2);
    t.assert.ok(events.every(event => event.actor === users.editor.id));
    t.assert.strictEqual(JSON.parse(events.find(event => event.action === 'update').changes).status.to, 'in_transit');
    const receipts = await listAuditEvents(db, { siteId: f.site.id, entityType: 'shipment_receipt', entityId: receipt.id }, users.owner);
    t.assert.strictEqual(receipts.length, 1);
    t.assert.strictEqual(Number(JSON.parse(receipts[0].changes).quantity_received), 15);
  });

  await t.test('serializes competing claims to the same package', async t => {
    const f = await fixture();
    const results = await Promise.allSettled([1, 2].map(number => createShipment(db, { ...f.input, shipmentNo: `SHP-${number}` }, users.owner)));
    t.assert.strictEqual(results.filter(row => row.status === 'fulfilled').length, 1);
    t.assert.strictEqual(results.find(row => row.status === 'rejected').reason.code, 'SHIPMENT_PACKAGE_TAKEN');
  });

  await t.test('schema enforces receipt quantities, references, status and exclusive package ownership', async t => {
    const f = await fixture(), row = await createShipment(db, f.input, users.owner);
    const free = await createPackage(db, f.packageInput, users.owner);
    const other = await createShipment(db, { ...f.input, shipmentNo: 'SHP-002', packageIds: [free.id] }, users.owner);
    await t.assert.rejects(() => db.run('INSERT INTO shipment_packages VALUES (?, ?)', other.id, f.pack.id), /unique/i);
    await t.assert.rejects(() => db.run("UPDATE shipments SET status = 'bad' WHERE id = ?", row.id), /check/i);
    const receipt = await addShipmentReceipt(db, row.id, { purchaseOrderItemId: f.item.id, quantityReceived: 0 }, users.owner);
    await t.assert.rejects(() => db.run('UPDATE shipment_receipts SET quantity_received = -1 WHERE id = ?', receipt.id), /check/i);
    await t.assert.rejects(() => db.run('UPDATE shipment_receipts SET purchase_order_item_id = ? WHERE id = ?', randomUUID(), receipt.id), /foreign key/i);
    if (driver === 'pg') {
      const column = await db.get("SELECT numeric_precision, numeric_scale FROM information_schema.columns WHERE table_name = 'shipment_receipts' AND column_name = 'quantity_received'");
      t.assert.deepStrictEqual([column.numeric_precision, column.numeric_scale], [12, 3]);
      t.assert.strictEqual((await db.get("SELECT udt_name FROM information_schema.columns WHERE table_name = 'shipments' AND column_name = 'arrived_on'")).udt_name, 'date');
    }
  });

  await t.test('HTTP routes handle creation, filters, transitions, receipts and error envelopes', async t => {
    const f = await fixture(), request = requestListener(createServer(db));
    const api = (path, options = {}) => request(path, { cookie: cookies.owner, ...options });
    const created = await api('/api/shipments', { method: 'POST', body: f.input });
    t.assert.strictEqual(created.status, 201);
    const path = `/api/shipments/${created.body.id}`;
    t.assert.strictEqual((await api(path)).body.packages[0].id, f.pack.id);
    t.assert.strictEqual((await api(`/api/shipments?site_id=${f.site.id}&status=planned`)).body.length, 1);
    t.assert.strictEqual((await api(`/api/shipments?site_id=${f.site.id}&status=received`)).body.length, 0);
    const step = status => api(`${path}/status`, { method: 'POST', body: { status } });
    t.assert.strictEqual((await step('in_transit')).status, 200);
    t.assert.strictEqual((await step('arrived')).body.arrived_on, new Date().toISOString().slice(0, 10));
    const blocked = await step('received');
    t.assert.strictEqual(blocked.status, 409);
    t.assert.strictEqual(blocked.body.code, 'SHIPMENT_STATUS_CONFLICT');
    const receipt = await api(`${path}/receipts`, { method: 'POST', body: { purchaseOrderItemId: f.item.id, quantityReceived: 100 } });
    t.assert.strictEqual(receipt.status, 201);
    t.assert.strictEqual((await step('received')).body.status, 'received');
    const auditBefore = await listAuditEvents(db, { siteId: f.site.id }, users.owner);
    const lateReceipt = await api(`${path}/receipts`, { method: 'POST', body: { purchaseOrderItemId: f.item.id, quantityReceived: 1 } });
    t.assert.strictEqual(lateReceipt.status, 409);
    t.assert.strictEqual(lateReceipt.body.code, 'SHIPMENT_STATUS_CONFLICT');
    t.assert.strictEqual((await api(path)).body.receipts.length, 1);
    t.assert.deepStrictEqual(await listAuditEvents(db, { siteId: f.site.id }, users.owner), auditBefore);
    await saveModuleAccess(db, { siteId: f.site.id, memberId: users.editor.id, module: 'logistics', allowed: false }, users.owner);
    for (const [target, method, body] of [[path, 'GET'], [`/api/shipments?site_id=${f.site.id}`, 'GET'],
      ['/api/shipments', 'POST', f.input], [`${path}/status`, 'POST', { status: 'received' }],
      [`${path}/receipts`, 'POST', { purchaseOrderItemId: f.item.id, quantityReceived: 1 }]]) {
      const anonymous = await api(target, { method, body, cookie: undefined });
      t.assert.strictEqual(anonymous.status, 401);
      t.assert.strictEqual(anonymous.body.code, 'AUTH_REQUIRED');
      const denied = await api(target, { method, body, cookie: cookies.editor });
      t.assert.strictEqual(denied.status, 403);
      t.assert.strictEqual(denied.body.code, 'MODULE_FORBIDDEN');
    }
  });
});

for (const driver of ['sqlite', 'pg']) test(`034 preserves populated audit history: ${driver}`, async t => {
  await auditUpgrade(t, driver, '034_shipments.sql', 'package', ['shipment', 'shipment_receipt']);
});
