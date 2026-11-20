import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createServer } from '../server/http.mjs';
import { createSite } from '../server/repository.mjs';
import { createPackage, getPackage, listPackages, closePackage } from '../server/packages.mjs';
import { getPurchaseOrder, updatePurchaseOrderItem, transitionPurchaseOrderItem } from '../server/purchase-orders.mjs';
import { listAuditEvents } from '../server/audit.mjs';
import { saveModuleAccess } from '../server/module-access.mjs';
import { authFixture, requestListener } from './helpers/auth.mjs';
import { database, purchasingFixture, failAudit, auditUpgrade } from './helpers/procurement.mjs';

for (const driver of ['sqlite', 'pg']) test(`packages ${driver === 'pg' ? 'PGlite' : driver}`, async t => {
  const db = await database(t, driver);
  const { users, cookies } = await authFixture(db);
  const fixture = options => purchasingFixture(db, users, options);
  const error = (status, code = 'VALIDATION_ERROR') => ({ status, code });

  await t.test('creates snapshots, starts execution and recomputes the order; subsequent packages preserve dates', async t => {
    const f = await fixture();
    const row = await createPackage(db, { ...f.packageInput, notes: ' Synthetic note ' }, users.editor);
    t.assert.strictEqual(row.status, 'open');
    t.assert.strictEqual(row.package_no, 'PKG-001');
    t.assert.strictEqual(row.notes, 'Synthetic note');
    t.assert.strictEqual(row.closed_at, null);
    t.assert.strictEqual(row.items.length, 1);
    t.assert.deepStrictEqual([row.items[0].unit, row.items[0].material_no, row.items[0].description],
      ['piece', 'MAT-001', 'Synthetic material']);
    t.assert.strictEqual(Number(row.items[0].quantity_packed), 1.125);
    const order = await getPurchaseOrder(db, f.order.id, users.owner);
    t.assert.strictEqual(order.status, 'in_execution');
    t.assert.strictEqual(order.items[0].status, 'in_execution');
    t.assert.strictEqual(order.items[0].execution_started_on, new Date(row.created_at).toISOString().slice(0, 10));
    await updatePurchaseOrderItem(db, f.item.id, { unit: 'box', materialNo: 'MAT-NEW', description: 'Updated synthetic material' }, users.owner);
    t.assert.strictEqual((await createPackage(db, f.packageInput, users.owner)).package_no, 'PKG-002');
    const after = await getPurchaseOrder(db, f.order.id, users.owner);
    t.assert.strictEqual(after.items[0].execution_started_on, order.items[0].execution_started_on);
    const detail = await getPackage(db, row.id, users.viewer);
    t.assert.strictEqual(detail.items[0].description, 'Synthetic material');
    t.assert.strictEqual((await listPackages(db, { siteId: f.site.id, purchaseOrderId: f.order.id }, users.viewer)).length, 2);
    t.assert.deepStrictEqual(await listPackages(db, { siteId: f.site.id, purchaseOrderId: randomUUID() }, users.owner), []);
  });

  await t.test('generated numbers use max plus one within each order; duplicate explicit numbers conflict', async t => {
    const f = await fixture();
    await createPackage(db, { ...f.packageInput, packageNo: 'PKG-009' }, users.owner);
    await createPackage(db, { ...f.packageInput, packageNo: 'SYN-CUSTOM' }, users.owner);
    t.assert.strictEqual((await createPackage(db, f.packageInput, users.owner)).package_no, 'PKG-010');
    await t.assert.rejects(() => createPackage(db, { ...f.packageInput, packageNo: ' PKG-009 ' }, users.owner), error(409, 'PACKAGE_DUPLICATE_NUMBER'));
    const other = await fixture();
    t.assert.strictEqual((await createPackage(db, other.packageInput, users.owner)).package_no, 'PKG-001');
  });

  await t.test('counts open and closed quantities exactly and rolls back over-packing', async t => {
    const f = await fixture();
    const pack = amount => createPackage(db, { ...f.packageInput, items: [{ purchaseOrderItemId: f.item.id, quantityPacked: amount }] }, users.owner);
    await closePackage(db, (await pack('0.100')).id, users.owner);
    await pack('0.200');
    await pack('9.825');
    const before = await db.all('SELECT * FROM audit_events WHERE site_id = ? ORDER BY id', f.site.id);
    await t.assert.rejects(() => pack('0.001'), error(400, 'PACKAGE_QUANTITY_EXCEEDED'));
    t.assert.strictEqual((await listPackages(db, { siteId: f.site.id }, users.owner)).length, 3);
    t.assert.deepStrictEqual(await db.all('SELECT * FROM audit_events WHERE site_id = ? ORDER BY id', f.site.id), before);
  });

  await t.test('foreign or nonexistent items return 404 and roll back all package lines and execution', async t => {
    const f = await fixture(), other = await fixture();
    for (const id of [other.item.id, randomUUID()]) {
      await t.assert.rejects(() => createPackage(db, { ...f.packageInput,
        items: [...f.packageInput.items, { purchaseOrderItemId: id, quantityPacked: 1 }],
      }, users.owner), error(404, 'PACKAGE_ITEM_NOT_FOUND'));
    }
    t.assert.deepStrictEqual(await listPackages(db, { siteId: f.site.id }, users.owner), []);
    t.assert.strictEqual((await getPurchaseOrder(db, f.order.id, users.owner)).items[0].status, 'open');
    await t.assert.rejects(() => createPackage(db, { ...f.packageInput, purchaseOrderId: other.order.id }, users.owner), error(404, 'PO_NOT_FOUND'));
  });

  await t.test('closing is final and leaves item and order statuses unchanged', async t => {
    const f = await fixture(), row = await createPackage(db, f.packageInput, users.owner);
    const before = await getPurchaseOrder(db, f.order.id, users.owner);
    const closed = await closePackage(db, row.id, users.editor);
    t.assert.strictEqual(closed.status, 'closed');
    t.assert.ok(Number.isFinite(Date.parse(closed.closed_at)));
    await t.assert.rejects(() => closePackage(db, row.id, users.owner), error(409, 'PACKAGE_STATUS_CONFLICT'));
    t.assert.deepStrictEqual(await getPurchaseOrder(db, f.order.id, users.owner), before);
  });

  await t.test('preserves existing execution dates and terminal purchase order item states', async t => {
    const f = await fixture();
    await transitionPurchaseOrderItem(db, f.item.id, { status: 'in_execution' }, users.owner);
    await db.run('UPDATE purchase_order_items SET execution_started_on = ? WHERE id = ?', '2026-01-10', f.item.id);
    await transitionPurchaseOrderItem(db, f.item.id, { status: 'completed' }, users.owner);
    await createPackage(db, f.packageInput, users.owner);
    const order = await getPurchaseOrder(db, f.order.id, users.owner);
    t.assert.strictEqual(order.items[0].status, 'completed');
    t.assert.strictEqual(order.items[0].execution_started_on, '2026-01-10');
    t.assert.strictEqual(order.status, 'completed');
  });

  await t.test('enforces roles, sales site isolation, authentication and logistics grants for every operation', async t => {
    const f = await fixture({ grants: false }), row = await createPackage(db, f.packageInput, users.owner);
    const calls = user => [() => createPackage(db, f.packageInput, user), () => getPackage(db, row.id, user),
      () => listPackages(db, { siteId: f.site.id }, user), () => closePackage(db, row.id, user)];
    for (const call of calls(null)) await t.assert.rejects(call, error(401, 'UNAUTHENTICATED'));
    for (const call of calls(users.editor)) await t.assert.rejects(call, error(403, 'MODULE_FORBIDDEN'));
    await saveModuleAccess(db, { siteId: f.site.id, memberId: users.viewer.id, module: 'logistics', allowed: true }, users.owner);
    for (const call of [calls(users.viewer)[0], calls(users.viewer)[3]]) await t.assert.rejects(call, { status: 403 });
    const sales = await createSite(db, { code: randomUUID(), name: 'Synthetic sales site' });
    const salesUser = { id: randomUUID() };
    await db.run('INSERT INTO site_members VALUES (?, ?, ?)', sales.id, users.editor.id, 'editor');
    // The existing editor has sales access but no membership at the procurement site.
    await db.run('DELETE FROM site_members WHERE site_id = ? AND user_id = ?', f.site.id, users.editor.id);
    for (const call of calls(users.editor)) await t.assert.rejects(call, { status: 403 });
    for (const call of calls(salesUser)) await t.assert.rejects(call, { status: 403 });
  });

  await t.test('validates input, precision, identifiers and missing packages', async t => {
    const f = await fixture();
    for (const amount of [0, -1, '0.000', '1.0001', '1e2', 1000000000, null, true, NaN]) {
      await t.assert.rejects(() => createPackage(db, { ...f.packageInput,
        items: [{ purchaseOrderItemId: f.item.id, quantityPacked: amount }],
      }, users.owner), error(400));
    }
    for (const changes of [{ items: [] }, { items: null }, { items: [null] },
      { items: [...f.packageInput.items, ...f.packageInput.items] }, { siteId: 'bad' },
      { purchaseOrderId: 'bad' }, { packageNo: '' }, { packageNo: null }, { notes: false }]) {
      await t.assert.rejects(() => createPackage(db, { ...f.packageInput, ...changes }, users.owner), error(400));
    }
    await t.assert.rejects(() => createPackage(db, [], users.owner), error(400));
    await t.assert.rejects(() => getPackage(db, randomUUID(), users.owner), error(404, 'PACKAGE_NOT_FOUND'));
  });

  await t.test('audits package, snapshot and order/item updates and rolls back audit failures', async t => {
    const f = await fixture(), row = await createPackage(db, f.packageInput, users.editor);
    await closePackage(db, row.id, users.editor);
    const events = await listAuditEvents(db, { siteId: f.site.id, entityType: 'package', entityId: row.id }, users.owner);
    t.assert.strictEqual(events.length, 2);
    t.assert.ok(events.every(event => event.actor === users.editor.id));
    t.assert.strictEqual(JSON.parse(events.find(event => event.action === 'update').changes).status.to, 'closed');
    const lineEvents = await listAuditEvents(db, { siteId: f.site.id, entityType: 'package_item' }, users.owner);
    t.assert.strictEqual(lineEvents.length, 1);
    t.assert.strictEqual(JSON.parse(lineEvents[0].changes).purchase_order_item_id, f.item.id);
    for (const type of ['package', 'package_item', 'purchase_order_item', 'purchase_order']) {
      const fresh = await fixture();
      const before = await db.all('SELECT * FROM audit_events WHERE site_id = ? ORDER BY id', fresh.site.id);
      await t.assert.rejects(() => createPackage(failAudit(db, type), fresh.packageInput, users.owner), /Synthetic audit failure/);
      t.assert.deepStrictEqual(await listPackages(db, { siteId: fresh.site.id }, users.owner), []);
      t.assert.strictEqual((await getPurchaseOrder(db, fresh.order.id, users.owner)).items[0].status, 'open');
      t.assert.deepStrictEqual(await db.all('SELECT * FROM audit_events WHERE site_id = ? ORDER BY id', fresh.site.id), before);
    }
    const open = await createPackage(db, f.packageInput, users.owner);
    await t.assert.rejects(() => closePackage(failAudit(db, 'package'), open.id, users.owner), /Synthetic audit failure/);
    t.assert.strictEqual((await getPackage(db, open.id, users.owner)).status, 'open');
  });

  await t.test('serializes competing package totals and auto numbering', async t => {
    const f = await fixture();
    const result = await Promise.allSettled([1, 2].map(() => createPackage(db, { ...f.packageInput,
      items: [{ purchaseOrderItemId: f.item.id, quantityPacked: 6 }],
    }, users.owner)));
    t.assert.strictEqual(result.filter(row => row.status === 'fulfilled').length, 1);
    t.assert.strictEqual(result.find(row => row.status === 'rejected').reason.code, 'PACKAGE_QUANTITY_EXCEEDED');
    const fresh = await fixture();
    const rows = await Promise.all([1, 2].map(() => createPackage(db, fresh.packageInput, users.owner)));
    t.assert.deepStrictEqual(rows.map(row => row.package_no).sort(), ['PKG-001', 'PKG-002']);
  });

  await t.test('schema enforces status, quantity, references, uniqueness and lookup indexes', async t => {
    const f = await fixture(), row = await createPackage(db, f.packageInput, users.owner), item = row.items[0];
    await t.assert.rejects(() => db.run("UPDATE packages SET status = 'bad' WHERE id = ?", row.id), /check/i);
    await t.assert.rejects(() => db.run('UPDATE package_items SET quantity_packed = 0 WHERE id = ?', item.id), /check/i);
    await t.assert.rejects(() => db.run('UPDATE package_items SET purchase_order_item_id = ? WHERE id = ?', randomUUID(), item.id), /foreign key/i);
    await t.assert.rejects(() => db.run(`INSERT INTO package_items
      (id, package_id, purchase_order_item_id, quantity_packed, description, created_at)
      VALUES (?, ?, ?, 1, 'Synthetic duplicate', ?)`, randomUUID(), row.id, f.item.id, new Date().toISOString()), /unique/i);
    if (driver === 'sqlite') {
      t.assert.deepStrictEqual((await db.all('PRAGMA index_info(packages_site_order)')).map(row => row.name), ['site_id', 'purchase_order_id']);
      t.assert.deepStrictEqual((await db.all('PRAGMA index_info(package_items_order_item)')).map(row => row.name), ['purchase_order_item_id']);
    } else {
      const column = await db.get("SELECT numeric_precision, numeric_scale FROM information_schema.columns WHERE table_name = 'package_items' AND column_name = 'quantity_packed'");
      t.assert.deepStrictEqual([column.numeric_precision, column.numeric_scale], [12, 3]);
    }
  });

  await t.test('HTTP routes return authenticated detail, filters and standard error envelopes', async t => {
    const f = await fixture(), server = createServer(db), request = requestListener(server);
    const api = (path, options = {}) => request(path, { cookie: cookies.owner, ...options });
    const created = await api('/api/packages', { method: 'POST', body: f.packageInput });
    t.assert.strictEqual(created.status, 201);
    const path = `/api/packages/${created.body.id}`;
    t.assert.strictEqual((await api(path)).body.items.length, 1);
    t.assert.strictEqual((await api(`/api/packages?site_id=${f.site.id}&purchase_order_id=${f.order.id}`)).body.length, 1);
    t.assert.strictEqual((await api(`/api/packages?site_id=${f.site.id}&purchase_order_id=${randomUUID()}`)).body.length, 0);
    t.assert.strictEqual((await api(`${path}/close`, { method: 'POST' })).status, 200);
    const duplicateClose = await api(`${path}/close`, { method: 'POST' });
    t.assert.strictEqual(duplicateClose.status, 409);
    t.assert.strictEqual(duplicateClose.body.code, 'PACKAGE_STATUS_CONFLICT');
    for (const [target, method, body] of [[path, 'GET'], [`/api/packages?site_id=${f.site.id}`, 'GET'],
      ['/api/packages', 'POST', f.packageInput], [`${path}/close`, 'POST']]) {
      const anonymous = await api(target, { method, body, cookie: undefined });
      t.assert.strictEqual(anonymous.status, 401);
      t.assert.strictEqual(anonymous.body.code, 'AUTH_REQUIRED');
      await saveModuleAccess(db, { siteId: f.site.id, memberId: users.editor.id, module: 'logistics', allowed: false }, users.owner);
      const denied = await api(target, { method, body, cookie: cookies.editor });
      t.assert.strictEqual(denied.status, 403);
      t.assert.strictEqual(denied.body.code, 'MODULE_FORBIDDEN');
    }
  });
});

for (const driver of ['sqlite', 'pg']) test(`033 preserves populated audit history: ${driver}`, async t => {
  await auditUpgrade(t, driver, '033_packages.sql', 'purchase_order', ['package', 'package_item']);
});
