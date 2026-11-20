import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createContext, runInContext } from 'node:vm';
import { createApi, ApiError } from '../app/api.mjs';
import { messages } from '../app/i18n.mjs';
import * as domain from '../app/domain.mjs';

const source = await readFile(new URL('../app/app.mjs', import.meta.url), 'utf8');
function fragment(start, end) {
  const from = source.indexOf(start), to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, start);
  return source.slice(from, to);
}
const family = () => ({
  code: 'synthetic-family', title: 'Synthetic family', reference: 'Synthetic reference VII',
  draft: true, items: Array.from({ length: 10 }, (_, index) => ({ code: `check-${index}`, label: `Synthetic check ${index}` })),
});
const asset = (id = 'synthetic-subject') => ({
  id, siteId: 'synthetic-site', name: `Synthetic subject ${id}`, code: 'SYN-001',
  templateCode: 'synthetic-family', templateTitle: 'Synthetic family', category: 'ppe',
  status: 'failed', active: true, lastInspectionOn: '2026-11-12', nextDueOn: '2026-12-12',
});
const items = () => [
  { id: 'synthetic-item-z', label: 'Stored first check', position: 0, result: 'not_ok', note: 'First synthetic note' },
  { id: 'synthetic-item-a', label: 'Stored second check', position: 1, result: 'na', note: 'Second synthetic note' },
  { id: 'synthetic-item-m', label: 'Stored third check', position: 2, result: 'ok', note: 'Third synthetic note' },
  { id: 'synthetic-item-n', label: 'Stored fourth check', position: 3, result: 'ok', note: null },
];
const inspections = () => [
  { id: 'synthetic-old', performedOn: '2026-10-02', createdAt: '2026-11-14T10:00:00Z', performedBy: 'Synthetic inspector A', performerRole: 'Synthetic role A', mode: 'internal', outcome: 'pass', nextDueOn: null, notes: null },
  { id: 'synthetic-tie-old', performedOn: '2026-11-12', createdAt: '2026-11-12T08:00:00Z', performedBy: 'Synthetic inspector B', performerRole: 'Synthetic role B', mode: 'external', outcome: 'pass_with_notes', nextDueOn: '2027-01-12', notes: 'Synthetic header note B' },
  { id: 'synthetic-new', performedOn: '2026-11-12', createdAt: '2026-11-12T09:00:00Z', performedBy: 'Synthetic inspector C', performerRole: 'Synthetic role C', mode: 'internal', outcome: 'fail', nextDueOn: '2026-12-12', notes: 'Synthetic header note C' },
];

