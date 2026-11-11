import test from 'node:test';
import assert from 'node:assert/strict';
import { corePermissions, navGroups, HSE_TYPES, HSE_SEVERITIES, filterHseEvents, hseCounts } from '../app/domain.mjs';
import { HSE_TYPES as SERVER_TYPES, HSE_SEVERITIES as SERVER_SEVERITIES } from '../server/hse.mjs';
import { createApi } from '../app/api.mjs';
import { messages } from '../app/i18n.mjs';
import { readFile } from 'node:fs/promises';
import { createContext, runInContext } from 'node:vm';

test('HSE navigation, roles and bilingual labels match the register contract', () => {
  assert.deepEqual(navGroups().find(group => group.label === 'navManagement').items, ['sites', 'tools', 'certifications', 'hse']);
  assert.ok(!navGroups({ hse: false }).flatMap(group => group.items).includes('hse'));
  assert.deepEqual(HSE_TYPES, SERVER_TYPES);
  assert.deepEqual(HSE_SEVERITIES, SERVER_SEVERITIES);
  for (const role of ['owner', 'editor', 'verifier', 'viewer', undefined]) {
    assert.equal(corePermissions(role).hse, ['owner', 'editor', 'verifier'].includes(role));
    assert.equal(corePermissions(role).hseWrite, ['owner', 'editor'].includes(role));
  }
  const keys = ['hse', 'hseSub', 'hsePrivacy', 'hseSummaryHint', 'hseRestricted', 'hseAdd', 'hseEdit', 'hseDelete',
    'hseDeleteConfirm', 'hseSaved', 'hseDeleted', 'hseNotFound', 'hseInvalid', 'hseEmpty', 'hseEmptyHint',
    'hseOccurredOn', 'hseEventNo', 'hseType', 'hseSeverity', 'hseLocation', 'hsePersons', 'hsePersonsHint',
    'hseMeasures', 'hseNotes', 'hseFrom', 'hseTo', 'hsePeriodInvalid', 'hseTotal', 'hseAllTypes', 'hseAllSeverities',
    ...HSE_TYPES.map(type => `hseType_${type}`), ...HSE_SEVERITIES.map(severity => `hseSeverity_${severity}`)];
  for (const language of ['it', 'en']) for (const key of keys) assert.equal(typeof messages[language][key], 'string', `${language}.${key}`);
  assert.equal(messages.it.hsePrivacy, 'Nessun dato sanitario: si registrano fatti, luoghi e misure.');
});

test('HSE filters use inclusive calendar dates, exact enums and stable descending order without mutation', () => {
  const rows = [
    { id: 'b', type: 'near_miss', severity: 'low', occurredOn: '2026-11-01' },
    { id: 'c', type: 'accident', severity: 'high', occurredOn: '2026-11-11' },
    { id: 'a', type: 'observation', severity: 'medium', occurredOn: '2026-11-11' },
  ];
  const before = structuredClone(rows);
  assert.deepEqual(filterHseEvents(rows).map(row => row.id), ['a', 'c', 'b']);
  assert.deepEqual(filterHseEvents(rows, { type: 'near_miss', severity: 'low', from: '2026-11-01', to: '2026-11-01' }).map(row => row.id), ['b']);
  assert.deepEqual(filterHseEvents(rows, { from: '2026-11-12' }), []);
  assert.deepEqual(filterHseEvents(rows, { severity: 'Low' }), []);
  assert.deepEqual(filterHseEvents(rows, { from: '2026-11-11', to: '2026-11-01' }), []);
  assert.deepEqual(hseCounts(rows), { near_miss: 1, accident: 1, observation: 1, total: 3 });
  assert.deepEqual(hseCounts([]), { near_miss: 0, accident: 0, observation: 0, total: 0 });
  assert.deepEqual(rows, before);
});

