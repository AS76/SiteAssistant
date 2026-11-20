import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createContext, runInContext } from 'node:vm';
import { createApi } from '../app/api.mjs';
import { corePermissions, formatDisplayNumber, formatDateInput, parseDateInput, initialView, navGroups, validDate, visibleModules } from '../app/domain.mjs';
import { messages } from '../app/i18n.mjs';

const source = await readFile(new URL('../app/app.mjs', import.meta.url), 'utf8');
const fragment = (start, end) => {
  const from = source.indexOf(start), to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, start);
  return source.slice(from, to);
};
const plain = value => JSON.parse(JSON.stringify(value));
const statuses = ['open', 'template_generated', 'in_execution', 'completed', 'not_relevant'];
const item = { id: 'item-1', purchaseOrderId: 'po-1', lineNo: 2, materialNo: 'MAT-002', description: '<b>Synthetic item</b>',
  unit: 'm', quantity: '1.125', wbsId: 'wbs-1', status: 'in_execution', executionStartedOn: '2026-11-12', completedOn: null };
const order = { id: 'po-1', siteId: 'site-1', poNo: 'PO-002', supplierName: '<Supplier Alpha>', orderedOn: '2026-11-12',
  status: 'in_execution', notes: '<script>Synthetic note</script>', closedAt: null,
  items: [item, { ...item, id: 'item-2', lineNo: 1, materialNo: null, quantity: '0.001', wbsId: null, status: 'completed', completedOn: '2026-11-13' }] };

function purchaseUi({ role = 'editor', granted = true, language = 'it', storedView = null, storageDisabled = false } = {}) {
  const orders = [structuredClone(order), { ...structuredClone(order), id: 'po-2', poNo: 'PO-001', supplierName: 'Supplier Beta', orderedOn: '2026-11-11', items: [] },
    { ...structuredClone(order), id: 'po-3', poNo: 'PO-001', status: 'open', items: [] }];
  const packages = [
    { id: 'pkg-1', siteId: 'site-1', purchaseOrderId: 'po-1', packageNo: 'PKG-001', status: 'open', notes: '<Package note>', closedAt: null, createdAt: '2026-11-14T09:01:02.000Z',
      items: [{ id: 'packed-1', purchaseOrderItemId: 'item-1', quantityPacked: '0.100', description: '<Snapshot description>', unit: 'm' }] },
    { id: 'pkg-2', siteId: 'site-1', purchaseOrderId: 'po-1', packageNo: 'PKG-002', status: 'closed', notes: null, closedAt: '2026-11-14T10:00:00.000Z', createdAt: '2026-11-14T09:30:00.000Z',
      items: [{ id: 'packed-2', purchaseOrderItemId: 'item-1', quantityPacked: '0.025', description: 'Snapshot', unit: 'm' }] },
    { id: 'pkg-3', siteId: 'site-1', purchaseOrderId: 'po-2', packageNo: 'PKG-003', status: 'open', items: [], createdAt: '2026-11-14T11:00:00.000Z' },
  ];
  const shipments = [
    { id: 'shp-1', siteId: 'site-1', shipmentNo: 'SHP-001', carrier: '<Carrier Alpha>', shippedOn: '2026-11-15', expectedOn: '2026-11-18', arrivedOn: null,
      status: 'planned', notes: '<Shipment note>', packages: [packages[0]],
      receipts: [{ id: 'receipt-1', purchaseOrderItemId: 'item-1', quantityReceived: '0.025', note: '<Receipt note>', createdAt: '2026-11-15T09:12:34.000Z' }] },
    { id: 'shp-2', siteId: 'site-1', shipmentNo: 'SHP-002', carrier: null, shippedOn: null, expectedOn: null, arrivedOn: '2026-11-14', status: 'received', notes: null,
      packages: [packages[1]], receipts: [{ id: 'receipt-2', purchaseOrderItemId: 'item-2', quantityReceived: '0', note: null, createdAt: '2026-11-14T10:00:00.000Z' }] },
  ];
  const storage = new Map([['sa-logistics-view', storedView]]);
  const nodes = [{ id: 'wbs-1', site_id: 'site-1', wbs_code: 'A.01', description: '<Synthetic WBS>' },
    { id: 'foreign-wbs', site_id: 'site-2', wbs_code: 'FOREIGN', description: 'Other site' }];
  const calls = [], dialogs = [], notifications = [], cache = new Map([
    ['shipments', { data: shipments.map(({ packages, receipts, ...row }) => row) }], ...shipments.map(row => [`shipment:${row.id}`, { data: row }]),
    ['purchaseOrders', { data: orders }], ['packages', { data: packages }], ...packages.map(row => [`package:${row.id}`, { data: row }]), ['wbs', { data: nodes }], ...orders.map(row => [`purchaseOrder:${row.id}`, { data: row }]),
  ]);
  const modal = { open: false, classList: { add() {} } };
  const context = createContext({
    siteId: 'site-1', session: { user: { id: 'user-1' }, roles: [{ site_id: 'site-1', role }] },
    state: { memberAccess: { 'site-1': { members: [{ user_id: 'user-1', modules: { logistics: granted, wbs: true } }] } } },
    sessionStorage: { getItem: key => { if (storageDisabled) throw new Error('disabled'); return storage.get(key); }, setItem: (key, value) => { if (storageDisabled) throw new Error('disabled'); storage.set(key, value); } },
    language, offline: false, navigator: { onLine: true }, modalVersion: 0, purchaseOrderDetailId: '',
    coreFilters: { logistics: { status: '', supplier: '' } }, coreCache: new Map([['site-1', cache]]),
    messages, corePermissions, visibleModules, validDate, formatDisplayNumber, formatDateInput, parseDateInput,
    t: key => messages[context.language][key] ?? key,
    empty: (key, hint) => `<p>${messages[context.language][key]}</p><p>${messages[context.language][hint]}</p>`,
    $: () => modal,
    showModal: (title, html) => { context.modalVersion++; modal.open = true; dialogs.push({ title, html }); },
    closeModal: () => { context.modalVersion++; modal.open = false; calls.push({ method: 'close' }); },
    toast: message => notifications.push(message), render: () => calls.push({ method: 'render' }),
    freshApi: {
      listShipments: async input => { calls.push({ method: 'listShipments', input: plain(input) }); return structuredClone(shipments.map(({ packages, receipts, ...row }) => row)); },
      getShipment: async id => { calls.push({ method: 'getShipment', id }); return structuredClone(shipments.find(row => row.id === id)); },
      listPackages: async input => { calls.push({ method: 'listPackages', input: plain(input) }); return structuredClone(packages.filter(row => !input.purchaseOrderId || row.purchaseOrderId === input.purchaseOrderId)); },
      getPackage: async id => { calls.push({ method: 'getPackage', id }); return structuredClone(packages.find(row => row.id === id)); },
      listPurchaseOrders: async () => structuredClone(orders),
      getPurchaseOrder: async id => { calls.push({ method: 'get', id }); return structuredClone(orders.find(row => row.id === id)); } },
    api: Object.fromEntries(['createPurchaseOrder', 'updatePurchaseOrder', 'transitionPurchaseOrder', 'addPurchaseOrderItem', 'updatePurchaseOrderItem', 'transitionPurchaseOrderItem'].map(method => [method, async (...args) => {
      calls.push({ method, args: plain(args) }); return { ...order, id: method === 'createPurchaseOrder' ? 'po-new' : args[0] };
    }])),
  });
  context.api.createShipment = async input => { calls.push({ method: 'createShipment', args: plain([input]) }); return { ...shipments[0], id: 'shp-new' }; };
  context.api.transitionShipment = async (...args) => { calls.push({ method: 'transitionShipment', args: plain(args) }); return { ...shipments[0], status: args[1] }; };
  context.api.addShipmentReceipt = async (...args) => { calls.push({ method: 'addShipmentReceipt', args: plain(args) }); return { id: 'receipt-new', ...args[1] }; };
  context.api.createPackage = async input => { calls.push({ method: 'createPackage', args: plain([input]) }); return { ...packages[0], id: 'pkg-new', purchaseOrderId: input.purchaseOrderId }; };
  context.api.closePackage = async id => { calls.push({ method: 'closePackage', args: [id] }); return { ...packages.find(row => row.id === id), status: 'closed' }; };
  context.coreResource = (name, loader) => {
    const current = context.coreCache.get(context.siteId);
    if (current.has(name)) return current.get(name);
    const entry = { pending: true }; current.set(name, entry);
    entry.promise = (loader ? loader() : context.freshApi[name === 'shipments' ? 'listShipments' : 'listPackages']({ siteId: context.siteId })).then(data => { entry.data = data; }, error => { entry.error = error; }).finally(() => { entry.pending = false; });
    return entry;
  };
  for (const [start, end] of [
    ['let packageDetailId =', 'let reconciliationFilter ='],
    ['const esc =', '\nlet session'], ['const dateLabel =', 'const paths ='], ['const button =', 'function toast('],
    ['const errorKeys =', 'function clearSession('], ['const role =', 'const moduleResources ='],
    ['const coreData =', 'const employeeLabel ='], ['function coreSelect(', 'const coreDetailButton'],
    ['function field(', 'function formError('], ['const PURCHASE_ORDER_STATUSES =', 'function renderTools('],
  ]) runInContext(fragment(start, end), context);
  return { context, cache, calls, dialogs, notifications, orders, nodes, packages, shipments, storage,
    run: code => runInContext(code, context),
    form: (id, poId = 'po-1', itemId = '') => ({ id, dataset: { site: 'site-1', user: 'user-1', id: poId, itemId } }),
  };
}

