import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { createSite } from '../server/repository.mjs';
import { createServer } from '../server/http.mjs';
import {
  listPurchaseOrders, getPurchaseOrder, createPurchaseOrder, updatePurchaseOrder, transitionPurchaseOrder,
  addPurchaseOrderItem, updatePurchaseOrderItem, transitionPurchaseOrderItem,
} from '../server/purchase-orders.mjs';
import { listAuditEvents } from '../server/audit.mjs';
import { saveModuleAccess, moduleAllowed, listModuleAccess } from '../server/module-access.mjs';
import { translatePlaceholders } from '../server/storage/pg.mjs';
import { migrate, applyMigration } from '../server/migrations/index.mjs';
import { authFixture, requestListener } from './helpers/auth.mjs';
import { openSqliteTestDb } from './helpers/db.mjs';
import { openDb, closeDb } from '../server/db.mjs';

async function database(t, driver, initialize = true) {
  if (driver === 'sqlite') {
    if (!initialize) {
      const db = await openDb(':memory:', { driver, migrate: false });
      t.after(() => closeDb(db));
      return db;
    }
    const fixture = await openSqliteTestDb();
    t.after(fixture.close);
    return fixture.db;
  }
  const pg = new PGlite();
  t.after(() => pg.close());
  const adapt = connection => ({
    exec: sql => connection.exec(sql),
    all: async (sql, ...values) => (await connection.query(translatePlaceholders(sql), values)).rows,
    get: async (sql, ...values) => (await connection.query(translatePlaceholders(sql), values)).rows[0],
    run: async (sql, ...values) => ({ rowCount: (await connection.query(translatePlaceholders(sql), values)).affectedRows }),
    isUniqueViolation: error => error.code === '23505',
  });
  const db = { ...adapt(pg), transaction: fn => pg.transaction(tx => fn(adapt(tx))) };
  if (initialize) await migrate(db, { driver });
  return db;
}