test('HSE API client encodes filters, maps fields, preserves zero and null, and supports partial updates', async () => {
  const requests = [];
  const row = { id: 'event-1', site_id: 'site-1', event_no: null, type: 'near_miss', severity: 'low',
    occurred_on: '2026-11-10', persons_involved: 0, deviation_id: null, measures: 'Barrier installed' };
  const api = createApi({ baseUrl: 'https://api.example.invalid', fresh: true, fetchImpl: async (url, options) => {
    requests.push({ url, options });
    return Response.json(url.includes('summary=1') ? { by_type: { near_miss: 1, accident: 0, observation: 0 }, by_severity: { low: 1, medium: 0, high: 0 }, total: 1 }
      : options.method === 'DELETE' ? { id: row.id } : url.includes('?') ? [row] : row);
  } });
  const result = await api.listHseEvents({ siteId: 'site /&', type: 'near_miss', severity: 'low', from: '2026-11-01', to: '2026-11-11' });
  assert.equal(requests[0].url, 'https://api.example.invalid/api/hse-events?site_id=site+%2F%26&type=near_miss&severity=low&from=2026-11-01&to=2026-11-11');
  assert.equal(requests[0].options.cache, 'reload');
  assert.equal(result[0].occurredOn, '2026-11-10');
  assert.equal(result[0].personsInvolved, 0);
  const created = await api.createHseEvent({ siteId: 'site-1', type: 'near_miss', severity: 'low', occurredOn: '2026-11-10', personsInvolved: 0, eventNo: null, measures: 'Barrier installed' });
  assert.equal(created.siteId, 'site-1');
  assert.equal(requests[1].options.method, 'POST');
  assert.deepEqual(JSON.parse(requests[1].options.body), { site_id: 'site-1', type: 'near_miss', severity: 'low', occurred_on: '2026-11-10', persons_involved: 0, event_no: null, measures: 'Barrier installed' });
  await api.updateHseEvent('event /&', { personsInvolved: null, notes: 'Inspection complete' });
  assert.equal(requests[2].url, 'https://api.example.invalid/api/hse-events/event%20%2F%26');
  assert.equal(requests[2].options.method, 'PATCH');
  assert.deepEqual(JSON.parse(requests[2].options.body), { persons_involved: null, notes: 'Inspection complete' });
  await api.deleteHseEvent('event /&');
  assert.equal(requests[3].options.method, 'DELETE');
  assert.equal(requests[3].options.body, undefined);
  assert.deepEqual(await api.hseSummary('site-1'), { byType: { near_miss: 1, accident: 0, observation: 0 }, bySeverity: { low: 1, medium: 0, high: 0 }, total: 1 });
  assert.equal(requests[4].url, 'https://api.example.invalid/api/hse-events?site_id=site-1&summary=1');
});

test('HSE API errors retain server status and code', async () => {
  for (const [status, code] of [[400, 'HSE_INVALID'], [403, 'HSE_FORBIDDEN'], [403, 'MODULE_FORBIDDEN'], [404, 'HSE_NOT_FOUND']]) {
    const api = createApi({ fetchImpl: async () => Response.json({ error: 'Synthetic HSE error', code }, { status }) });
    await assert.rejects(() => api.listHseEvents({ siteId: 'site-1' }), { status, code });
  }
});

async function hseUi(role = 'editor') {
  const source = await readFile(new URL('../app/app.mjs', import.meta.url), 'utf8');
  const escaped = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
  const row = { id: 'event-1', eventNo: 'SYN-001', type: 'near_miss', severity: 'low', occurredOn: '2026-11-10',
    personsInvolved: 0, location: '<img src=x>', measures: '<b>Barrier installed</b>', notes: null };
  const calls = [], dialogs = [], notifications = [];
  const context = createContext({
    HSE_TYPES, HSE_SEVERITIES, filterHseEvents, hseCounts,
    siteId: 'site-1', session: { user: { id: 'user-1' } }, modalVersion: 0,
    offline: false, navigator: { onLine: true }, hseEditingId: '',
    coreFilters: { hse: { type: '', severity: '', from: '', to: '' } },
    coreCache: new Map([['site-1', new Map([['hse', { data: [row] }]])]]),
    coreData: () => [row], permissions: () => corePermissions(role),
    t: key => messages.it[key] || key, esc: escaped,
    coreValue: value => escaped(value ?? '—'), coreNumber: value => value == null ? '—' : String(value),
    coreStatus: (value, label) => escaped(label), empty: key => `<p>${messages.it[key]}</p>`,
    showModal: (title, html) => dialogs.push({ title, html }), toast: message => notifications.push(message),
    render: () => calls.push('render'), closeModal: () => calls.push('close'),
    api: {
      createHseEvent: async input => calls.push({ method: 'create', input }),
      updateHseEvent: async (id, input) => calls.push({ method: 'update', id, input }),
      deleteHseEvent: async id => calls.push({ method: 'delete', id }),
    },
  });
  runInContext(source.slice(source.indexOf('const button ='), source.indexOf('function toast(')), context);
  runInContext(source.slice(source.indexOf('function coreSelect('), source.indexOf('const coreDetailButton')), context);
  runInContext(source.slice(source.indexOf('function field('), source.indexOf('function formError(')), context);
  runInContext(source.slice(source.indexOf('function renderHse('), source.indexOf('function renderImpacts(')), context);
  return { run: script => runInContext(script, context), context, calls, dialogs, notifications };
}