test('logistics route is in Management and requires an explicit non-owner grant', () => {
  assert.equal(initialView({ width: 390, hash: '#logistics' }), 'logistics');
  for (const grant of [true, 1]) assert.ok(navGroups({ logistics: grant }).find(group => group.label === 'navManagement').items.includes('logistics'));
  for (const grant of [undefined, false, 0, 'true']) assert.deepEqual(visibleModules(['logistics'], { logistics: grant }), []);
  assert.equal(purchaseUi({ role: 'owner', granted: false }).run("moduleVisible('logistics')"), true);
  assert.equal(purchaseUi({ granted: false }).run("moduleVisible('logistics')"), false);
});

test('owner access panel exposes logistics grants with an unchecked default for other members', () => {
  const ui = purchaseUi({ role: 'owner' });
  const main = { innerHTML: '', insertAdjacentHTML(_position, html) { this.innerHTML += html; } };
  ui.context.$ = () => main;
  ui.context.heading = () => ''; ui.context.canCreateSite = () => false; ui.context.navGroups = navGroups;
  ui.context.state.sites = []; ui.context.state.tasks = [];
  ui.context.state.memberAccess['site-1'].members = [{ user_id: 'member-2', name: 'Synthetic member', email: 'member@example.invalid', role: 'viewer', modules: {} }];
  runInContext(fragment('function renderSites()', 'function filteredTasks()'), ui.context);
  ui.run('renderSites()');
  assert.match(main.innerHTML, /data-module="logistics"/);
  assert.doesNotMatch(main.innerHTML.match(/<input[^>]*data-module="logistics"[^>]*>/)[0], /checked/);
  ui.context.state.memberAccess['site-1'].members[0].modules.logistics = true;
  ui.run('renderSites()');
  assert.match(main.innerHTML.match(/<input[^>]*data-module="logistics"[^>]*>/)[0], /checked/);
});

test('core loader fetches purchase orders for the current site and refreshes custom detail resources', async () => {
  const ui = purchaseUi(); ui.context.coreCache.clear();
  ui.context.view = 'logistics'; ui.context.moduleResources = { logistics: ['purchaseOrders'] };
  ui.context.rememberTodayResource = () => {};
  ui.context.freshApi.listPurchaseOrders = async input => { ui.calls.push({ method: 'list', input: plain(input) }); return ui.orders; };
  runInContext(fragment('function coreResource(', 'const coreData ='), ui.context);
  const resource = ui.run("coreResource('purchaseOrders')"); await resource.promise;
  assert.equal(resource.pending, false); assert.equal(resource.data.length, 3);
  assert.deepEqual(ui.calls.find(call => call.method === 'list').input, { siteId: 'site-1' });
  const before = ui.calls.filter(call => call.method === 'render').length;
  const detail = ui.run("purchaseOrderResource('po-1')"); await detail.promise;
  assert.equal(detail.data.id, 'po-1');
  assert.equal(ui.calls.filter(call => call.method === 'render').length, before + 1);
});

test('list renders sorted rows, all five status options, supplier filter and exact quantity totals', () => {
  const ui = purchaseUi(), html = ui.run('renderPurchaseOrders()');
  assert.match(html, /data-core-filter="supplier"/);
  for (const status of statuses) assert.match(html, new RegExp(`option value="${status}"`));
  assert.match(html, /&lt;Supplier Alpha&gt;/);
  assert.match(html, /1,126/);
  assert.ok(html.indexOf('data-id="po-3"') < html.indexOf('data-id="po-1"'));
  assert.ok(html.indexOf('data-id="po-1"') < html.indexOf('data-id="po-2"'));
  assert.match(html, /<tr data-command="po-open" data-id="po-1"/);
  assert.match(html, /data-command="po-edit"/);
  ui.run("coreFilters.logistics.supplier = 'ALPHA'");
  const filtered = ui.run('renderPurchaseOrders()');
  assert.doesNotMatch(filtered, /data-id="po-2"/);
  ui.run("coreFilters.logistics.status = 'open'");
  assert.doesNotMatch(ui.run('renderPurchaseOrders()'), /data-id="po-1"/);
  ui.run("coreFilters.logistics.supplier = 'absent'");
  assert.ok(ui.run('renderPurchaseOrders()').includes(messages.it.poEmpty));
  assert.equal(ui.orders[0].id, 'po-1');
});

test('missing aggregate details are loaded fresh and never displayed as zero', async () => {
  const ui = purchaseUi(); ui.cache.delete('purchaseOrder:po-1');
  assert.ok(ui.run('renderPurchaseOrders()').includes(messages.it.loading));
  assert.ok(ui.calls.some(call => call.method === 'get' && call.id === 'po-1'));
  await ui.cache.get('purchaseOrder:po-1').promise;
  assert.match(ui.run('renderPurchaseOrders()'), /1,126/);
  ui.cache.set('purchaseOrder:po-1', { error: new Error('Synthetic failure') });
  assert.ok(ui.run('renderPurchaseOrders()').includes(messages.it.poTotalsUnavailable));
});

test('detail renders header, notes, localized dates, sorted items, statuses and current-site WBS codes', () => {
  const ui = purchaseUi(); ui.orders[0].closedAt = '2026-11-14T09:01:02.000Z';
  ui.run("purchaseOrderDetailId = 'po-1'");
  const html = ui.run('renderPurchaseOrders()');
  for (const text of ['PO-002', '&lt;Supplier Alpha&gt;', ui.run("dateLabel('2026-11-12')"), ui.run("dateLabel('2026-11-14')"), '&lt;script&gt;Synthetic note&lt;/script&gt;', 'MAT-002', '&lt;b&gt;Synthetic item&lt;/b&gt;', 'A.01', ui.run("dateLabel('2026-11-13')"), '1,125']) assert.ok(html.includes(text), text);
  assert.doesNotMatch(html, /<script>|<b>Synthetic/);
  assert.ok(html.indexOf('0,001') < html.indexOf('1,125'));
  assert.match(html, /data-command="po-item-new"/);
  assert.match(html, /data-command="po-item-edit" data-id="po-1" data-item-id="item-1"/);
  assert.match(html, /data-command="po-transition" data-id="po-1" data-item-id="item-1"/);
  ui.run("purchaseOrderDetailId = 'po-2'");
  assert.ok(ui.run('renderPurchaseOrders()').includes(messages.it.poItemsEmpty));
});

test('viewer and verifier can read but cannot see or invoke write forms or submit writes', async () => {
  for (const role of ['viewer', 'verifier']) {
    const ui = purchaseUi({ role });
    assert.doesNotMatch(ui.run('renderPurchaseOrders()'), /data-command="po-(edit|new)"/);
    ui.run("purchaseOrderDetailId = 'po-1'");
    assert.match(ui.run('renderPurchaseOrders()'), /MAT-002/);
    assert.doesNotMatch(ui.run('renderPurchaseOrders()'), /data-command="po-(edit|item-new|item-edit|transition)"/);
    for (const call of ["showPurchaseOrderForm()", "showPurchaseOrderItemForm('po-1')", "showPurchaseOrderTransition('po-1', 'item-1')"]) await ui.run(call);
    assert.equal(ui.dialogs.length, 0);
    ui.context.form = ui.form('po-form', ''); ui.context.data = {};
    await assert.rejects(() => ui.run('submitPurchaseOrder(form, data)'), /forbidden/);
    assert.equal(ui.calls.length, 0);
  }
});

test('no module grant blocks reads and writes; owner bypasses the grant', async () => {
  const ui = purchaseUi({ granted: false });
  assert.ok(ui.run('renderPurchaseOrders()').includes(messages.it.moduleUnavailable));
  await ui.run("showPurchaseOrderForm('po-1')");
  assert.equal(ui.dialogs.length, 0); assert.equal(ui.calls.length, 0);
  const owner = purchaseUi({ role: 'owner', granted: false });
  await owner.run('showPurchaseOrderForm()');
  assert.match(owner.dialogs.at(-1).html, /id="po-form"/);
});

test('header and item transition lists exhaustively match server rules, including empty orders and final states', () => {
  const ui = purchaseUi();
  for (const state of statuses) for (const closedAt of [null, '2026-11-14T00:00:00Z']) {
    for (const items of [[], ...statuses.filter(status => status !== 'template_generated').map(status => [{ status }]), [{ status: 'completed' }, { status: 'not_relevant' }], [{ status: 'completed' }, { status: 'open' }]]) {
      ui.context.order = { status: state, closedAt, items };
      const expected = statuses.filter(target => closedAt === null && ['open', 'template_generated', 'in_execution'].includes(state) &&
        (target === 'template_generated' ? state === 'open' : target === 'completed' ? items.every(item => ['completed', 'not_relevant'].includes(item.status)) : target === 'not_relevant' && items.every(item => item.status === 'not_relevant')));
      assert.deepEqual(plain(ui.run('purchaseOrderTransitions(order)')), expected);
    }
    ui.context.item = { status: state };
    assert.deepEqual(plain(ui.run('purchaseOrderItemTransitions(item)')), state === 'open' ? ['in_execution', 'not_relevant'] : state === 'in_execution' ? ['completed', 'not_relevant'] : []);
  }
});

