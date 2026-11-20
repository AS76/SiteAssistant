import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createContext, runInContext } from 'node:vm';
import { createApi, ApiError } from '../app/api.mjs';
import { messages } from '../app/i18n.mjs';
import {
  corePermissions, INSPECTION_STATUSES, inspectionStatusLabelKey,
  filterHseAssets, sortHseAssets, hseAssetCounts,
} from '../app/domain.mjs';

const source = await readFile(new URL('../app/app.mjs', import.meta.url), 'utf8');
function fragment(start, end) {
  const from = source.indexOf(start), to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, start);
  return source.slice(from, to);
}
const families = [
  { code: 'synthetic-a', title: 'Famiglia sintetica', language: 'it' },
  { code: 'synthetic-b', title: 'Synthetic family', language: 'en' },
];
const asset = () => ({
  id: 'synthetic-subject', name: 'Synthetic subject', code: null, notes: null,
  templateCode: 'synthetic-a', templateTitle: 'Famiglia sintetica',
  category: 'ppe', status: 'never', active: true,
});

function control(value = '') {
  return {
    value, attributes: {},
    setAttribute(key, value) { this.attributes[key] = value; },
    removeAttribute(key) { delete this.attributes[key]; },
    focus() { this.focused = true; },
  };
}
function makeForm(html) {
  const elements = {};
  for (const match of html.matchAll(/<(select|textarea)\b[^>]*\bname="([^"]+)"[^>]*>([\s\S]*?)<\/(?:select|textarea)>/g)) {
    const [, tag, name, content] = match;
    elements[name] = control(tag === 'textarea' ? content : [...content.matchAll(/<option value="([^"]*)"([^>]*)>/g)].find(option => /selected/.test(option[2]))?.[1] ?? '');
  }
  for (const [, attributes, name] of html.matchAll(/<input\b([^>]*\bname="([^"]+)"[^>]*)>/g)) {
    elements[name] = control(attributes.match(/\bvalue="([^"]*)"/)?.[1] ?? '');
    if (/type="checkbox"/.test(attributes)) elements[name].checked = /\bchecked\b/.test(attributes);
  }
  const general = { hidden: true, textContent: '', focus() { this.focused = true; } };
  const nameError = { hidden: true, textContent: '' }, submit = { disabled: false };
  const initial = Object.fromEntries(Object.entries(elements).map(([key, element]) => [key, { value: element.value, checked: element.checked }]));
  return {
    id: 'hse-asset-form', dataset: { id: html.match(/data-id="([^"]*)"/)[1], site: html.match(/data-site="([^"]*)"/)[1] },
    elements, general, nameError, submit, isConnected: true, resetCount: 0,
    querySelector(selector) { return ({ '.form-error': general, '#hse-asset-name-error': nameError, '[type=submit]': submit })[selector]; },
    reset() { this.resetCount++; for (const [key, defaults] of Object.entries(initial)) Object.assign(elements[key], defaults); },
  };
}