function ui({ language = 'it', rows = [asset()], templates = [family()], history = inspections(), details = {}, respond, role = 'verifier', filters = {}, order = 'due' } = {}) {
  const main = { innerHTML: '', insertAdjacentHTML(_where, html) { this.innerHTML += html; }, setAttribute() {} };
  const requests = [], listeners = {}, missingKeys = [];
  const api = createApi({ baseUrl: 'https://api.example.invalid', fresh: true, fetchImpl: async (url, options) => {
    requests.push({ url, options });
    const response = await respond?.(url, options);
    if (response) return response;
    if (url.includes('inspection-templates')) return Response.json({ templates });
    if (url.includes('/inspections?')) return Response.json(history);
    if (url.includes('/inspections/')) {
      const id = decodeURIComponent(url.split('/').at(-1));
      const row = history.find(row => row.id === id);
      return Response.json(details[id] ?? { ...row, asset: { id: rows[0].id }, items: items() });
    }
    throw new Error('Unexpected synthetic request');
  } });
  const context = createContext({
    ...domain, messages, language,
    siteId: 'synthetic-site', session: { user: { id: 'synthetic-user' } },
    view: 'hse', hseView: 'inspections', hseAssetFilters: { category: '', status: '', ...filters }, hseAssetOrder: order,
    coreFilters: { hse: {} }, moduleResources: { hse: ['hse', 'hseAssets'] },
    coreCache: new Map([['synthetic-site', new Map([['hseAssets', { data: rows }]])]]),
    freshApi: api, permissions: () => domain.corePermissions(role),
    offline: false, navigator: { onLine: true }, columnFiltersOn: false,
    t(key) { if (!Object.hasOwn(messages[language], key)) missingKeys.push(key); return messages[language][key] ?? key; },
    currentSite: () => ({ name: 'Synthetic site', code: 'SYN' }),
    $: selector => selector === '#main' ? main : null,
    render: () => runInContext('renderCore()', context),
    document: { addEventListener(type, handler) { listeners[type] = handler; } },
    sessionStorage: { setItem() {} },
    renderAuditPanel: () => '', bindAuditPanel() {}, enhanceCoreTables() {}, rememberTodayResource() {},
  });
  // Unrelated commands remain inert; the HSE renderers and the real delegated click handler run below.
  for (const [, name] of source.matchAll(/(?:async )?function (\w+)\(/g)) {
    if (!(name in context)) context[name] = () => {};
  }
  for (const [start, end] of [
    ['const esc =', 'let session ='], ['const dateLabel =', 'const timeLabel ='],
    ['const paths =', 'const badge ='], ['const button =', 'function toast('],
    ['const errorKeys =', 'function clearSession('],
    ['function heading(', 'function renderChrome('],
    ['function coreResource(', 'function progressBar('],
    ['function renderCore()', 'function auditEntityType()'],
    ['function renderHseViewToggle()', 'function renderHse()'],
    ['function selectHseView(', 'function resetCore('],
    ["document.addEventListener('click',", "document.addEventListener('submit',"],
  ]) runInContext(fragment(start, end), context);
  const run = script => runInContext(script, context);
  const click = (command, data = {}) => listeners.click({ target: { closest: () => ({ dataset: { command, ...data } }) } });
  const settle = async () => {
    // A history completion can schedule snapshot loads, so drain until the cache is idle.
    for (let turn = 0; turn < 10; turn++) {
      const pending = [...context.coreCache.values()].flatMap(cache => [...cache.values()].filter(entry => entry.pending).map(entry => entry.promise));
      if (!pending.length) return;
      await Promise.all(pending);
    }
    assert.fail('Synthetic resource cache did not settle');
  };
  run('renderCore()');
  return {
    main, context, run, click, settle, requests, missingKeys,
    date: value => run(`dateLabel(${JSON.stringify(value)})`),
    async open(id = rows[0].id) { click('core-detail', { module: 'hseAssets', id }); await settle(); },
    get html() { return main.innerHTML; },
  };
}

test('pure label helpers translate known and unknown values in both languages', () => {
  for (const [helper, values] of [
    [domain.inspectionOutcomeLabelKey, ['pass', 'pass_with_notes', 'fail']],
    [domain.inspectionModeLabelKey, ['internal', 'external']],
    [domain.inspectionItemResultLabelKey, ['ok', 'not_ok', 'na']],
  ]) {
    for (const language of ['it', 'en']) for (const value of [...values, null, undefined, 'unmapped', '__proto__']) {
      const key = helper(value);
      assert.ok(messages[language][key], `${language}: ${key}`);
      if (!values.includes(value)) assert.equal(key, 'coreUnknown');
    }
  }
});

test('inspectionTally counts stored results without mutating its input', () => {
  const rows = items().map(Object.freeze);
  Object.freeze(rows);
  assert.deepEqual(domain.inspectionTally(rows), { ok: 2, notOk: 1, na: 1, total: 4 });
  assert.deepEqual(domain.inspectionTally(), { ok: 0, notOk: 0, na: 0, total: 0 });
  assert.deepEqual(domain.inspectionTally([{ result: '__proto__' }, { result: 'unknown' }]), { ok: 0, notOk: 0, na: 0, total: 2 });
});

test('sortInspections sorts performed dates then creation instants, preserving input and stable ties', () => {
  const rows = inspections().map(Object.freeze);
  Object.freeze(rows);
  assert.deepEqual(domain.sortInspections(rows).map(row => row.id), ['synthetic-new', 'synthetic-tie-old', 'synthetic-old']);
  assert.equal(rows[0].id, 'synthetic-old');
  const tied = [
    { id: 'a', performedOn: '2026-11-12', createdAt: '2026-11-12T11:00:00+03:00' },
    { id: 'b', performedOn: '2026-11-12', createdAt: '2026-11-12T09:00:00Z' },
    { id: 'c', performedOn: '2026-11-12', createdAt: '2026-11-12T09:00:00Z' },
  ];
  assert.deepEqual(domain.sortInspections(tied).map(row => row.id), ['b', 'c', 'a']);
  assert.deepEqual(domain.sortInspections(), []);
});

for (const language of ['it', 'en']) {
  test(`subject detail shows identity, family, reference, state, dates and checklist length (${language})`, async () => {
    const screen = ui({ language });
    assert.match(screen.html, /<button type="button" data-command="core-detail" data-module="hseAssets" data-id="synthetic-subject">Synthetic subject synthetic-subject<\/button>/);
    assert.equal(screen.requests.length, 0);
    await screen.open();
    assert.match(screen.html, /<h2>Synthetic subject synthetic-subject<\/h2>/);
    assert.match(screen.html, /<small class="note hse-asset-code">SYN-001<\/small>/);
    for (const text of ['Synthetic family', 'Synthetic reference VII', messages[language].inspectionStatus_failed, messages[language].hseAssetBack, `10 ${messages[language].hseAssetChecks}`]) assert.ok(screen.html.includes(text), text);
    for (const date of ['2026-11-12', '2026-12-12']) assert.ok(screen.html.includes(screen.date(date)));
    assert.doesNotMatch(screen.html, /data-core-filter|data-command="hse-asset-(?:new|edit)"|<form|type="file"/);
    assert.ok(screen.requests.every(request => !request.options.method && request.options.cache === 'reload'));
    assert.deepEqual(screen.missingKeys, []);
  });

  test(`draft review line is conditional and missing codes and dates remain absent or dashes (${language})`, async () => {
    for (const draft of [true, false]) {
      const screen = ui({ language, rows: [{ ...asset(), code: null, lastInspectionOn: null, nextDueOn: null, status: 'never' }], templates: [{ ...family(), draft, items: [family().items[0]] }], history: [] });
      await screen.open();
      assert.equal(screen.html.includes(messages[language].hseAssetChecklistReview), draft);
      assert.doesNotMatch(screen.html, /hse-asset-code/);
      assert.ok(screen.html.includes(`1 ${messages[language].hseAssetCheck}`));
      assert.equal((screen.html.match(/<dd>—<\/dd>/g) || []).length, 2);
      assert.deepEqual(screen.missingKeys, []);
    }
  });

  test(`history shows newest first, metadata, outcomes, notes and tallies from stored items (${language})`, async () => {
    const screen = ui({ language }); await screen.open();
    assert.deepEqual([...screen.html.matchAll(/data-command="hse-inspection-toggle" data-id="([^"]+)"/g)].map(match => match[1]), ['synthetic-new', 'synthetic-tie-old', 'synthetic-old']);
    for (const row of inspections()) for (const text of [row.performedBy, row.performerRole, messages[language][domain.inspectionModeLabelKey(row.mode)], messages[language][domain.inspectionOutcomeLabelKey(row.outcome)], row.notes]) {
      if (text) assert.ok(screen.html.includes(text), text);
    }
    assert.ok(screen.html.includes(screen.date('2027-01-12')));
    for (const [result, count] of [['ok', 2], ['not_ok', 1], ['na', 1]]) assert.equal(screen.html.split(`${messages[language][domain.inspectionItemResultLabelKey(result)]}: ${count}`).length - 1, 3);
    assert.doesNotMatch(screen.html, /Stored first check/);
    assert.deepEqual(screen.missingKeys, []);
  });

  test(`expanding and collapsing a history row shows ordered snapshot labels, notes and text results (${language})`, async () => {
    const screen = ui({ language }); await screen.open();
    const requestCount = screen.requests.length;
    screen.click('hse-inspection-toggle', { id: 'synthetic-new' }); await screen.settle();
    assert.match(screen.html, /data-id="synthetic-new" aria-expanded="true" aria-controls="hse-inspection-synthetic-new"/);
    assert.deepEqual([...screen.html.matchAll(/<li><span>([^<]+)<\/span>/g)].map(match => match[1]), items().map(item => item.label));
    for (const item of items()) {
      const result = messages[language][domain.inspectionItemResultLabelKey(item.result)];
      assert.ok(screen.html.includes(`>${result}</span>`));
      if (item.note) assert.ok(screen.html.includes(item.note));
    }
    assert.equal(screen.requests.length, requestCount);
    screen.click('hse-inspection-toggle', { id: 'synthetic-new' });
    assert.match(screen.html, /data-id="synthetic-new" aria-expanded="false"/);
    assert.doesNotMatch(screen.html, /Stored first check/);
    assert.deepEqual(screen.missingKeys, []);
  });

  test(`empty history uses the specific never-inspected line (${language})`, async () => {
    const screen = ui({ language, history: [] }); await screen.open();
    assert.ok(screen.html.includes(messages[language].hseInspectionEmpty));
    assert.doesNotMatch(screen.html, /data-command="hse-inspection-toggle"/);
    assert.deepEqual(screen.missingKeys, []);
  });

  test(`failed history load shows the application error and back restores the filtered, ordered list (${language})`, async () => {
    const screen = ui({ language, filters: { category: 'ppe', status: 'failed' }, order: 'name', respond: url => url.includes('/inspections?') ? Response.json({ error: 'Synthetic failure', code: 'SYNTHETIC_FAILURE' }, { status: 500 }) : undefined });
    const list = screen.html;
    await screen.open();
    assert.ok(screen.html.includes(`<p role="alert">${messages[language].apiError}</p>`));
    assert.ok(screen.html.includes(`data-command="hse-asset-back"`));
    screen.click('hse-asset-back');
    assert.equal(screen.html, list);
    assert.equal(screen.context.hseAssetFilters.category, 'ppe');
    assert.equal(screen.context.hseAssetFilters.status, 'failed');
    assert.equal(screen.context.hseAssetOrder, 'name');
    assert.deepEqual(screen.missingKeys, []);
  });
}

test('history and snapshot caches are lazy, scoped by subject and site, and reused on return', async () => {
  const rows = [asset('synthetic-b'), { ...asset('synthetic-a'), name: 'Alphabetical first' }];
  const screen = ui({ rows, order: 'name' });
  const list = screen.html;
  assert.equal(screen.requests.length, 0);
  await screen.open();
  assert.equal(screen.requests.filter(request => request.url.includes('/inspections?')).length, 1);
  assert.match(screen.requests.find(request => request.url.includes('/inspections?')).url, /siteId=synthetic-site&assetId=synthetic-b$/);
  assert.equal(screen.requests.filter(request => request.url.includes('/inspections/')).length, 3);
  screen.click('hse-asset-back'); assert.equal(screen.html, list);
  const before = screen.requests.length;
  await screen.open(); assert.equal(screen.requests.length, before);
  await screen.open('synthetic-a');
  assert.equal(screen.requests.filter(request => request.url.includes('/inspections?')).length, 2);
  assert.ok(screen.requests.some(request => request.url.endsWith('assetId=synthetic-a')));
  screen.context.siteId = 'synthetic-other-site';
  screen.context.coreCache.set('synthetic-other-site', new Map([['hseAssets', { data: [asset()] }]]));
  await screen.open('synthetic-subject');
  assert.ok(screen.requests.some(request => request.url.includes('siteId=synthetic-other-site')));
});

test('a pending history completion cannot reopen detail after back', async () => {
  let resolve;
  const pending = new Promise(done => { resolve = done; });
  const screen = ui({ respond: url => url.includes('/inspections?') ? pending : undefined });
  const list = screen.html;
  screen.click('core-detail', { module: 'hseAssets', id: 'synthetic-subject' });
  assert.match(screen.html, /role="status"/);
  screen.click('hse-asset-back');
  resolve(Response.json(inspections())); await screen.settle();
  assert.equal(screen.html, list);
  assert.equal(screen.requests.filter(request => request.url.includes('/inspections/')).length, 0);
});

test('template and snapshot failures remain local and keep history headers and back available', async () => {
  for (const failure of ['inspection-templates', '/inspections/synthetic-new']) {
    const screen = ui({ respond: url => url.includes(failure) ? Response.json({ error: 'Synthetic failure' }, { status: 503 }) : undefined });
    await screen.open();
    assert.ok(screen.html.includes(`<p role="alert">${messages.it.apiError}</p>`));
    assert.match(screen.html, /Synthetic inspector C/);
    assert.match(screen.html, /data-command="hse-asset-back"/);
    screen.click('hse-inspection-toggle', { id: 'synthetic-new' });
    assert.match(screen.html, /aria-expanded="true"/);
    screen.click('hse-asset-back'); assert.match(screen.html, /data-core-filter="order"/);
  }
});

test('detail and history escape stored text, including item notes', async () => {
  const row = { ...inspections()[0], performedBy: '<b>Inspector</b>', performerRole: '<i>Role</i>', notes: '<script>header</script>' };
  const screen = ui({ rows: [{ ...asset(), name: '<b>Subject</b>', code: '<code>' }], templates: [{ ...family(), title: '<b>Family</b>', reference: '<em>Reference</em>' }], history: [row], details: { [row.id]: { ...row, items: [{ label: '<b>Stored item</b>', result: 'not_ok', note: '</li><script>note</script>' }] } } });
  await screen.open(); screen.click('hse-inspection-toggle', { id: row.id });
  assert.doesNotMatch(screen.html, /<script>|<b>|<i>|<em>|<code>/);
  for (const text of ['&lt;b&gt;Subject', '&lt;b&gt;Family', '&lt;em&gt;Reference', '&lt;b&gt;Inspector', '&lt;i&gt;Role', '&lt;b&gt;Stored item', '&lt;/li&gt;&lt;script&gt;note']) assert.ok(screen.html.includes(text), text);
});

test('read APIs encode filters and ids and map header and nested snapshot fields', async () => {
  const requests = [];
  const api = createApi({ baseUrl: 'https://api.example.invalid', fetchImpl: async (url, options) => {
    requests.push({ url, options });
    const row = { performed_on: '2026-11-12', performed_by: 'Synthetic inspector', performer_role: null, created_at: '2026-11-12T09:00:00Z', next_due_on: null };
    return Response.json(url.includes('?') ? [row] : { ...row, items: [{ inspection_id: 'synthetic-id', label: 'Stored label', result: 'na', position: 3 }], asset: { template_code: 'synthetic-family' } });
  } });
  const rows = await api.listInspections({ siteId: 'synthetic /&', assetId: 'synthetic subject' });
  assert.equal(requests[0].url, 'https://api.example.invalid/api/hse/inspections?siteId=synthetic+%2F%26&assetId=synthetic+subject');
  assert.equal(rows[0].performedOn, '2026-11-12'); assert.equal(rows[0].performerRole, null);
  const detail = await api.getInspection('synthetic /&');
  assert.equal(requests[1].url, 'https://api.example.invalid/api/hse/inspections/synthetic%20%2F%26');
  assert.equal(detail.items[0].inspectionId, 'synthetic-id');
  assert.equal(detail.asset.templateCode, 'synthetic-family');
  assert.equal(detail.nextDueOn, null);
  assert.ok(requests.every(request => !request.options.method));
  const failing = createApi({ baseUrl: 'https://api.example.invalid', fetchImpl: async () => Response.json({ error: 'Synthetic failure' }, { status: 500 }) });
  await assert.rejects(() => failing.getInspection('synthetic-id'), ApiError);
});

test('new keys have Italian and English translations and service worker uses v15-24', async () => {
  const pattern = /^(hseAsset(?:Back|ChecklistReview|Checks?)$|hseInspection|inspection(?:Outcome|Mode|ItemResult)_)/;
  const keys = Object.keys(messages.it).filter(key => pattern.test(key));
  // Parity between the two languages matters; the exact count would only track my own naming.
  assert.ok(keys.length >= 15, `expected the new strings, found ${keys.length}`);
  assert.deepEqual(keys.sort(), Object.keys(messages.en).filter(key => pattern.test(key)).sort());
  for (const key of keys) for (const language of ['it', 'en']) assert.ok(messages[language][key] && messages[language][key] !== key, `${language}.${key}`);
  const sw = await readFile(new URL('../app/sw.js', import.meta.url), 'utf8');
  const version = Number(/siteassistant-v15-(\d+)/.exec(sw)?.[1]);
  assert.ok(version >= 24, `cache version ${version} must follow the current build`);
});