for (const driver of ['sqlite', 'pg']) test(`purchase orders ${driver === 'pg' ? 'PGlite' : driver}`, async t => {
  const db = await database(t, driver);
  const { users, cookies } = await authFixture(db);
  const error = (status, code = 'VALIDATION_ERROR') => ({ status, code });
  const fixture = async ({ roles = ['owner', 'editor', 'verifier', 'viewer'], grants = true } = {}) => {
    const site = await createSite(db, { code: randomUUID(), name: 'Synthetic purchasing site' });
    for (const role of roles) {
      await db.run('INSERT INTO site_members VALUES (?, ?, ?)', site.id, users[role].id, role);
      if (grants && role !== 'owner') await saveModuleAccess(db, {
        siteId: site.id, memberId: users[role].id, module: 'logistics', allowed: true,
      }, users.owner);
    }
    const wbsId = randomUUID();
    await db.run(`INSERT INTO project_structure (id, site_id, wbs_code, level, created_at)
      VALUES (?, ?, 'SYN.1', 0, ?)`, wbsId, site.id, new Date().toISOString());
    const input = { siteId: site.id, poNo: 'PO-001', supplierName: 'Synthetic supplier', orderedOn: '2026-01-15' };
    const itemInput = { description: 'Synthetic material', quantity: '2.125', wbsId };
    return { site, wbsId, input, itemInput,
      create: (changes = {}, user = users.owner) => createPurchaseOrder(db, { ...input, ...changes }, user),
      add: (id, changes = {}, user = users.owner) => addPurchaseOrderItem(db, id, { ...itemInput, ...changes }, user),
      get: (id, user = users.owner) => getPurchaseOrder(db, id, user),
      list: (changes = {}, user = users.viewer) => listPurchaseOrders(db, { siteId: site.id, ...changes }, user),
      transition: (id, status, user = users.owner) => transitionPurchaseOrder(db, id, { status }, user),
      itemStatus: (id, status, user = users.owner) => transitionPurchaseOrderItem(db, id, { status }, user),
    };
  };

  await t.test('creates a header with two ordered items, updates allowed fields and preserves immutable fields', async t => {
    const f = await fixture(), order = await f.create({ poNo: ' PO-001 ', notes: ' Header note ', status: 'completed' }, users.editor);
    t.assert.strictEqual(order.status, 'open');
    t.assert.strictEqual(order.po_no, 'PO-001');
    t.assert.strictEqual(order.notes, 'Header note');
    const second = await f.add(order.id, { lineNo: 2, materialNo: ' MAT-2 ', unit: ' piece ' }, users.editor);
    const first = await f.add(order.id, { lineNo: 1, quantity: 999999999.999, wbsId: null });
    t.assert.strictEqual((await f.add(order.id)).line_no, 3);
    const detail = await f.get(order.id, users.viewer);
    t.assert.deepStrictEqual(detail.items.map(row => row.line_no), [1, 2, 3]);
    t.assert.strictEqual(detail.items[0].id, first.id);
    t.assert.strictEqual(detail.items[1].material_no, 'MAT-2');
    t.assert.strictEqual(detail.items[1].unit, 'piece');
    t.assert.strictEqual(Number(detail.items[1].quantity), 2.125);
    t.assert.strictEqual(detail.items[1].wbs_id, f.wbsId);
    t.assert.strictEqual(detail.items[1].status, 'open');
    t.assert.strictEqual(detail.ordered_on, '2026-01-15');
    const updated = await updatePurchaseOrder(db, order.id, { supplierName: 'Updated supplier', orderedOn: '2028-02-29',
      notes: null, poNo: 'IGNORED', siteId: randomUUID(), status: 'completed', closed_at: '2026-01-01' }, users.editor);
    t.assert.strictEqual(updated.supplier_name, 'Updated supplier');
    t.assert.strictEqual(updated.ordered_on, '2028-02-29');
    t.assert.strictEqual(updated.notes, null);
    t.assert.strictEqual(updated.po_no, order.po_no);
    t.assert.strictEqual(updated.site_id, order.site_id);
    t.assert.strictEqual(updated.status, 'open');
    t.assert.strictEqual(updated.closed_at, null);
    const item = await updatePurchaseOrderItem(db, second.id, { lineNo: 4, materialNo: null, description: ' Updated material ',
      unit: null, quantity: 4, wbsId: null, status: 'completed', purchase_order_id: randomUUID() }, users.editor);
    t.assert.deepStrictEqual([item.line_no, item.description, item.material_no, item.unit, Number(item.quantity), item.wbs_id],
      [4, 'Updated material', null, null, 4, null]);
    t.assert.strictEqual(item.status, 'open');
    t.assert.strictEqual(item.purchase_order_id, order.id);
  });

  await t.test('duplicate order and line numbers return 409 and roll back audit writes', async t => {
    const f = await fixture(), other = await fixture(), order = await f.create();
    await t.assert.rejects(() => f.create(), error(409, 'PO_DUPLICATE_NUMBER'));
    await other.create();
    const first = await f.add(order.id), second = await f.add(order.id);
    const before = await db.all('SELECT * FROM audit_events ORDER BY id');
    await t.assert.rejects(() => f.add(order.id, { lineNo: first.line_no }), error(409, 'PO_DUPLICATE_LINE'));
    await t.assert.rejects(() => updatePurchaseOrderItem(db, second.id, { lineNo: first.line_no }, users.owner), error(409, 'PO_DUPLICATE_LINE'));
    t.assert.deepStrictEqual(await db.all('SELECT * FROM audit_events ORDER BY id'), before);
    t.assert.strictEqual((await f.get(order.id)).items.length, 2);
  });

  await t.test('validates text, dates, quantities, line numbers and WBS site on create and update', async t => {
    const f = await fixture(), other = await fixture(), order = await f.create();
    for (const changes of [{ poNo: '' }, { poNo: 'x'.repeat(81) }, { supplierName: ' ' }, { supplierName: 'x'.repeat(201) },
      { orderedOn: '2026-02-29' }, { orderedOn: null }, { siteId: 'bad' }]) {
      await t.assert.rejects(() => f.create(changes), error(400));
    }
    const first = await f.add(order.id);
    for (const changes of [{ description: '' }, { description: 'x'.repeat(501) }, { unit: 'x'.repeat(21) },
      ...[0, -1, null, true, '', 'invalid', Infinity, NaN, 1000000000, 0.0001, '1.2345'].map(quantity => ({ quantity })),
      ...[0, -1, 1.5, '2', 2147483648].map(lineNo => ({ lineNo })), { wbsId: other.wbsId }, { wbsId: randomUUID() }, { wbsId: 'bad' }]) {
      await t.assert.rejects(() => f.add(order.id, changes), error(400));
      await t.assert.rejects(() => updatePurchaseOrderItem(db, first.id, changes, users.owner), error(400));
    }
    for (const changes of [{ supplierName: '' }, { orderedOn: '0000-01-01' }, { notes: 5 }]) {
      await t.assert.rejects(() => updatePurchaseOrder(db, order.id, changes, users.owner), error(400));
    }
    await t.assert.rejects(() => f.list({ status: 'invalid' }), error(400));
    await t.assert.rejects(() => f.get(randomUUID()), error(404, 'PO_NOT_FOUND'));
    await t.assert.rejects(() => f.get('bad'), error(404, 'PO_NOT_FOUND'));
    await t.assert.rejects(() => updatePurchaseOrderItem(db, randomUUID(), {}, users.owner), error(404, 'PO_ITEM_NOT_FOUND'));
    await t.assert.rejects(() => f.itemStatus(randomUUID(), 'completed'), error(404, 'PO_ITEM_NOT_FOUND'));
    for (const input of [null, [], 'invalid']) {
      await t.assert.rejects(() => createPurchaseOrder(db, input, users.owner), error(400));
      await t.assert.rejects(() => updatePurchaseOrder(db, order.id, input, users.owner), error(400));
      await t.assert.rejects(() => addPurchaseOrderItem(db, order.id, input, users.owner), error(400));
    }
  });

  await t.test('enforces authentication, membership, read roles and owner/editor write roles on all operations', async t => {
    const f = await fixture(), order = await f.create(), item = await f.add(order.id);
    const writes = user => [
      () => f.create({ poNo: 'PO-NEW' }, user), () => updatePurchaseOrder(db, order.id, { notes: 'Changed' }, user),
      () => f.transition(order.id, 'template_generated', user), () => f.add(order.id, {}, user),
      () => updatePurchaseOrderItem(db, item.id, { quantity: 3 }, user), () => f.itemStatus(item.id, 'in_execution', user),
    ];
    for (const role of ['owner', 'editor', 'verifier', 'viewer']) {
      t.assert.strictEqual((await f.get(order.id, users[role])).id, order.id);
      t.assert.strictEqual((await f.list({}, users[role])).length, 1);
    }
    for (const role of ['viewer', 'verifier']) for (const call of writes(users[role])) await t.assert.rejects(call, error(403, 'FORBIDDEN'));
    const restricted = await fixture({ roles: ['owner'] }), privateOrder = await restricted.create(), privateItem = await restricted.add(privateOrder.id);
    for (const call of [() => restricted.list({}, users.editor), () => restricted.get(privateOrder.id, users.editor),
      () => updatePurchaseOrderItem(db, privateItem.id, {}, users.editor)]) await t.assert.rejects(call, error(403, 'FORBIDDEN'));
    for (const call of [...writes(null), () => f.get(order.id, null), () => f.list({}, null)]) {
      await t.assert.rejects(call, error(401, 'UNAUTHENTICATED'));
    }
    for (const call of writes(users.editor)) await call();
  });

  await t.test('logistics requires an explicit grant for every non-owner and the access matrix agrees', async t => {
    const f = await fixture({ grants: false }), order = await f.create(), item = await f.add(order.id);
    for (const role of ['editor', 'verifier', 'viewer']) {
      t.assert.strictEqual(await moduleAllowed(db, f.site.id, users[role], 'logistics'), false);
      const matrix = await listModuleAccess(db, { siteId: f.site.id }, users[role]);
      t.assert.strictEqual(matrix.members.find(member => member.role === role).modules.logistics, false);
      await t.assert.rejects(() => f.list({}, users[role]), error(403, 'MODULE_FORBIDDEN'));
      await t.assert.rejects(() => f.get(order.id, users[role]), error(403, 'MODULE_FORBIDDEN'));
    }
    for (const call of [() => f.create({ poNo: 'DENIED' }, users.editor), () => updatePurchaseOrder(db, order.id, {}, users.editor),
      () => f.transition(order.id, 'template_generated', users.editor), () => f.add(order.id, {}, users.editor),
      () => updatePurchaseOrderItem(db, item.id, {}, users.editor), () => f.itemStatus(item.id, 'in_execution', users.editor)]) {
      await t.assert.rejects(call, error(403, 'MODULE_FORBIDDEN'));
    }
    await saveModuleAccess(db, { siteId: f.site.id, memberId: users.editor.id, module: 'logistics', allowed: true }, users.owner);
    t.assert.strictEqual((await f.get(order.id, users.editor)).id, order.id);
    await saveModuleAccess(db, { siteId: f.site.id, memberId: users.editor.id, module: 'logistics', allowed: false }, users.owner);
    await t.assert.rejects(() => f.list({}, users.editor), error(403, 'MODULE_FORBIDDEN'));
    await db.run("UPDATE site_members SET role = 'owner' WHERE site_id = ? AND user_id = ?", f.site.id, users.editor.id);
    t.assert.strictEqual(await moduleAllowed(db, f.site.id, users.editor, 'logistics'), true);
  });

  await t.test('item transitions set UTC dates, derive header states and reject final or out-of-order transitions', async t => {
    const f = await fixture(), order = await f.create(), first = await f.add(order.id), second = await f.add(order.id);
    const today = new Date().toISOString().slice(0, 10);
    await t.assert.rejects(() => f.itemStatus(first.id, 'completed'), error(409, 'PO_STATUS_CONFLICT'));
    const started = await f.itemStatus(first.id, 'in_execution');
    t.assert.strictEqual(started.execution_started_on, today);
    t.assert.strictEqual(started.completed_on, null);
    t.assert.strictEqual((await f.get(order.id)).status, 'in_execution');
    const completed = await f.itemStatus(first.id, 'completed');
    t.assert.strictEqual(completed.completed_on, today);
    t.assert.strictEqual(completed.execution_started_on, today);
    t.assert.strictEqual((await f.get(order.id)).status, 'open');
    const irrelevant = await f.itemStatus(second.id, 'not_relevant');
    t.assert.strictEqual(irrelevant.not_relevant_on, today);
    t.assert.strictEqual(irrelevant.execution_started_on, null);
    t.assert.strictEqual((await f.get(order.id)).status, 'completed');
    for (const item of [first, second]) for (const status of ['open', 'in_execution', 'completed', 'not_relevant']) {
      await t.assert.rejects(() => f.itemStatus(item.id, status), error(409, 'PO_STATUS_CONFLICT'));
    }
    const added = await f.add(order.id);
    t.assert.strictEqual((await f.get(order.id)).status, 'open');
    await f.itemStatus(added.id, 'in_execution');
    await f.itemStatus(added.id, 'completed');
    t.assert.strictEqual((await f.get(order.id)).status, 'completed');
  });

  await t.test('all irrelevant items derive not_relevant, including from in_execution', async t => {
    const f = await fixture(), order = await f.create(), first = await f.add(order.id), second = await f.add(order.id);
    await f.itemStatus(first.id, 'in_execution');
    await f.itemStatus(second.id, 'not_relevant');
    t.assert.strictEqual((await f.get(order.id)).status, 'in_execution');
    const row = await f.itemStatus(first.id, 'not_relevant');
    t.assert.ok(row.execution_started_on);
    t.assert.ok(row.not_relevant_on);
    t.assert.strictEqual(row.completed_on, null);
    t.assert.strictEqual((await f.get(order.id)).status, 'not_relevant');
  });

  await t.test('manual transitions enforce item prerequisites and preserve template_generated on unchanged open rollups', async t => {
    const f = await fixture(), order = await f.create(), item = await f.add(order.id);
    await f.transition(order.id, 'template_generated');
    await updatePurchaseOrderItem(db, item.id, { description: 'Changed material' }, users.owner);
    await f.add(order.id);
    t.assert.strictEqual((await f.get(order.id)).status, 'template_generated');
    for (const status of ['open', 'in_execution', 'completed', 'not_relevant', 'template_generated']) {
      await t.assert.rejects(() => f.transition(order.id, status), error(409, 'PO_STATUS_CONFLICT'));
    }
    await t.assert.rejects(() => f.transition(order.id, 'invalid'), error(400));
    await f.itemStatus(item.id, 'in_execution');
    await f.itemStatus(item.id, 'completed');
    t.assert.strictEqual((await f.get(order.id)).status, 'template_generated');
  });

  await t.test('manual closure retains its optional audit note', async t => {
    for (const status of ['completed', 'not_relevant']) {
      const f = await fixture(), order = await f.create();
      const closed = await transitionPurchaseOrder(db, order.id, { status, note: ' Manual closure note ' }, users.owner);
      t.assert.ok(closed.closed_at);
      await f.add(order.id);
      t.assert.strictEqual((await f.get(order.id)).status, status);
      const events = await listAuditEvents(db, { siteId: f.site.id, entityType: 'purchase_order', entityId: order.id }, users.owner);
      t.assert.ok(events.some(event => JSON.parse(event.changes).note === 'Manual closure note'));
    }
  });

  await t.test('manual closure persists through later item additions, edits and transitions without clearing closed_at', async t => {
    for (const status of ['completed', 'not_relevant']) {
      const f = await fixture(), order = await f.create();
      const closed = await f.transition(order.id, status);
      t.assert.ok(Number.isFinite(Date.parse(closed.closed_at)));
      const item = await f.add(order.id);
      await updatePurchaseOrderItem(db, item.id, { quantity: 5 }, users.owner);
      await f.itemStatus(item.id, 'in_execution');
      await f.itemStatus(item.id, 'completed');
      const after = await f.get(order.id);
      t.assert.strictEqual(after.status, status);
      t.assert.strictEqual(new Date(after.closed_at).toISOString(), new Date(closed.closed_at).toISOString());
      await t.assert.rejects(() => f.transition(order.id, 'open'), error(409, 'PO_STATUS_CONFLICT'));
    }
  });

  await t.test('writes scoped audit create, field update and status changes for headers and items', async t => {
    const f = await fixture(), order = await f.create({}, users.editor), item = await f.add(order.id, {}, users.editor);
    await updatePurchaseOrder(db, order.id, { notes: 'Audit note' }, users.editor);
    await updatePurchaseOrderItem(db, item.id, { quantity: 3 }, users.editor);
    await f.itemStatus(item.id, 'in_execution', users.editor);
    for (const [entityType, entityId] of [['purchase_order', order.id], ['purchase_order_item', item.id]]) {
      const events = await listAuditEvents(db, { siteId: f.site.id, entityType, entityId }, users.owner);
      t.assert.strictEqual(events.length, 3);
      t.assert.strictEqual(events.filter(row => row.action === 'create').length, 1);
      t.assert.strictEqual(events.filter(row => row.action === 'update').length, 2);
      t.assert.ok(events.every(row => row.site_id === f.site.id && row.actor === users.editor.id));
      const changes = events.map(row => JSON.parse(row.changes));
      t.assert.ok(changes.some(change => change.status?.from === 'open' && change.status?.to === 'in_execution'));
    }
  });

  await t.test('audit failures roll back item writes and header rollups together', async t => {
    const f = await fixture(), order = await f.create(), item = await f.add(order.id);
    const before = await f.get(order.id), audits = await db.all('SELECT * FROM audit_events ORDER BY id');
    for (const entityType of ['purchase_order', 'purchase_order_item']) {
      const failing = { transaction: fn => db.transaction(tx => fn({ ...tx, run: (sql, ...values) => {
        if (sql.startsWith('INSERT INTO audit_events') && values[2] === entityType) throw new Error('Synthetic audit failure');
        return tx.run(sql, ...values);
      } })) };
      await t.assert.rejects(() => transitionPurchaseOrderItem(failing, item.id, { status: 'in_execution' }, users.owner), /Synthetic audit failure/);
      t.assert.deepStrictEqual(await f.get(order.id), before);
      t.assert.deepStrictEqual(await db.all('SELECT * FROM audit_events ORDER BY id'), audits);
    }
  });

  await t.test('lists only the requested site and status', async t => {
    const f = await fixture(), other = await fixture(), open = await f.create(), closed = await f.create({ poNo: 'PO-002' });
    await f.transition(closed.id, 'completed');
    await other.create();
    t.assert.deepStrictEqual((await f.list({ status: 'open' })).map(row => row.id), [open.id]);
    t.assert.deepStrictEqual((await f.list({ status: 'completed' })).map(row => row.id), [closed.id]);
    t.assert.strictEqual((await f.list()).length, 2);
    t.assert.deepStrictEqual(await f.list({ status: 'not_relevant' }), []);
  });

  await t.test('migration enforces status, quantity, foreign keys, uniqueness, index and native column types', async t => {
    const f = await fixture(), order = await f.create(), item = await f.add(order.id);
    t.assert.strictEqual(await migrate(db, { driver }), 0);
    for (const [table, id] of [['purchase_orders', order.id], ['purchase_order_items', item.id]]) {
      await t.assert.rejects(() => db.run(`UPDATE ${table} SET status = 'invalid' WHERE id = ?`, id), /check/i);
    }
    await t.assert.rejects(() => db.run('UPDATE purchase_order_items SET quantity = 0 WHERE id = ?', item.id), /check/i);
    await t.assert.rejects(() => db.run('UPDATE purchase_orders SET site_id = ? WHERE id = ?', randomUUID(), order.id), /foreign key/i);
    for (const column of ['purchase_order_id', 'wbs_id']) {
      await t.assert.rejects(() => db.run(`UPDATE purchase_order_items SET ${column} = ? WHERE id = ?`, randomUUID(), item.id), /foreign key/i);
    }
    if (driver === 'sqlite') {
      t.assert.deepStrictEqual((await db.all('PRAGMA index_info(purchase_orders_site_status)')).map(row => row.name), ['site_id', 'status']);
    } else {
      const index = await db.get("SELECT indexdef FROM pg_indexes WHERE indexname = 'purchase_orders_site_status'");
      t.assert.match(index.indexdef, /\(site_id, status\)/);
      const columns = await db.all("SELECT column_name, udt_name, numeric_precision, numeric_scale FROM information_schema.columns WHERE table_name = 'purchase_order_items'");
      for (const [name, type] of [['id', 'uuid'], ['purchase_order_id', 'uuid'], ['wbs_id', 'uuid'], ['quantity', 'numeric'],
        ['execution_started_on', 'date'], ['completed_on', 'date'], ['not_relevant_on', 'date'], ['created_at', 'timestamptz'], ['updated_at', 'timestamptz']]) {
        t.assert.strictEqual(columns.find(row => row.column_name === name).udt_name, type);
      }
      t.assert.strictEqual(columns.find(row => row.column_name === 'quantity').numeric_precision, 12);
      t.assert.strictEqual(columns.find(row => row.column_name === 'quantity').numeric_scale, 3);
    }
  });

  const httpFlows = async (t, api) => {
    const f = await fixture(), other = await fixture(), privateSite = await fixture({ roles: ['owner'] });
    const path = '/api/purchase-orders';
    const call = (url, method = 'GET', body, role = 'editor') => api(url, { method, body, cookie: role ? cookies[role] : undefined });
    const created = await call(path, 'POST', f.input);
    t.assert.strictEqual(created.status, 201);
    const url = `${path}/${created.body.id}`;
    t.assert.strictEqual((await call(`${path}?site_id=${f.site.id}`, 'GET', undefined, 'viewer')).body[0].id, created.body.id);
    t.assert.strictEqual((await call(url, 'PATCH', { notes: 'HTTP note' })).body.notes, 'HTTP note');
    t.assert.strictEqual((await call(`${url}/status`, 'POST', { status: 'template_generated' })).body.status, 'template_generated');
    const added = await call(`${url}/items`, 'POST', f.itemInput);
    t.assert.strictEqual(added.status, 201);
    const itemUrl = `${url}/items/${added.body.id}`;
    t.assert.strictEqual((await call(itemUrl, 'PATCH', { quantity: 3 })).status, 200);
    t.assert.strictEqual((await call(`${itemUrl}/status`, 'POST', { status: 'in_execution' })).body.status, 'in_execution');
    t.assert.strictEqual((await call(`${path}?site_id=${f.site.id}&status=in_execution`)).body.length, 1);
    t.assert.strictEqual((await call(url)).body.items[0].id, added.body.id);
    const otherOrder = await other.create(), foreign = await other.add(otherOrder.id), privateOrder = await privateSite.create();
    for (const [target, method, body, role, status, code] of [
      [path, 'POST', f.input, 'editor', 409, 'PO_DUPLICATE_NUMBER'],
      [`${url}/items`, 'POST', { ...f.itemInput, quantity: 0 }, 'editor', 400, 'VALIDATION_ERROR'],
      [`${url}/items`, 'POST', { ...f.itemInput, wbsId: other.wbsId }, 'editor', 400, 'VALIDATION_ERROR'],
      [`${url}/items/${foreign.id}`, 'PATCH', { quantity: 8 }, 'editor', 404, 'PO_ITEM_NOT_FOUND'],
      [`${url}/items/${foreign.id}/status`, 'POST', { status: 'in_execution' }, 'editor', 404, 'PO_ITEM_NOT_FOUND'],
      [`${path}/${privateOrder.id}`, 'GET', undefined, 'editor', 403, 'FORBIDDEN'],
      [url, 'PATCH', {}, 'viewer', 403, 'FORBIDDEN'],
      [`${url}/status`, 'POST', { status: 'completed' }, 'editor', 409, 'PO_STATUS_CONFLICT'],
      [`${path}/${randomUUID()}`, 'GET', undefined, 'editor', 404, 'PO_NOT_FOUND'],
    ]) {
      const response = await call(target, method, body, role);
      t.assert.strictEqual(response.status, status, `${method} ${target}`);
      t.assert.strictEqual(response.body.code, code);
      t.assert.strictEqual(typeof response.body.error, 'string');
    }
    const endpoints = [[path, 'POST', f.input], [`${path}?site_id=${f.site.id}`, 'GET'], [url, 'GET'], [url, 'PATCH', {}],
      [`${url}/status`, 'POST', { status: 'completed' }], [`${url}/items`, 'POST', f.itemInput],
      [itemUrl, 'PATCH', {}], [`${itemUrl}/status`, 'POST', { status: 'completed' }]];
    await saveModuleAccess(db, { siteId: f.site.id, memberId: users.editor.id, module: 'logistics', allowed: false }, users.owner);
    for (const [target, method, body] of endpoints) {
      const denied = await call(target, method, body);
      t.assert.strictEqual(denied.status, 403);
      t.assert.strictEqual(denied.body.code, 'MODULE_FORBIDDEN');
      const anonymous = await call(target, method, body, null);
      t.assert.strictEqual(anonymous.status, 401);
      t.assert.strictEqual(anonymous.body.code, 'AUTH_REQUIRED');
    }
    t.assert.strictEqual((await other.get(otherOrder.id)).items[0].quantity, foreign.quantity);
  };

  await t.test('HTTP listener covers all eight routes, envelopes, authentication, module gates and parent binding', async t => {
    await httpFlows(t, requestListener(createServer(db)));
  });

  if (driver === 'sqlite') await t.test('HTTP routes work over a real socket', async t => {
    const server = createServer(db);
    t.after(async () => {
      if (server.listening) await new Promise((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
        server.closeAllConnections();
      });
    });
    // Socket admission failures stay visible; the listener test is separate coverage.
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    await httpFlows(t, async (path, { method, body, cookie }) => {
      const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method,
        headers: { ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, body: await response.json() };
    });
  });
});