test('forms expose editable contract fields, preserve nulls and restrict WBS to the current site', async () => {
  const ui = purchaseUi();
  await ui.run('showPurchaseOrderForm()');
  assert.match(ui.dialogs.at(-1).html, /name="poNo"[^>]*required/);
  assert.match(ui.dialogs.at(-1).html, /name="orderedOn"[^>]*required/);
  await ui.run("showPurchaseOrderForm('po-1')");
  assert.doesNotMatch(ui.dialogs.at(-1).html, /name="poNo"/);
  assert.match(ui.dialogs.at(-1).html, /&lt;script&gt;Synthetic note&lt;\/script&gt;/);
  await ui.run("showPurchaseOrderItemForm('po-1', 'item-1')");
  const html = ui.dialogs.at(-1).html;
  assert.match(html, /name="quantity"[^>]*step="0.001"[^>]*value="1.125"/);
  assert.match(html, /option value="wbs-1" selected/);
  assert.doesNotMatch(html, /FOREIGN|foreign-wbs/);
  assert.match(html, /&lt;Synthetic WBS&gt;/);
  ui.cache.set('wbs', { error: new Error('Synthetic WBS failure') });
  await ui.run("showPurchaseOrderItemForm('po-1', 'item-1')");
  assert.doesNotMatch(ui.dialogs.at(-1).html, /name="wbsId"/);
  assert.ok(ui.dialogs.at(-1).html.includes(messages.it.poWbsUnavailable));
});

test('status dialog fetches current details and offers only allowed transitions with confirmation', async () => {
  const ui = purchaseUi();
  await ui.run("showPurchaseOrderTransition('po-1', 'item-1')");
  const html = ui.dialogs.at(-1).html;
  assert.match(html, /option value="completed"/); assert.match(html, /option value="not_relevant"/);
  assert.doesNotMatch(html, /option value="(open|template_generated|in_execution)"/);
  assert.ok(html.includes(messages.it.poTransitionConfirm));
  await ui.run("showPurchaseOrderTransition('po-1')");
  assert.ok(ui.dialogs.at(-1).html.includes(messages.it.noTransitions));
  assert.ok(ui.calls.some(call => call.method === 'get' && call.id === 'po-1'));
});

test('create, header edit, add/edit item and status commands call the client with the right ids and refresh caches', async () => {
  const cases = [
    ['po-form', '', '', { poNo: 'PO-004', supplierName: 'Synthetic supplier', orderedOn: '2026-11-15', notes: '' }, 'createPurchaseOrder', [{ siteId: 'site-1', poNo: 'PO-004', supplierName: 'Synthetic supplier', orderedOn: '2026-11-15', notes: null }]],
    ['po-form', 'po-1', '', { supplierName: 'Updated supplier', orderedOn: '2026-11-15', notes: '' }, 'updatePurchaseOrder', ['po-1', { supplierName: 'Updated supplier', orderedOn: '2026-11-15', notes: null }]],
    ...['', 'item-1'].map(itemId => ['po-item-form', 'po-1', itemId, { lineNo: '3', materialNo: '', description: 'Synthetic line', unit: '', quantity: '2.125', wbsId: '' }, itemId ? 'updatePurchaseOrderItem' : 'addPurchaseOrderItem', ['po-1', ...(itemId ? [itemId] : []), { lineNo: 3, materialNo: null, description: 'Synthetic line', unit: null, quantity: '2.125', wbsId: null }]]),
    ['po-status-form', 'po-1', '', { status: 'template_generated' }, 'transitionPurchaseOrder', ['po-1', 'template_generated']],
    ['po-status-form', 'po-1', 'item-1', { status: 'completed' }, 'transitionPurchaseOrderItem', ['po-1', 'item-1', 'completed']],
  ];
  for (const [kind, id, itemId, data, method, args] of cases) {
    const ui = purchaseUi(); ui.context.form = ui.form(kind, id, itemId); ui.context.data = data;
    await ui.run('submitPurchaseOrder(form, data)');
    assert.deepEqual(ui.calls.find(call => call.method === method)?.args, args, method);
    assert.equal(ui.cache.has('purchaseOrders'), false);
    assert.equal(ui.cache.has(`purchaseOrder:${id || 'po-new'}`), false);
    assert.equal(ui.context.purchaseOrderDetailId, id || 'po-new');
    assert.ok(ui.notifications.includes(messages.it.poSaved));
  }
});

test('validation rejects invalid dates, quantities, line numbers and foreign WBS without API writes', async () => {
  for (const data of [{ supplierName: ' ', orderedOn: '2026-11-15', poNo: 'PO-003' }, { supplierName: 'Supplier', orderedOn: '2026-02-30', poNo: 'PO-003' }]) {
    const ui = purchaseUi(); ui.context.form = ui.form('po-form', ''); ui.context.data = data;
    await assert.rejects(() => ui.run('submitPurchaseOrder(form, data)'), /poHeaderInvalid/); assert.equal(ui.calls.length, 0);
  }
  for (const change of [{ quantity: '0' }, { quantity: '-1' }, { quantity: '1.1234' }, { quantity: '1000000000' }, { lineNo: '1.2' }, { lineNo: '0' }, { description: ' ' }, { wbsId: 'foreign-wbs' }]) {
    const ui = purchaseUi(); ui.context.form = ui.form('po-item-form');
    ui.context.data = { lineNo: '1', description: 'Synthetic line', materialNo: '', unit: '', quantity: '1.125', wbsId: '', ...change };
    await assert.rejects(() => ui.run('submitPurchaseOrder(form, data)'), /po(QuantityValidation|ItemInvalid|WbsUnavailable)/); assert.equal(ui.calls.length, 0);
  }
});

test('conflicting header or item transitions display a clear message and reload fresh detail', async () => {
  for (const itemId of ['', 'item-1']) {
    const ui = purchaseUi(); ui.context.form = ui.form('po-status-form', 'po-1', itemId); ui.context.data = { status: 'completed' };
    ui.context.api[itemId ? 'transitionPurchaseOrderItem' : 'transitionPurchaseOrder'] = async () => { throw Object.assign(new Error('Synthetic conflict'), { code: 'PO_STATUS_CONFLICT' }); };
    await ui.run('submitPurchaseOrder(form, data)');
    assert.ok(ui.notifications.includes(messages.it.poStatusConflict));
    assert.equal(ui.cache.has('purchaseOrder:po-1'), false); assert.equal(ui.cache.has('purchaseOrders'), false);
    assert.equal(ui.context.purchaseOrderDetailId, 'po-1');
    ui.run('renderPurchaseOrders()'); await ui.cache.get('purchaseOrder:po-1').promise;
    assert.ok(ui.calls.some(call => call.method === 'get' && call.id === 'po-1'));
  }
});

test('offline and stale site/user contexts cannot write or replace a newer modal', async () => {
  for (const change of [ui => { ui.context.offline = true; }, ui => { ui.context.siteId = 'site-2'; }, ui => { ui.context.form.dataset.user = 'other-user'; }]) {
    const ui = purchaseUi(); ui.context.form = ui.form('po-status-form'); ui.context.data = { status: 'completed' }; change(ui);
    await assert.rejects(() => ui.run('submitPurchaseOrder(form, data)'), /coreOnlineOnly|forbidden/); assert.equal(ui.calls.length, 0);
  }
  const ui = purchaseUi(); let release;
  ui.context.freshApi.getPurchaseOrder = () => new Promise(resolve => { release = resolve; });
  const pending = ui.run("showPurchaseOrderForm('po-1')");
  ui.context.modalVersion++; release(order); await pending;
  assert.equal(ui.dialogs.length, 1); assert.ok(ui.dialogs[0].html.includes(messages.it.loading));
});

test('API client maps all eight routes, contract body fields, response items and fresh reads', async () => {
  const requests = [], raw = { id: 'po-1', site_id: 'site-1', po_no: 'PO-001', supplier_name: 'Supplier', ordered_on: '2026-11-15', notes: null,
    items: [{ id: 'item-1', line_no: 1, material_no: null, wbs_id: null, execution_started_on: null, quantity: '1.125' }] };
  const api = createApi({ baseUrl: 'https://api.example.invalid', fresh: true, fetchImpl: async (url, options) => {
    requests.push({ url, options }); return Response.json(url.includes('?') ? [raw] : url.includes('/items') ? raw.items[0] : raw);
  } });
  const rows = await api.listPurchaseOrders({ siteId: 'site /&', status: 'open' });
  assert.equal(rows[0].poNo, 'PO-001'); assert.equal(rows[0].supplierName, 'Supplier');
  const detail = await api.getPurchaseOrder('po /&');
  assert.equal(detail.items[0].lineNo, 1); assert.equal(detail.items[0].wbsId, null); assert.equal(detail.items[0].executionStartedOn, null);
  await api.createPurchaseOrder({ siteId: 'site-1', poNo: 'PO-001', supplierName: 'Supplier', orderedOn: '2026-11-15', notes: null, ignored: true });
  await api.updatePurchaseOrder('po /&', { supplier_name: 'Changed', notes: null, poNo: 'Immutable', siteId: 'other' });
  await api.transitionPurchaseOrder('po /&', 'template_generated');
  await api.addPurchaseOrderItem('po /&', { lineNo: 1, materialNo: null, description: 'Synthetic item', unit: 'm', quantity: '1.125', wbsId: null });
  await api.updatePurchaseOrderItem('po /&', 'item /&', { quantity: '2.001', wbs_id: null });
  await api.transitionPurchaseOrderItem('po /&', 'item /&', 'completed');
  assert.deepEqual(requests.map(row => [row.url.replace('https://api.example.invalid', ''), row.options.method || 'GET']), [
    ['/api/purchase-orders?site_id=site+%2F%26&status=open', 'GET'], ['/api/purchase-orders/po%20%2F%26', 'GET'],
    ['/api/purchase-orders', 'POST'], ['/api/purchase-orders/po%20%2F%26', 'PATCH'], ['/api/purchase-orders/po%20%2F%26/status', 'POST'],
    ['/api/purchase-orders/po%20%2F%26/items', 'POST'], ['/api/purchase-orders/po%20%2F%26/items/item%20%2F%26', 'PATCH'], ['/api/purchase-orders/po%20%2F%26/items/item%20%2F%26/status', 'POST'],
  ]);
  assert.equal(requests[0].options.cache, 'reload'); assert.equal(requests[1].options.cache, 'reload');
  assert.deepEqual(requests.slice(2).map(row => JSON.parse(row.options.body)), [
    { siteId: 'site-1', poNo: 'PO-001', supplierName: 'Supplier', orderedOn: '2026-11-15', notes: null },
    { supplierName: 'Changed', notes: null }, { status: 'template_generated' },
    { lineNo: 1, materialNo: null, description: 'Synthetic item', unit: 'm', quantity: '1.125', wbsId: null },
    { quantity: '2.001', wbsId: null }, { status: 'completed' },
  ]);
  const denied = createApi({ fetchImpl: async () => Response.json({ error: 'Synthetic conflict', code: 'PO_STATUS_CONFLICT' }, { status: 409 }) });
  await assert.rejects(() => denied.transitionPurchaseOrder('po-1', 'completed'), { status: 409, code: 'PO_STATUS_CONFLICT' });
});