test('HSE view and modal render factual fields, escape text and respect write roles', async () => {
  const ui = await hseUi();
  const html = ui.run('renderHse()');
  assert.ok(html.includes(messages.it.hsePrivacy));
  assert.match(html, /&lt;img src=x&gt;/);
  assert.match(html, /&lt;b&gt;Barrier installed&lt;\/b&gt;/);
  assert.match(html, /data-command="hse-edit"/);
  ui.run("hseEditingId = 'event-1'; showHseForm()");
  const form = ui.dialogs.at(-1).html;
  assert.match(form, /name="personsInvolved"[^>]*min="0"[^>]*step="1"[^>]*value="0"/);
  assert.match(form, /name="occurredOn"[^>]*required/);
  assert.doesNotMatch(form, /name="employeeId"/);
  ui.run("showHseDelete('event-1')");
  assert.match(ui.dialogs.at(-1).html, /hse-delete-form/);
  assert.match(ui.dialogs.at(-1).html, /SYN-001/);
  ui.run("coreFilters.hse.type = 'accident'");
  assert.ok(ui.run('renderHse()').includes(messages.it.hseEmpty));
  for (const role of ['verifier', 'viewer']) {
    const restricted = await hseUi(role);
    assert.doesNotMatch(restricted.run('renderHse()'), /data-command="hse-(edit|delete)"/);
    restricted.run('showHseForm()');
    assert.equal(restricted.dialogs.length, 0);
    assert.deepEqual(restricted.notifications, [messages.it.forbidden]);
  }
});

test('HSE form submission preserves zero and unknown counts, refreshes data and refuses offline writes', async () => {
  const ui = await hseUi();
  ui.context.form = { id: 'hse-form', dataset: {} };
  ui.context.data = { eventNo: '', type: 'near_miss', severity: 'low', occurredOn: '2026-11-10', location: '', personsInvolved: '0', measures: 'Barrier installed', notes: '' };
  await ui.run('submitHse(form, data)');
  assert.equal(ui.calls[0].method, 'create');
  assert.equal(ui.calls[0].input.personsInvolved, 0);
  assert.equal(ui.context.coreCache.get('site-1').has('hse'), false);
  ui.context.form.dataset.id = 'event-1'; ui.context.data.personsInvolved = '';
  await ui.run('submitHse(form, data)');
  const update = ui.calls.find(call => call.method === 'update');
  assert.equal(update.id, 'event-1');
  assert.equal(update.input.personsInvolved, null);
  ui.context.form.id = 'hse-delete-form';
  await ui.run('submitHse(form, data)');
  assert.ok(ui.calls.some(call => call.method === 'delete' && call.id === 'event-1'));
  ui.context.offline = true;
  const before = ui.calls.length;
  await assert.rejects(() => ui.run('submitHse(form, data)'), /coreOnlineOnly/);
  assert.equal(ui.calls.length, before);
  const denied = await hseUi('verifier');
  denied.context.form = ui.context.form; denied.context.data = ui.context.data;
  await assert.rejects(() => denied.run('submitHse(form, data)'), /forbidden/);
  assert.deepEqual(denied.calls, []);
});