for (const driver of ['sqlite', 'pg']) test(`032 preserves populated audit history and constraints: ${driver}`, async t => {
  const db = await database(t, driver, false);
  await db.exec('CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  const files = (await readdir(new URL(`../server/migrations/${driver}/`, import.meta.url)))
    .filter(file => /^\d{3}_.*\.sql$/.test(file) && file < '032').sort();
  for (const file of files) await db.transaction(async tx => {
    await applyMigration(tx, file, { driver });
    await tx.run('INSERT INTO schema_migrations VALUES (?, ?)', file.slice(0, 3), new Date().toISOString());
  });
  const site = { id: randomUUID() };
  await db.run('INSERT INTO sites (id, code, name, created_at) VALUES (?, ?, ?, ?)',
    site.id, randomUUID(), 'Synthetic migration site', new Date().toISOString());
  const insertAudit = (entityType, action = 'create') => db.run(`INSERT INTO audit_events
    (id, site_id, entity_type, entity_id, action, at, actor, changes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  randomUUID(), site.id, entityType, randomUUID(), action, '2026-01-15T00:00:00.000Z', randomUUID(), '{}');
  for (const type of ['hse_event', 'certification', 'tool', 'site', 'hse_asset', 'hse_inspection']) await insertAudit(type);
  await insertAudit('hse_inspection', 'read');
  const before = await db.all('SELECT * FROM audit_events ORDER BY id');
  await t.assert.rejects(() => insertAudit('purchase_order'), /check/i);
  t.assert.strictEqual(await migrate(db, { driver }), 13);
  t.assert.deepStrictEqual(await db.all('SELECT * FROM audit_events ORDER BY id'), before);
  for (const type of ['purchase_order', 'purchase_order_item']) await insertAudit(type);
  await t.assert.rejects(() => insertAudit('invalid'), /check/i);
  await t.assert.rejects(() => insertAudit('purchase_order', 'invalid'), /check/i);
  t.assert.strictEqual(await migrate(db, { driver }), 0);
  t.assert.strictEqual(Number((await db.get('SELECT COUNT(*) AS total FROM audit_events')).total), 9);
  if (driver === 'sqlite') {
    t.assert.deepStrictEqual(await db.all('PRAGMA foreign_key_check'), []);
    t.assert.deepStrictEqual((await db.all('PRAGMA index_info(audit_events_site_entity)')).map(row => row.name),
      ['site_id', 'entity_type', 'entity_id', 'at', 'id']);
  } else {
    const index = await db.get("SELECT indexdef FROM pg_indexes WHERE indexname = 'audit_events_site_entity'");
    t.assert.match(index.indexdef, /\(site_id, entity_type, entity_id, at, id\)/);
  }
});