function ui({ role = 'editor', language = 'it', rows = [asset()], templates = families, layout = 'inspections' } = {}) {
  const main = { innerHTML: '', insertAdjacentHTML(_position, html) { this.innerHTML += html; }, setAttribute() {} };
  const dialogs = [], notifications = [], requests = [], events = {}, reloads = [];
  let form, submitHandler;
  const api = createApi({ baseUrl: 'https://api.example.invalid', fresh: true, fetchImpl: async (url, options) => {
    requests.push({ url, options });
    if (options.method === 'POST') {
      const created = { ...asset(), ...JSON.parse(options.body), id: 'synthetic-created' };
      rows.push(created);
      return Response.json(created);
    }
    if (options.method === 'PATCH') {
      const row = rows.find(row => url.endsWith(`/${row.id}`));
      Object.assign(row, JSON.parse(options.body));
      return Response.json(row);
    }
    if (url.includes('inspection-templates')) return Response.json({ jurisdiction: 'IT', templates });
    reloads.push(url);
    return Response.json(rows);
  } });
  const context = createContext({
    messages, language, INSPECTION_STATUSES, inspectionStatusLabelKey, filterHseAssets, sortHseAssets, hseAssetCounts,
    siteId: 'synthetic-site', session: { user: { id: 'synthetic-user' } }, modalVersion: 0,
    view: 'hse', hseView: layout, hseAssetFilters: { category: '', status: '' }, hseAssetOrder: 'due',
    reportDate: '2026-11-14', coreFilters: { hse: {} },
    coreCache: new Map([['synthetic-site', new Map([['hseAssets', { data: rows }]])]]),
    moduleResources: { hse: ['hse', 'hseAssets'] }, api, freshApi: api,
    permissions: () => corePermissions(role === 'undefined' ? undefined : role),
    offline: false, navigator: { onLine: true }, columnFiltersOn: false,
    currentSite: () => ({ name: 'Synthetic site', code: 'SYN' }),
    t: key => messages[language][key] ?? key,
    errorMessage: error => error.message,
    $: selector => selector === '#main' ? main : selector === '#hse-asset-form' ? form : null,
    showModal(title, html) {
      context.modalVersion++; dialogs.push({ title, html });
      if (html.includes('id="hse-asset-form"')) form = makeForm(html);
    },
    closeModal() { context.modalVersion++; events.closed = (events.closed || 0) + 1; },
    toast: message => notifications.push(message),
    render: () => runInContext('renderCore()', context),
    renderAuditPanel: () => '', bindAuditPanel() {}, enhanceCoreTables() {},
    renderDeviations() {}, renderProgress() {}, renderBookings() {}, renderImpacts() {}, renderTools() {}, renderCertifications() {}, renderHse: () => '',
    rememberTodayResource() {},
    document: { addEventListener(type, handler) { if (type === 'submit') submitHandler = handler; } },
    FormData: class {
      constructor(target) {
        return Object.entries(target.elements).filter(([, element]) => element.checked !== false).map(([key, element]) => [key, element.checked === true ? 'on' : element.value]);
      }
    },
  });
  for (const [start, end] of [
    ['const esc =', 'let session ='], ['const paths =', 'const badge ='],
    ['const button =', 'function toast('], ['function heading(', 'function renderChrome('],
    ['function coreResource(', 'function progressBar('], ['function renderCore()', 'function auditEntityType()'],
    ['function renderHseViewToggle()', 'function renderHse()'],
    ['function field(', 'function showPasswordForm()'],
    ["document.addEventListener('submit',", "$('#modal').addEventListener('cancel'"],
  ]) runInContext(fragment(start, end), context);
  context.dateLabel = value => value;
  const run = script => runInContext(script, context);
  return {
    context, run, dialogs, requests, events, notifications, reloads, main,
    get form() { return form; },
    open: id => run(`showHseAssetForm(${JSON.stringify(id ?? '')})`),
    save: () => submitHandler({ target: form, preventDefault() {} }),
  };
}

test('create and edit actions use hseWrite in inspections, including the empty state', () => {
  for (const role of ['owner', 'editor', 'verifier', 'viewer', 'undefined']) {
    const allowed = ['owner', 'editor'].includes(role), screen = ui({ role });
    screen.run('renderCore()');
    assert.equal(/data-command="hse-asset-new"/.test(screen.main.innerHTML), allowed, role);
    assert.equal(/data-command="hse-asset-edit"/.test(screen.main.innerHTML), allowed, role);
    assert.equal(/<th scope="col">Azioni<\/th>/.test(screen.main.innerHTML), allowed, role);
    const empty = ui({ role, rows: [] }); empty.run('renderCore()');
    assert.equal((empty.main.innerHTML.match(/data-command="hse-asset-new"/g) || []).length, allowed ? 2 : 0, role);
    const register = ui({ role, layout: 'register' }); register.run('renderCore()');
    assert.doesNotMatch(register.main.innerHTML, /hse-asset-new|hse-asset-edit/);
  }
  assert.match(source, /'hse-asset-new': \(\) => showHseAssetForm\(\)/);
  assert.match(source, /'hse-asset-edit': \(\) => showHseAssetForm\(id\)/);
});