test('Italian and English keys have parity and all purchase-order labels resolve in both languages', () => {
  assert.deepEqual(Object.keys(messages.it).sort(), Object.keys(messages.en).sort());
  const keys = Object.keys(messages.it).filter(key => /^po[A-Z_]/.test(key));
  keys.push('logistics', 'logisticsSub', ...statuses.map(status => `poStatus_${status}`));
  assert.ok(keys.length > 40);
  for (const language of ['it', 'en']) for (const key of keys) assert.ok(messages[language][key], `${language}.${key}`);
});

test('application wires logistics resources, renderer, controls and submit dispatch', () => {
  assert.match(source, /logistics: \['purchaseOrders', 'packages', 'shipments'\]/);
  assert.match(source, /purchaseOrders: \(\) => freshApi.listPurchaseOrders\(\{ siteId: selected \}\)/);
  assert.match(source, /logistics: \(\) => logisticsView === 'shipments' \? renderShipments\(\) : logisticsView === 'packages' \? renderPackages\(\) : renderPurchaseOrders\(\)/);
  assert.match(source, /logistics: renderCore/);
  assert.match(source, /view === 'logistics' && purchaseOrderCanWrite\(\) \? button\(logisticsView === 'shipments' \? 'shpNew' : logisticsView === 'packages' \? 'pkgNew' : 'poNew'/);
  for (const command of ['po-new', 'po-open', 'po-edit', 'po-item-new', 'po-item-edit', 'po-transition', 'po-back']) assert.ok(source.includes(`'${command}':`));
  assert.match(source, /\['po-form', 'po-item-form', 'po-status-form'\]\.includes\(form.id\)\) \{ await submitPurchaseOrder\(form, data\)/);
});

function packageForm(ui, quantities = ['0.250', '']) {
  const inputs = quantities.map((value, index) => ({ value, dataset: { packageItem: `item-${index + 1}`, ordered: index ? '0.001' : '1.125', packed: index ? '0' : '0.125' } }));
  ui.context.form = { ...ui.form('pkg-form'), isConnected: true, querySelectorAll: () => inputs };
  ui.context.data = { purchaseOrderId: 'po-1', packageNo: 'BOX-01', notes: 'Synthetic packing note' };
  return inputs;
}
function renderLogistics(ui) {
  const main = { innerHTML: '', insertAdjacentHTML(_position, html) { this.innerHTML += html; }, setAttribute() {} };
  ui.context.$ = selector => selector === '#main' ? main : null;
  Object.assign(ui.context, { view: 'logistics', columnFiltersOn: false, heading: (_title, _sub, actions) => actions,
    renderAuditPanel: () => '', enhanceCoreTables() {}, bindAuditPanel() {},
    moduleResources: { logistics: ['purchaseOrders', 'packages', 'shipments'] } });
  for (const name of ['renderDeviations', 'renderProgress', 'renderBookings', 'renderImpacts', 'renderTools', 'renderCertifications', 'renderHse', 'renderHseAssets', 'renderHseAssetDetail']) ui.context[name] = () => '';
  runInContext(fragment('function renderCore()', 'function auditEntityType()'), ui.context);
  ui.run('renderCore()');
  return main.innerHTML;
}

test('packages sub-view defaults safely, persists the selection and uses the HSE toggle pattern', () => {
  for (const storedView of [null, 'invalid', 'orders']) assert.equal(purchaseUi({ storedView }).run('logisticsView'), 'orders');
  const ui = purchaseUi({ storedView: 'packages' });
  assert.equal(ui.run('logisticsView'), 'packages');
  assert.match(ui.run('renderLogisticsViewToggle()'), /^<div class="logistics-tabs"><div class="view-toggle">/);
  assert.match(ui.run('renderLogisticsViewToggle()'), /class="selected"[^>]*data-command="logistics-view"[^>]*data-value="packages" aria-pressed="true"/);
  ui.run("selectLogisticsView('orders')");
  assert.equal(ui.storage.get('sa-logistics-view'), 'orders');
  ui.run("selectLogisticsView('packages')");
  assert.equal(ui.storage.get('sa-logistics-view'), 'packages');
  const disabled = purchaseUi({ storageDisabled: true });
  assert.equal(disabled.run('logisticsView'), 'orders');
  assert.doesNotThrow(() => disabled.run("selectLogisticsView('packages')"));
});

test('packages list shows its six columns, order choices, totals and combined filters', () => {
  const ui = purchaseUi(), html = ui.run('renderPackages()');
  for (const key of ['pkgNumber', 'pkgOrder', 'status', 'poLines', 'pkgQuantityPacked', 'pkgCreatedAt']) assert.ok(html.includes(messages.it[key]));
  assert.match(html, /data-core-filter="purchaseOrderId"/);
  assert.match(html, /option value="po-2"/);
  assert.match(html, /<tr data-command="pkg-open" data-id="pkg-1"/);
  assert.match(html, /0,1/); assert.ok(html.includes(ui.run("dateLabel('2026-11-14')"))); assert.doesNotMatch(html, /T09:01:02/);
  ui.run("packageFilters.status = 'closed'");
  assert.match(ui.run('renderPackages()'), /data-id="pkg-2"/);
  assert.doesNotMatch(ui.run('renderPackages()'), /data-id="pkg-1"/);
  ui.run("packageFilters.purchaseOrderId = 'po-2'");
  assert.ok(ui.run('renderPackages()').includes(messages.it.pkgEmpty));
  ui.run("packageFilters.status = ''");
  assert.match(ui.run('renderPackages()'), /data-id="pkg-3"/);
  assert.doesNotMatch(ui.run('renderPackages()'), /data-id="pkg-2"/);
  // Order filters remain independent of package filters.
  assert.equal(ui.run('coreFilters.logistics.status'), '');
});

test('packages aggregates load details and expose a retry instead of zero on failure', async () => {
  const ui = purchaseUi(); ui.cache.delete('package:pkg-1');
  assert.ok(ui.run('renderPackages()').includes(messages.it.loading));
  assert.ok(ui.calls.some(call => call.method === 'getPackage' && call.id === 'pkg-1'));
  await ui.cache.get('package:pkg-1').promise;
  assert.match(ui.run('renderPackages()'), /0,1/);
  ui.cache.set('package:pkg-1', { error: new Error('Synthetic failure') });
  assert.ok(ui.run('renderPackages()').includes(messages.it.poTotalsUnavailable));
  assert.match(ui.run('renderPackages()'), /data-command="pkg-detail-reload"/);
});

test('package detail uses snapshot text/unit and joins the order item line number', () => {
  const ui = purchaseUi(); ui.orders[0].items[0].description = 'Current order description'; ui.orders[0].items[0].unit = 'changed';
  ui.run("packageDetailId = 'pkg-1'");
  const html = ui.run('renderPackages()');
  for (const text of ['PKG-001', 'PO-002', '&lt;Package note&gt;', '&lt;Snapshot description&gt;', '0,1', '>2<', '>m<']) assert.ok(html.includes(text), text);
  assert.doesNotMatch(html, /Current order description|>changed<|<Snapshot/);
  assert.match(html, /data-command="pkg-close"/);
  ui.run("packageDetailId = 'pkg-2'");
  assert.ok(ui.run('renderPackages()').includes(ui.run("dateLabel('2026-11-14')")));
  assert.doesNotMatch(ui.run('renderPackages()'), /data-command="pkg-close"/);
  ui.cache.set('purchaseOrder:po-1', { error: new Error('Synthetic failure') });
  assert.ok(ui.run('renderPackages()').includes(messages.it.pkgOrderUnavailable));
  assert.match(ui.run('renderPackages()'), /data-command="po-detail-reload"/);
});

test('logistics renderer switches between orders and packages and exposes the matching create command', () => {
  const ui = purchaseUi();
  let html = renderLogistics(ui);
  assert.match(html, /data-command="logistics-view"/);
  assert.match(html, /data-command="po-new"/);
  ui.run("logisticsView = 'packages'"); html = renderLogistics(ui);
  assert.match(html, /data-command="pkg-new"/);
  assert.match(html, /data-command="pkg-open"/);
  assert.doesNotMatch(html, /data-command="po-new"/);
});

test('create package form allows order choice and optional fields, preselects an order and counts closed packages', async () => {
  const ui = purchaseUi();
  await ui.run('showPackageForm()');
  let html = ui.dialogs.at(-1).html;
  assert.match(html, /name="purchaseOrderId"[^>]*required/);
  assert.match(html, /name="packageNo"[^>]*maxlength="80"/);
  assert.match(html, /name="notes"/);
  await ui.run("showPackageForm('po-1')"); html = ui.dialogs.at(-1).html;
  assert.match(html, /option value="po-1" selected/);
  assert.match(html, /data-package-item="item-1" data-ordered="1.125" data-packed="0.125"/);
  assert.match(html, /step="0.001"/);
  for (const key of ['pkgOrderedQuantity', 'pkgAlreadyPacked', 'pkgPackingHint']) assert.ok(html.includes(messages.it[key]));
  assert.equal((html.match(/data-package-item=/g) || []).length, 2);
  assert.deepEqual(ui.calls.find(call => call.method === 'listPackages').input, { siteId: 'site-1', purchaseOrderId: 'po-1' });
  assert.match(ui.run('renderPurchaseOrderDetail(coreData("purchaseOrders")[0])'), /data-command="pkg-new" data-id="po-1"/);
});

test('create package sends only positive quantities and refreshes packages and the open order detail', async () => {
  const ui = purchaseUi(); packageForm(ui);
  ui.run("purchaseOrderDetailId = 'po-1'");
  ui.context.render = () => { ui.calls.push({ method: 'render' }); ui.run('renderPurchaseOrders()'); };
  await ui.run('submitPackage(form, data)');
  assert.deepEqual(ui.calls.find(call => call.method === 'createPackage').args[0], {
    siteId: 'site-1', purchaseOrderId: 'po-1', packageNo: 'BOX-01', notes: 'Synthetic packing note',
    items: [{ purchaseOrderItemId: 'item-1', quantityPacked: '0.250' }],
  });
  const detail = ui.cache.get('purchaseOrder:po-1');
  assert.ok(detail.promise); await detail.promise;
  assert.equal(detail.data.id, 'po-1');
  assert.ok(ui.calls.some(call => call.method === 'get' && call.id === 'po-1'));
  assert.equal(ui.cache.has('purchaseOrders'), false);
  assert.ok(ui.calls.some(call => call.method === 'listPackages'));
  assert.equal(ui.run('purchaseOrderDetailId'), 'po-1');
  assert.ok(ui.calls.some(call => call.method === 'render'));
});

test('blank package numbers are omitted for server numbering and blank notes become null', async () => {
  const ui = purchaseUi(); packageForm(ui, ['1.000', '0']);
  ui.context.data.packageNo = ' '; ui.context.data.notes = '';
  await ui.run('submitPackage(form, data)');
  const payload = ui.calls.find(call => call.method === 'createPackage').args[0];
  assert.equal(Object.hasOwn(payload, 'packageNo'), false); assert.equal(payload.notes, null);
  assert.equal(payload.items.length, 1);
});

test('client blocks over-packing, missing positive amounts and invalid quantities before API calls', async () => {
  for (const [values, error] of [[['1.001', ''], 'pkgQuantityExceeded'], [['', ''], 'pkgItemsRequired'], [['0', '0'], 'pkgItemsRequired'], [['-1', ''], 'poQuantityValidation'], [['0.0001', ''], 'poQuantityValidation'], [['1000000000', ''], 'poQuantityValidation']]) {
    const ui = purchaseUi(); packageForm(ui, values);
    await assert.rejects(() => ui.run('submitPackage(form, data)'), new RegExp(error));
    assert.equal(ui.calls.length, 0);
  }
  const ui = purchaseUi(); packageForm(ui); ui.context.data.purchaseOrderId = 'po-2';
  await assert.rejects(() => ui.run('submitPackage(form, data)'), /pkgChooseOrder/);
  assert.equal(ui.calls.length, 0);
});

test('packing arithmetic allows exact thousandth boundaries without floating point overages', async () => {
  const ui = purchaseUi(); const inputs = packageForm(ui, ['0.200', '']);
  inputs[0].dataset.ordered = '0.300'; inputs[0].dataset.packed = '0.100';
  await ui.run('submitPackage(form, data)');
  assert.equal(ui.calls.find(call => call.method === 'createPackage').args[0].items[0].quantityPacked, '0.200');
});

test('close requires confirmation and submit calls the close API, invalidates detail and refreshes the list', async () => {
  const ui = purchaseUi();
  await ui.run("showPackageClose('pkg-1')");
  assert.ok(ui.dialogs.at(-1).html.includes(messages.it.pkgCloseConfirm));
  assert.match(ui.dialogs.at(-1).html, /id="pkg-close-form"/);
  assert.ok(!ui.calls.some(call => call.method === 'closePackage'));
  ui.context.form = ui.form('pkg-close-form', 'pkg-1'); ui.context.data = {};
  await ui.run('submitPackage(form, data)');
  assert.deepEqual(ui.calls.find(call => call.method === 'closePackage').args, ['pkg-1']);
  assert.equal(ui.cache.has('package:pkg-1'), false);
  assert.ok(ui.calls.some(call => call.method === 'listPackages'));
  await ui.run("showPackageClose('pkg-2')");
  assert.ok(ui.dialogs.at(-1).html.includes(messages.it.pkgStatusConflict));
});

test('package server errors remain visible and translated, with no false success', async () => {
  for (const [code, key] of [['PACKAGE_QUANTITY_EXCEEDED', 'pkgQuantityExceeded'], ['PACKAGE_DUPLICATE_NUMBER', 'pkgDuplicateNumber'], ['PACKAGE_STATUS_CONFLICT', 'pkgStatusConflict']]) {
    const ui = purchaseUi(); packageForm(ui);
    const error = Object.assign(new Error('Synthetic conflict'), { status: 400, code });
    ui.context.api.createPackage = async () => { throw error; };
    await assert.rejects(() => ui.run('submitPackage(form, data)'), { code });
    ui.context.error = error;
    assert.equal(ui.run('errorMessage(error)'), messages.it[key]);
    assert.ok(!ui.calls.some(call => call.method === 'close'));
    assert.equal(ui.notifications.length, 0);
  }
});

test('package write commands and order create-package action are hidden for readers; direct writes are denied', async () => {
  for (const role of ['viewer', 'verifier']) {
    const ui = purchaseUi({ role, storedView: 'packages' });
    assert.doesNotMatch(renderLogistics(ui), /data-command="pkg-(new|close)"/);
    ui.run("packageDetailId = 'pkg-1'");
    assert.doesNotMatch(ui.run('renderPackages()'), /data-command="pkg-close"/);
    assert.doesNotMatch(ui.run('renderPurchaseOrderDetail(coreData("purchaseOrders")[0])'), /data-command="pkg-new"/);
    await ui.run("showPackageForm('po-1')"); await ui.run("showPackageClose('pkg-1')");
    assert.equal(ui.dialogs.length, 0);
    packageForm(ui); await assert.rejects(() => ui.run('submitPackage(form, data)'), /forbidden/);
    assert.equal(ui.calls.length, 0);
  }
  const denied = purchaseUi({ granted: false });
  assert.ok(denied.run('renderPackages()').includes(messages.it.moduleUnavailable));
  assert.equal(denied.calls.length, 0);
  assert.match(renderLogistics(purchaseUi({ role: 'owner', granted: false, storedView: 'packages' })), /data-command="pkg-new"/);
});

test('offline, changed site/user and stale modal cannot write or replace package dialogs', async () => {
  for (const change of ["offline = true", "siteId = 'site-2'", "session.user.id = 'user-2'"]) {
    const ui = purchaseUi(); packageForm(ui); ui.run(change);
    await assert.rejects(() => ui.run('submitPackage(form, data)'), /coreOnlineOnly|forbidden/);
    assert.equal(ui.calls.length, 0);
  }
  const ui = purchaseUi(); let resolve;
  ui.context.freshApi.listPurchaseOrders = () => new Promise(done => { resolve = done; });
  const pending = ui.run('showPackageForm()');
  ui.run('modalVersion++'); resolve(ui.orders); await pending;
  assert.equal(ui.dialogs.length, 1);
  assert.ok(ui.dialogs[0].html.includes(messages.it.loading));
});

test('changing the package order clears stale quantities and ignores out-of-order loads', async () => {
  const ui = purchaseUi(), rows = { innerHTML: '' }, submit = { disabled: false };
  const form = { ...ui.form('pkg-form'), isConnected: true, elements: { purchaseOrderId: { value: 'po-1' } },
    querySelector: selector => selector === '[data-package-rows]' ? rows : submit };
  ui.context.form = form;
  let resolve;
  ui.context.freshApi.getPurchaseOrder = id => id === 'po-1' ? new Promise(done => { resolve = done; }) : Promise.resolve(structuredClone(ui.orders[1]));
  const pending = ui.run('loadPackageOrder(form)');
  assert.equal(form.dataset.id, ''); assert.equal(submit.disabled, true);
  form.elements.purchaseOrderId.value = 'po-2';
  await ui.run('loadPackageOrder(form)');
  assert.equal(form.dataset.id, 'po-2'); assert.equal(submit.disabled, false);
  resolve(structuredClone(ui.orders[0])); await pending;
  assert.equal(form.dataset.id, 'po-2'); assert.doesNotMatch(rows.innerHTML, /data-package-item/);
});

test('packages API client maps four routes, encoded ids, fresh reads and exact camelCase payloads', async () => {
  const requests = [], raw = { id: 'pkg-1', site_id: 'site-1', purchase_order_id: 'po-1', package_no: 'PKG-001', closed_at: null,
    items: [{ purchase_order_item_id: 'item-1', quantity_packed: '0.125', description: 'Snapshot', unit: null }] };
  const api = createApi({ baseUrl: 'https://api.example.invalid', fresh: true, fetchImpl: async (url, options) => {
    requests.push({ url: url.replace('https://api.example.invalid', ''), options });
    return Response.json(url.includes('?') ? [raw] : raw);
  } });
  const list = await api.listPackages({ siteId: 'site /&', purchaseOrderId: 'po /&' });
  assert.equal(list[0].packageNo, 'PKG-001'); assert.equal(list[0].items[0].quantityPacked, '0.125');
  const detail = await api.getPackage('pkg /&');
  assert.equal(detail.purchaseOrderId, 'po-1'); assert.equal(detail.closedAt, null); assert.equal(detail.items[0].unit, null);
  await api.createPackage({ siteId: 'site-1', purchaseOrderId: 'po-1', packageNo: 'BOX-01', notes: null, ignored: true,
    items: [{ purchaseOrderItemId: 'item-1', quantityPacked: '0.125', description: 'Ignored' }] });
  await api.closePackage('pkg /&');
  assert.deepEqual(requests.map(row => [row.url, row.options.method || 'GET']), [
    ['/api/packages?site_id=site+%2F%26&purchase_order_id=po+%2F%26', 'GET'], ['/api/packages/pkg%20%2F%26', 'GET'],
    ['/api/packages', 'POST'], ['/api/packages/pkg%20%2F%26/close', 'POST'],
  ]);
  assert.equal(requests[0].options.cache, 'reload'); assert.equal(requests[1].options.cache, 'reload');
  assert.deepEqual(JSON.parse(requests[2].options.body), { siteId: 'site-1', purchaseOrderId: 'po-1', packageNo: 'BOX-01', notes: null,
    items: [{ purchaseOrderItemId: 'item-1', quantityPacked: '0.125' }] });
  assert.deepEqual(JSON.parse(requests[3].options.body), {});
  const denied = createApi({ fetchImpl: async () => Response.json({ code: 'PACKAGE_QUANTITY_EXCEEDED', error: 'Synthetic conflict' }, { status: 400 }) });
  await assert.rejects(() => denied.createPackage({ items: [] }), { code: 'PACKAGE_QUANTITY_EXCEEDED' });
});

test('packages labels and messages resolve in Italian and English with full key parity', async () => {
  assert.deepEqual(Object.keys(messages.it).sort(), Object.keys(messages.en).sort());
  const keys = Object.keys(messages.it).filter(key => key.startsWith('pkg') || key.startsWith('logistics'));
  assert.equal(keys.length, 31);
  for (const language of ['it', 'en']) {
    for (const key of keys) assert.ok(messages[language][key], `${language}.${key}`);
    const ui = purchaseUi({ language, storedView: 'packages' });
    assert.ok(renderLogistics(ui).includes(messages[language].pkgNew));
    await ui.run("showPackageForm('po-1')");
    assert.ok(ui.dialogs.at(-1).html.includes(messages[language].pkgAlreadyPacked));
    await ui.run("showPackageClose('pkg-1')");
    assert.ok(ui.dialogs.at(-1).html.includes(messages[language].pkgCloseConfirm));
  }
});

test('application wires packages loading, row/create/close commands, order change and form dispatch', () => {
  assert.ok(source.includes("packages: () => freshApi.listPackages({ siteId: selected })"));
  for (const command of ['logistics-view', 'pkg-new', 'pkg-open', 'pkg-back', 'pkg-close', 'pkg-order-reload', 'pkg-detail-reload']) assert.ok(source.includes(`'${command}':`));
  assert.ok(source.includes("['pkg-form', 'pkg-close-form'].includes(form.id)) { await submitPackage(form, data)"));
  assert.ok(source.includes("event.target.matches('#pkg-form [name=purchaseOrderId]')"));
  assert.ok(source.includes("packageFilters[event.target.dataset.coreFilter] = event.target.value"));
});

function shipmentForm(ui, kind = 'shp-form') {
  ui.context.form = { ...ui.form(kind, kind === 'shp-form' ? '' : 'shp-1'), querySelectorAll: () => [{ value: 'pkg-3' }] };
  ui.context.data = { shipmentNo: ' SHP-003 ', carrier: 'Carrier Beta', shippedOn: '2026-11-15', expectedOn: '2026-11-20', notes: 'Synthetic shipping note' };
}

test('three-way logistics selector persists every selection, restores shipments and tolerates unavailable storage', () => {
  const ui = purchaseUi({ storedView: 'shipments' });
  assert.equal(ui.run('logisticsView'), 'shipments');
  for (const value of ['orders', 'packages', 'shipments']) {
    ui.run(`selectLogisticsView('${value}')`);
    assert.equal(ui.storage.get('sa-logistics-view'), value);
    assert.equal(purchaseUi({ storedView: ui.storage.get('sa-logistics-view') }).run('logisticsView'), value);
    const html = ui.run('renderLogisticsViewToggle()');
    assert.equal((html.match(/data-command="logistics-view"/g) || []).length, 3);
    assert.match(html, new RegExp(`data-value="${value}" aria-pressed="true"`));
  }
  ui.run("selectLogisticsView('invalid')"); assert.equal(ui.storage.get('sa-logistics-view'), 'orders');
  const disabled = purchaseUi({ storageDisabled: true });
  assert.doesNotThrow(() => disabled.run("selectLogisticsView('shipments')"));
  assert.equal(disabled.run('logisticsView'), 'shipments');
});

test('shipments renderer loads fresh site headers and displays seven columns, package counts and independent status filtering', async () => {
  const ui = purchaseUi({ storedView: 'shipments' });
  let html = renderLogistics(ui);
  assert.match(html, /data-command="shp-new"/);
  assert.doesNotMatch(html, /data-command="pkg-new"|data-command="po-new"/);
  assert.equal((html.match(/<th scope="col">/g) || []).length, 7);
  for (const status of ['planned', 'in_transit', 'arrived', 'received']) assert.ok(html.includes(`option value="${status}"`));
  assert.match(html, /<tr data-command="shp-open" data-id="shp-1"/);
  assert.match(html, /&lt;Carrier Alpha&gt;/);
  for (const date of ['2026-11-15', '2026-11-18', '2026-11-14']) assert.ok(html.includes(ui.run(`dateLabel('${date}')`)));
  assert.match(html, /data-label="Pacchi"><span class="mono">1<\/span>/);
  ui.run("shipmentFilters.status = 'received'"); html = ui.run('renderShipments()');
  assert.match(html, /data-id="shp-2"/); assert.doesNotMatch(html, /data-id="shp-1"/);
  assert.equal(ui.run('packageFilters.status'), ''); assert.equal(ui.run('coreFilters.logistics.status'), '');
  ui.run("shipmentFilters.status = 'arrived'"); assert.ok(ui.run('renderShipments()').includes(messages.it.shpEmpty));
  ui.cache.delete('shipments'); ui.context.rememberTodayResource = () => {};
  runInContext(fragment('function coreResource(', 'const coreData ='), ui.context);
  await ui.run("coreResource('shipments')").promise;
  assert.deepEqual(ui.calls.find(call => call.method === 'listShipments').input, { siteId: 'site-1' });
});

test('shipment counts and package quantities load detail resources and show retry on failed reads', async () => {
  const ui = purchaseUi(); ui.cache.delete('shipment:shp-1');
  assert.ok(ui.run('renderShipments()').includes(messages.it.loading));
  await ui.cache.get('shipment:shp-1').promise;
  assert.ok(ui.calls.some(call => call.method === 'getShipment' && call.id === 'shp-1'));
  ui.cache.set('shipment:shp-1', { error: new Error('Synthetic read failure') });
  assert.match(ui.run('renderShipments()'), /data-command="shp-detail-reload" data-id="shp-1"/);
  ui.run("shipmentDetailId = 'shp-1'");
  assert.match(ui.run('renderShipments()'), /role="alert"/);
  ui.cache.set('shipment:shp-1', { data: ui.shipments[0] }); ui.cache.delete('package:pkg-1');
  assert.ok(ui.run('renderShipments()').includes(messages.it.loading));
  await ui.cache.get('package:pkg-1').promise;
  assert.match(ui.run('renderShipments()'), /0,1/);
  ui.cache.set('package:pkg-1', { error: new Error('Synthetic read failure') });
  assert.match(ui.run('renderShipments()'), /data-command="pkg-detail-reload"/);
});

test('shipment detail renders header, package order/status/packed total, receipt line and date-only timestamps with escaped text', () => {
  const ui = purchaseUi(); ui.run("shipmentDetailId = 'shp-1'");
  const html = ui.run('renderShipments()');
  for (const text of ['SHP-001', '&lt;Carrier Alpha&gt;', '&lt;Shipment note&gt;', ui.run("dateLabel('2026-11-18')"), 'PKG-001', 'PO-002', '0,1', '0,025', `${messages.it.poLineNo} 2`, '&lt;b&gt;Synthetic item&lt;/b&gt;', '&lt;Receipt note&gt;', ui.run("dateLabel('2026-11-15')")]) assert.ok(html.includes(text), text);
  assert.doesNotMatch(html, /T09:12:34/);
  assert.doesNotMatch(html, /<Shipment note>|<Receipt note>|<b>Synthetic/);
  for (const command of ['shp-back', 'shp-transition', 'shp-receipt']) assert.ok(html.includes(`data-command="${command}"`));
  ui.cache.set('purchaseOrder:po-1', { error: new Error('Synthetic order failure') });
  assert.match(ui.run('renderShipments()'), /data-command="po-detail-reload"/);
  ui.shipments[0].siteId = 'site-2';
  assert.ok(ui.run('renderShipments()').includes(messages.it.forbidden));
});

test('create shipment modal offers optional carrier/dates/notes and only site packages absent from all shipments', async () => {
  const ui = purchaseUi(); ui.run("shipmentFilters.status = 'planned'");
  await ui.run('showShipmentForm()');
  const html = ui.dialogs.at(-1).html;
  assert.match(html, /name="shipmentNo"[^>]*required[^>]*maxlength="80"/);
  for (const name of ['carrier', 'shippedOn', 'expectedOn', 'notes']) {
    const input = html.match(new RegExp(`<(?:input|textarea)[^>]*name="${name}"[^>]*>`))[0];
    assert.doesNotMatch(input, /required/);
  }
  assert.match(html, /type="checkbox" name="packageIds" value="pkg-3"/);
  assert.doesNotMatch(html, /value="pkg-1"|value="pkg-2"/);
  assert.deepEqual(ui.calls.find(call => call.method === 'listShipments').input, { siteId: 'site-1' });
  assert.equal(ui.calls.filter(call => call.method === 'getShipment').length, 2);
  ui.shipments[0].packages.push(ui.packages[2]);
  await ui.run('showShipmentForm()');
  assert.ok(ui.dialogs.at(-1).html.includes(messages.it.shpNoPackages));
  assert.doesNotMatch(ui.dialogs.at(-1).html, /id="shp-form"/);
});

test('create shipment sends package ids and camelCase header fields then refreshes shipments and packages', async () => {
  const ui = purchaseUi(); shipmentForm(ui);
  await ui.run('submitShipment(form, data)');
  assert.deepEqual(ui.calls.find(call => call.method === 'createShipment').args[0], {
    siteId: 'site-1', shipmentNo: 'SHP-003', carrier: 'Carrier Beta', shippedOn: '2026-11-15', expectedOn: '2026-11-20', notes: 'Synthetic shipping note', packageIds: ['pkg-3'],
  });
  for (const method of ['listShipments', 'listPackages', 'close', 'render']) assert.ok(ui.calls.some(call => call.method === method), method);
  assert.ok(ui.notifications.includes(messages.it.shpSaved));
  assert.equal(ui.run('shipmentDetailId'), '');
  const blank = purchaseUi(); shipmentForm(blank);
  Object.assign(blank.context.data, { carrier: ' ', shippedOn: '', expectedOn: '', notes: '' });
  await blank.run('submitShipment(form, data)');
  const input = blank.calls.find(call => call.method === 'createShipment').args[0];
  for (const key of ['carrier', 'shippedOn', 'expectedOn', 'notes']) assert.equal(input[key], null);
});

test('shipment creation rejects an empty package selection, blank number and invalid date before writing', async () => {
  for (const [change, error] of [[ui => { ui.context.form.querySelectorAll = () => []; }, 'shpPackagesRequired'],
    [ui => { ui.context.data.shipmentNo = ' '; }, 'shpNumberRequired'],
    [ui => { ui.context.data.expectedOn = '2026-02-30'; }, 'invalidDate']]) {
    const ui = purchaseUi(); shipmentForm(ui); change(ui);
    await assert.rejects(() => ui.run('submitShipment(form, data)'), new RegExp(error));
    assert.ok(!ui.calls.some(call => call.method === 'createShipment'));
  }
});

test('shipment transitions confirm and call each consecutive status, with receipt prerequisite and terminal-state handling', async () => {
  for (const [status, next] of [['planned', 'in_transit'], ['in_transit', 'arrived'], ['arrived', 'received']]) {
    const ui = purchaseUi(); ui.shipments[0].status = status;
    await ui.run("showShipmentTransition('shp-1')");
    const html = ui.dialogs.at(-1).html;
    assert.match(html, new RegExp(`option value="${next}"`));
    assert.equal((html.match(/<option /g) || []).length, 1);
    assert.ok(html.includes(messages.it.shpTransitionConfirm));
    assert.ok(!ui.calls.some(call => call.method === 'transitionShipment'));
    shipmentForm(ui, 'shp-status-form'); ui.context.data = { status: next, note: 'Synthetic status note' };
    await ui.run('submitShipment(form, data)');
    assert.deepEqual(ui.calls.find(call => call.method === 'transitionShipment').args, ['shp-1', next, 'Synthetic status note']);
    assert.equal(ui.cache.has('shipment:shp-1'), false);
  }
  const ui = purchaseUi(); ui.shipments[0].status = 'arrived'; ui.shipments[0].receipts = [];
  ui.run("shipmentDetailId = 'shp-1'");
  assert.doesNotMatch(ui.run('renderShipments()'), /data-command="shp-transition"/);
  assert.ok(ui.run('renderShipments()').includes(messages.it.shpReceiptRequired));
  await ui.run("showShipmentTransition('shp-1')");
  assert.doesNotMatch(ui.dialogs.at(-1).html, /id="shp-status-form"/);
  ui.shipments[0].status = 'received';
  await ui.run("showShipmentTransition('shp-1')");
  assert.ok(ui.dialogs.at(-1).html.includes(messages.it.noTransitions));
});

test('receipt modal selects only packed lines from shipment packages', async () => {
  const ui = purchaseUi();
  ui.orders[1].items = [{ ...item, id: 'foreign-item', purchaseOrderId: 'po-2' }];
  await ui.run("showShipmentReceipt('shp-1')");
  const html = ui.dialogs.at(-1).html;
  assert.match(html, /option value="item-1"/); assert.doesNotMatch(html, /option value="item-2"/);
  assert.doesNotMatch(html, /foreign-item|PO-001/);
  assert.match(html, /name="quantityReceived" required min="0" max="999999999.999" step="0.001"/);
  assert.match(html, /&lt;b&gt;Synthetic item&lt;\/b&gt;/);
  assert.deepEqual(ui.calls.filter(call => call.method === 'get').map(call => call.id), ['po-1']);
  assert.deepEqual(ui.calls.filter(call => call.method === 'getPackage').map(call => call.id), ['pkg-1']);
});

test('receipt submit accepts zero and fractional quantities and invalidates detail without advancing shipment status', async () => {
  for (const quantity of ['0', '0.000', '1.125', '999999999.999']) {
    const ui = purchaseUi(); shipmentForm(ui, 'shp-receipt-form');
    ui.context.data = { purchaseOrderItemId: 'item-1', quantityReceived: quantity, note: '' };
    await ui.run('submitShipment(form, data)');
    assert.deepEqual(ui.calls.find(call => call.method === 'addShipmentReceipt').args, ['shp-1', { purchaseOrderItemId: 'item-1', quantityReceived: quantity, note: null }]);
    assert.equal(ui.cache.has('shipment:shp-1'), false);
    assert.ok(!ui.calls.some(call => call.method === 'transitionShipment'));
  }
  const ui = purchaseUi(); shipmentForm(ui, 'shp-receipt-form');
  ui.context.data = { purchaseOrderItemId: 'item-1', quantityReceived: '0.250', note: 'Synthetic delivery note' };
  await ui.run('submitShipment(form, data)');
  assert.equal(ui.calls.find(call => call.method === 'addShipmentReceipt').args[1].note, 'Synthetic delivery note');
});

test('receipt submission rejects missing items, negative, blank, excessive and over-precise quantities', async () => {
  for (const quantity of ['', '-1', 'NaN', 'Infinity', '1e2', '0.0001', '1000000000']) {
    const ui = purchaseUi(); shipmentForm(ui, 'shp-receipt-form');
    ui.context.data = { purchaseOrderItemId: 'item-1', quantityReceived: quantity, note: '' };
    await assert.rejects(() => ui.run('submitShipment(form, data)'), /shpQuantityValidation/);
    assert.ok(!ui.calls.some(call => call.method === 'addShipmentReceipt'));
  }
  const ui = purchaseUi(); shipmentForm(ui, 'shp-receipt-form'); ui.context.data.purchaseOrderItemId = '';
  await assert.rejects(() => ui.run('submitShipment(form, data)'), /shpChooseItem/);
});

test('shipment write commands are hidden and direct writes denied for module viewers and verifiers', async () => {
  for (const role of ['viewer', 'verifier']) {
    const ui = purchaseUi({ role, storedView: 'shipments' });
    assert.match(renderLogistics(ui), /SHP-001/);
    assert.doesNotMatch(renderLogistics(ui), /data-command="shp-new"/);
    ui.run("shipmentDetailId = 'shp-1'");
    const html = ui.run('renderShipments()');
    assert.match(html, /PKG-001/); assert.doesNotMatch(html, /data-command="shp-transition"|data-command="shp-receipt"/);
    await ui.run("showShipmentForm()"); await ui.run("showShipmentTransition('shp-1')"); await ui.run("showShipmentReceipt('shp-1')");
    assert.equal(ui.dialogs.length, 0);
    for (const kind of ['shp-form', 'shp-status-form', 'shp-receipt-form']) {
      shipmentForm(ui, kind); await assert.rejects(() => ui.run('submitShipment(form, data)'), /forbidden/);
    }
    assert.ok(!ui.calls.some(call => ['createShipment', 'transitionShipment', 'addShipmentReceipt'].includes(call.method)));
  }
  const denied = purchaseUi({ granted: false });
  assert.ok(denied.run('renderShipments()').includes(messages.it.moduleUnavailable));
  for (const role of ['owner', 'editor']) assert.match(renderLogistics(purchaseUi({ role, storedView: 'shipments' })), /data-command="shp-new"/);
});

test('shipment forms guard offline and stale site/user contexts and ignore outdated dialog loads', async () => {
  for (const change of ['offline = true', "siteId = 'site-2'", "session.user.id = 'user-2'"]) {
    const ui = purchaseUi(); shipmentForm(ui); ui.run(change);
    await assert.rejects(() => ui.run('submitShipment(form, data)'), /coreOnlineOnly|forbidden/);
    assert.ok(!ui.calls.some(call => call.method === 'createShipment'));
  }
  const ui = purchaseUi(); let resolve;
  ui.context.freshApi.listShipments = () => new Promise(done => { resolve = done; });
  const pending = ui.run('showShipmentForm()');
  ui.run("showModal('Other dialog', 'Synthetic content')"); resolve([]); await pending;
  assert.equal(ui.dialogs.at(-1).title, 'Other dialog');
});

test('shipment conflicts stay visible and translate without false success or modal closure', async () => {
  for (const [method, kind, code, key] of [
    ['createShipment', 'shp-form', 'SHIPMENT_PACKAGE_TAKEN', 'shpPackageTaken'],
    ['createShipment', 'shp-form', 'SHIPMENT_DUPLICATE_NUMBER', 'shpDuplicateNumber'],
    ['transitionShipment', 'shp-status-form', 'SHIPMENT_STATUS_CONFLICT', 'shpStatusConflict'],
    ['addShipmentReceipt', 'shp-receipt-form', 'SHIPMENT_ITEM_NOT_FOUND', 'shpItemNotFound'],
  ]) {
    const ui = purchaseUi(); shipmentForm(ui, kind);
    Object.assign(ui.context.data, { status: 'arrived', purchaseOrderItemId: 'item-1', quantityReceived: '0' });
    const error = Object.assign(new Error('Synthetic conflict'), { code });
    ui.context.api[method] = async () => { throw error; };
    await assert.rejects(() => ui.run('submitShipment(form, data)'), { code });
    ui.context.failure = error;
    assert.equal(ui.run('errorMessage(failure)'), messages.it[key]);
    assert.ok(!ui.calls.some(call => call.method === 'close')); assert.equal(ui.notifications.length, 0);
  }
});

test('shipments API maps all five routes, snake_case queries, nested responses, nulls and exact camelCase bodies', async () => {
  const requests = [], raw = { id: 'shp-1', site_id: 'site-1', shipment_no: 'SHP-001', shipped_on: null, expected_on: '2026-11-20', arrived_on: null,
    packages: [{ id: 'pkg-1', package_no: 'PKG-001', purchase_order_id: 'po-1' }],
    receipts: [{ purchase_order_item_id: 'item-1', quantity_received: '0.000', note: null, created_at: '2026-11-15T10:01:02.000Z' }] };
  const api = createApi({ baseUrl: 'https://api.example.invalid', fresh: true, fetchImpl: async (url, options) => {
    requests.push({ url: url.replace('https://api.example.invalid', ''), options });
    return Response.json(url.includes('?') ? [raw] : url.endsWith('/receipts') ? raw.receipts[0] : raw);
  } });
  const list = await api.listShipments({ siteId: 'site /&', status: 'in_transit' });
  assert.equal(list[0].shipmentNo, 'SHP-001');
  const detail = await api.getShipment('shp /&');
  assert.equal(detail.shippedOn, null); assert.equal(detail.arrivedOn, null);
  assert.equal(detail.packages[0].purchaseOrderId, 'po-1'); assert.equal(detail.packages[0].packageNo, 'PKG-001');
  assert.equal(detail.receipts[0].quantityReceived, '0.000'); assert.equal(detail.receipts[0].createdAt, raw.receipts[0].created_at);
  await api.createShipment({ siteId: 'site-1', shipmentNo: 'SHP-001', carrier: null, shippedOn: null, expectedOn: '2026-11-20', notes: null, packageIds: ['pkg-1', 'pkg-2'], ignored: true });
  await api.transitionShipment('shp /&', 'in_transit', 'Synthetic note');
  const receipt = await api.addShipmentReceipt('shp /&', { purchaseOrderItemId: 'item-1', quantityReceived: '0.000', note: null, ignored: true });
  assert.equal(receipt.purchaseOrderItemId, 'item-1'); assert.equal(receipt.note, null);
  assert.deepEqual(requests.map(row => [row.url, row.options.method || 'GET']), [
    ['/api/shipments?site_id=site+%2F%26&status=in_transit', 'GET'], ['/api/shipments/shp%20%2F%26', 'GET'],
    ['/api/shipments', 'POST'], ['/api/shipments/shp%20%2F%26/status', 'POST'], ['/api/shipments/shp%20%2F%26/receipts', 'POST'],
  ]);
  assert.ok(requests.slice(0, 2).every(row => row.options.cache === 'reload'));
  assert.deepEqual(requests.slice(2).map(row => JSON.parse(row.options.body)), [
    { siteId: 'site-1', shipmentNo: 'SHP-001', carrier: null, shippedOn: null, expectedOn: '2026-11-20', notes: null, packageIds: ['pkg-1', 'pkg-2'] },
    { status: 'in_transit', note: 'Synthetic note' }, { purchaseOrderItemId: 'item-1', quantityReceived: '0.000', note: null },
  ]);
  const denied = createApi({ fetchImpl: async () => Response.json({ error: 'Synthetic conflict', code: 'SHIPMENT_STATUS_CONFLICT' }, { status: 409 }) });
  await assert.rejects(() => denied.transitionShipment('shp-1', 'received'), { status: 409, code: 'SHIPMENT_STATUS_CONFLICT' });
});

test('shipments IT/EN labels, statuses, forms and all messages have parity and resolve in both languages', async () => {
  assert.deepEqual(Object.keys(messages.it).sort(), Object.keys(messages.en).sort());
  const keys = Object.keys(messages.it).filter(key => key.startsWith('shp') || key === 'logisticsShipments');
  assert.equal(keys.length, 36);
  for (const language of ['it', 'en']) {
    for (const key of keys) assert.ok(messages[language][key], `${language}.${key}`);
    const ui = purchaseUi({ language, storedView: 'shipments' });
    assert.ok(renderLogistics(ui).includes(messages[language].shpNew));
    ui.run("shipmentDetailId = 'shp-1'");
    assert.ok(ui.run('renderShipments()').includes(messages[language].shpReceipts));
    await ui.run('showShipmentForm()'); assert.ok(ui.dialogs.at(-1).html.includes(messages[language].shpChoosePackages));
    await ui.run("showShipmentTransition('shp-1')"); assert.ok(ui.dialogs.at(-1).html.includes(messages[language].shpStatus_in_transit));
    await ui.run("showShipmentReceipt('shp-1')"); assert.ok(ui.dialogs.at(-1).html.includes(messages[language].shpQuantityValidation));
    const rendered = ui.dialogs.map(row => row.html).join('') + ui.run('renderShipments()');
    assert.doesNotMatch(rendered, />shp[A-Z_][^<]*</);
  }
});

test('application wires shipment resources, commands, filters and all three form dispatch paths', () => {
  assert.ok(source.includes("shipments: () => freshApi.listShipments({ siteId: selected })"));
  for (const command of ['shp-new', 'shp-open', 'shp-back', 'shp-transition', 'shp-receipt', 'shp-detail-reload']) assert.ok(source.includes(`'${command}':`));
  assert.ok(source.includes("['shp-form', 'shp-status-form', 'shp-receipt-form'].includes(form.id)) { await submitShipment(form, data)"));
  assert.ok(source.includes('shipmentFilters[event.target.dataset.coreFilter] = event.target.value'));
  assert.ok(source.includes("shipmentDetailId = ''; shipmentFilters = { status: '' }"));
});

test('received shipment hides receipt action and refuses a stale receipt dialog', async () => {
  const ui = purchaseUi();
  ui.run("shipmentDetailId = 'shp-2'");
  assert.doesNotMatch(ui.run('renderShipments()'), /data-command="shp-receipt"/);
  await ui.run("showShipmentReceipt('shp-2')");
  assert.doesNotMatch(ui.dialogs.at(-1).html, /id="shp-receipt-form"/);
  assert.ok(ui.dialogs.at(-1).html.includes(messages.it.shpStatusConflict));
});

test('logistics read-only dates use the UI language and retain unknown and invalid behavior', () => {
  for (const language of ['it', 'en']) {
    const ui = purchaseUi({ language });
    const expected = ui.run("dateLabel('2026-11-12')");
    assert.equal(ui.run("coreDate('2026-11-12T10:00:00.000Z')"), expected);
    for (const value of [null, undefined, '']) {
      ui.context.dateValue = value;
      assert.equal(ui.run('coreDate(dateValue)'), messages[language].coreUnknown);
    }
    assert.equal(ui.run("coreDate('invalid')"), messages[language].noDue);
    assert.ok(ui.run('renderPurchaseOrders()').includes(expected));
    ui.run("purchaseOrderDetailId = 'po-1'");
    const orderHtml = ui.run('renderPurchaseOrders()');
    assert.ok(orderHtml.includes(expected));
    assert.doesNotMatch(orderHtml, />2026-11-1[23]</);
    ui.run("packageDetailId = 'pkg-2'");
    assert.ok(ui.run('renderPackages()').includes(ui.run("dateLabel('2026-11-14')")));
    const shipments = ui.run('renderShipments()');
    assert.ok(shipments.includes(ui.run("dateLabel('2026-11-18')")));
    ui.run("shipmentDetailId = 'shp-1'");
    assert.ok(ui.run('renderShipments()').includes(ui.run("dateLabel('2026-11-18')")));
  }
});