test('form lists every returned family regardless of language and uses the required fields and limits', async () => {
  for (const language of ['it', 'en']) {
    const screen = ui({ language }); await screen.open();
    const html = screen.dialogs.at(-1).html;
    assert.match(screen.requests[0].url, /\/api\/hse\/inspection-templates\?siteId=synthetic-site$/);
    assert.equal(screen.requests[0].options.cache, 'reload');
    const select = html.match(/<select[^>]*name="templateCode"[^>]*>([\s\S]*?)<\/select>/)[1];
    assert.deepEqual([...select.matchAll(/<option value="([^"]+)"/g)].map(match => match[1]), families.map(family => family.code));
    for (const family of families) assert.ok(select.includes(family.title));
    assert.match(html, /name="name"[^>]*required[^>]*maxlength="200"/);
    assert.match(html, /name="code"[^>]*maxlength="60"/);
    assert.match(html, /<textarea[^>]*name="notes"[^>]*maxlength="2000"/);
    assert.doesNotMatch(html, /name="active"|name="kind"|name="category"/);
    assert.equal(screen.form.elements.name.attributes['aria-describedby'], 'hse-asset-name-error');
  }
});

test('create sends only editable fields and siteId, resets state, reloads assets and shows one toast', async () => {
  const screen = ui(); await screen.open();
  Object.assign(screen.form.elements.name, { value: 'New synthetic subject' });
  screen.form.elements.code.value = 'SYN-002'; screen.form.elements.notes.value = 'Synthetic note';
  screen.form.elements.templateCode.value = 'synthetic-b';
  await screen.save();
  const request = screen.requests.find(request => request.options.method === 'POST');
  assert.equal(request.url, 'https://api.example.invalid/api/hse/assets');
  assert.deepEqual(JSON.parse(request.options.body), { siteId: 'synthetic-site', name: 'New synthetic subject', code: 'SYN-002', notes: 'Synthetic note', templateCode: 'synthetic-b' });
  assert.equal(screen.form.resetCount, 1);
  assert.equal(screen.form.elements.name.value, '');
  assert.equal(screen.form.hseAssetOriginal, undefined);
  assert.equal(screen.events.closed, 1);
  await screen.context.coreCache.get('synthetic-site').get('hseAssets').promise;
  assert.equal(screen.reloads.length, 1);
  assert.ok(screen.main.innerHTML.includes('New synthetic subject'));
  assert.deepEqual(screen.notifications, [messages.it.hseAssetSaved]);
  assert.equal(screen.form.submit.disabled, false);
});

test('duplicate name is associated with the name field and typed values survive failure and retry', async () => {
  const screen = ui(); await screen.open();
  const form = screen.form;
  form.elements.name.value = 'Repeated synthetic subject'; form.elements.code.value = 'SYN-003';
  form.elements.notes.value = 'Keep this synthetic note'; form.elements.templateCode.value = 'synthetic-b';
  const before = Object.fromEntries(Object.entries(form.elements).map(([key, element]) => [key, element.value]));
  screen.context.api = { createHseAsset: async () => { throw new ApiError('Duplicate', { status: 409, code: 'DUPLICATE_ASSET_NAME' }); } };
  await screen.save();
  assert.equal(form.nameError.hidden, false); assert.equal(form.general.hidden, true);
  assert.equal(form.nameError.textContent, messages.it.hseAssetDuplicateName);
  assert.equal(form.elements.name.attributes['aria-invalid'], 'true'); assert.equal(form.elements.name.focused, true);
  assert.deepEqual(Object.fromEntries(Object.entries(form.elements).map(([key, element]) => [key, element.value])), before);
  assert.equal(screen.events.closed, undefined); assert.equal(form.submit.disabled, false);
  assert.equal(form.dataset.saving, undefined); assert.deepEqual(screen.notifications, []);
  screen.context.api = screen.context.freshApi;
  await screen.save();
  assert.equal(form.nameError.hidden, true); assert.equal(form.elements.name.attributes['aria-invalid'], undefined);
  assert.equal(screen.events.closed, 1);
});

test('validation and jurisdiction errors show the server message inside the open form', async () => {
  for (const code of ['VALIDATION_ERROR', 'TEMPLATE_JURISDICTION_MISMATCH']) {
    const screen = ui(); await screen.open(); screen.form.elements.name.value = 'Synthetic subject';
    screen.context.api = { createHseAsset: async () => { throw new ApiError('Synthetic validation message', { status: 400, code }); } };
    await screen.save();
    assert.equal(screen.form.general.hidden, false); assert.equal(screen.form.general.textContent, 'Synthetic validation message');
    assert.equal(screen.form.elements.name.value, 'Synthetic subject'); assert.equal(screen.events.closed, undefined);
    assert.deepEqual(screen.notifications, []);
  }
});

test('edit pre-fills values and PATCH includes only changed fields, including family and deactivation', async () => {
  const screen = ui(); await screen.open('synthetic-subject');
  const form = screen.form;
  assert.deepEqual(Object.fromEntries(Object.entries(form.elements).filter(([key]) => key !== 'active').map(([key, element]) => [key, element.value])),
    { name: 'Synthetic subject', code: '', templateCode: 'synthetic-a', notes: '' });
  assert.equal(form.elements.active.checked, true);
  form.elements.templateCode.value = 'synthetic-b'; form.elements.notes.value = 'Synthetic edit'; form.elements.active.checked = false;
  await screen.save();
  const request = screen.requests.find(request => request.options.method === 'PATCH');
  assert.equal(request.url, 'https://api.example.invalid/api/hse/assets/synthetic-subject');
  assert.deepEqual(JSON.parse(request.options.body), { templateCode: 'synthetic-b', notes: 'Synthetic edit', active: false });
  assert.equal(screen.reloads.length, 1);
  await screen.context.coreCache.get('synthetic-site').get('hseAssets').promise;
  assert.ok(screen.main.innerHTML.includes(messages.it.hseAssetInactive));
  const renamed = ui(); await renamed.open('synthetic-subject');
  renamed.form.elements.name.value = 'Renamed synthetic subject'; renamed.form.elements.code.value = 'SYN-004';
  await renamed.save();
  assert.deepEqual(JSON.parse(renamed.requests.find(request => request.options.method === 'PATCH').options.body), { name: 'Renamed synthetic subject', code: 'SYN-004' });
});

test('submit is disabled while pending and a second submit never sends a second request', async () => {
  const screen = ui(); await screen.open(); let resolve, writes = 0;
  screen.context.api = { createHseAsset: () => { writes++; return new Promise(done => { resolve = done; }); } };
  const first = screen.save();
  assert.equal(screen.form.submit.disabled, true); assert.equal(screen.form.dataset.saving, 'true');
  await screen.save(); assert.equal(writes, 1);
  resolve(asset()); await first;
  assert.equal(screen.form.submit.disabled, false); assert.equal(screen.form.dataset.saving, undefined);
  assert.equal(screen.notifications.length, 1);
});

test('inactive subjects stay visible and can be reactivated without an active filter', async () => {
  for (const active of [false, 0]) {
    const row = { ...asset(), active }, screen = ui({ rows: [row] }); screen.run('renderCore()');
    assert.ok(screen.main.innerHTML.includes(row.name)); assert.ok(screen.main.innerHTML.includes(messages.it.hseAssetInactive));
    assert.doesNotMatch(screen.main.innerHTML, /data-core-filter="active"/);
    await screen.open(row.id); assert.equal(screen.form.elements.active.checked, false);
    screen.form.elements.active.checked = true; await screen.save();
    assert.deepEqual(JSON.parse(screen.requests.find(request => request.options.method === 'PATCH').options.body), { active: true });
  }
});

test('template loading errors are recoverable and stale template loads cannot replace a closed modal', async () => {
  const screen = ui();
  screen.context.freshApi = { listInspectionTemplates: async () => { throw new Error('Synthetic load error'); } };
  await screen.open('synthetic-subject');
  assert.match(screen.dialogs.at(-1).html, /role="alert"/); assert.match(screen.dialogs.at(-1).html, /hse-asset-edit/);
  let resolve;
  screen.context.freshApi = { listInspectionTemplates: () => new Promise(done => { resolve = done; }) };
  const pending = screen.open(); screen.context.modalVersion++;
  resolve({ templates: families }); await pending;
  assert.doesNotMatch(screen.dialogs.at(-1).html, /<form/);
});

test('restricted and offline users cannot open or submit a subject form', async () => {
  for (const role of ['verifier', 'viewer', 'undefined']) {
    const screen = ui({ role }); await screen.open();
    assert.equal(screen.dialogs.length, 0); assert.equal(screen.requests.length, 0);
  }
  const screen = ui(); await screen.open(); screen.context.offline = true;
  await screen.save(); assert.equal(screen.requests.length, 1); assert.equal(screen.events.closed, undefined);
});

test('form values and family titles are escaped and API row ids are encoded', async () => {
  const screen = ui({ rows: [{ ...asset(), name: '<b>Synthetic</b>', code: '<code>', notes: '</textarea><script>synthetic</script>' }], templates: [{ code: 'synthetic-a', title: '<b>Synthetic family</b>' }] });
  await screen.open('synthetic-subject');
  const html = screen.dialogs.at(-1).html;
  assert.match(html, /&lt;b&gt;Synthetic&lt;\/b&gt;/); assert.match(html, /&lt;code&gt;/);
  assert.match(html, /&lt;\/textarea&gt;&lt;script&gt;/); assert.match(html, /&lt;b&gt;Synthetic family&lt;\/b&gt;/);
  assert.doesNotMatch(html, /<script>|<b>/);
  let url;
  const api = createApi({ baseUrl: 'https://api.example.invalid', fetchImpl: async target => { url = target; return Response.json(asset()); } });
  await api.updateHseAsset('synthetic /&', {});
  assert.equal(url, 'https://api.example.invalid/api/hse/assets/synthetic%20%2F%26');
});

test('new subject keys match in Italian and English and service worker retains the subject cache update', async () => {
  const keys = Object.keys(messages.it).filter(key => key.startsWith('hseAsset'));
  assert.deepEqual(keys.sort(), Object.keys(messages.en).filter(key => key.startsWith('hseAsset')).sort());
  for (const language of ['it', 'en']) for (const key of keys) assert.ok(messages[language][key]);
  const sw = await readFile(new URL('../app/sw.js', import.meta.url), 'utf8');
  const version = /const VERSION = 'siteassistant-v15-(\d+)'/.exec(sw);
  assert.ok(version);
  assert.ok(Number(version[1]) >= 23, 'Service worker must include the subject cache update.');
});
