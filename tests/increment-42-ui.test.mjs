import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createContext, runInContext } from 'node:vm';
import {
  INSPECTION_STATUSES, inspectionStatusLabelKey, filterHseAssets, sortHseAssets, hseAssetCounts,
  HSE_TYPES, HSE_SEVERITIES, filterHseEvents, hseCounts, validDate, formatDateInput, parseDateInput,
} from '../app/domain.mjs';
import { createApi } from '../app/api.mjs';
import { messages } from '../app/i18n.mjs';

const source = await readFile(new URL('../app/app.mjs', import.meta.url), 'utf8');
const css = await readFile(new URL('../app/styles.css', import.meta.url), 'utf8');
const fragment = (start, end) => {
  const from = source.indexOf(start), to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, start);
  return source.slice(from, to);
};
const assets = () => INSPECTION_STATUSES.map((status, index) => ({
  id: `synthetic-${index}`, name: `Subject ${index}`, code: index ? null : 'SYN-001',
  category: ['lifting', 'lifting_accessories', 'ppe', 'scaffolding', 'lifting'][index],
  templateTitle: 'Synthetic family', status,
  lastInspectionOn: status === 'never' ? null : '2026-10-01',
  nextDueOn: status === 'never' ? null : ['2026-12-01', '2026-11-20', '2026-11-01', '2026-11-10'][index],
}));
const ids = rows => rows.map(row => row.id);

test('due and last inspection orders compare dates and place nulls last without mutation', () => {
  const rows = [
    { id: 'a', nextDueOn: null, lastInspectionOn: '2026-10-01' },
    { id: 'b', nextDueOn: '2026-12-01', lastInspectionOn: null },
    { id: 'c', nextDueOn: '2026-01-02', lastInspectionOn: '2026-11-01' },
    { id: 'd', nextDueOn: '2026-01-10', lastInspectionOn: null },
    { id: 'e', nextDueOn: null, lastInspectionOn: '2026-01-01' },
  ];
  const before = structuredClone(rows);
  assert.deepEqual(ids(sortHseAssets(rows)), ['c', 'd', 'b', 'a', 'e']);
  assert.deepEqual(ids(sortHseAssets(rows, 'due')), ['c', 'd', 'b', 'a', 'e']);
  assert.deepEqual(ids(sortHseAssets(rows, 'last')), ['c', 'a', 'e', 'b', 'd']);
  assert.deepEqual(rows, before);
  assert.deepEqual(sortHseAssets([]), []);
});

test('name order is locale-aware for accented names', () => {
  const rows = [{ name: 'Zulu' }, { name: 'Éclair' }, { name: 'Beta' }, { name: 'Álpha' }];
  assert.deepEqual(sortHseAssets(rows, 'name').map(row => row.name), ['Álpha', 'Beta', 'Éclair', 'Zulu']);
});

test('category and status filters combine, empty values select all and inputs stay unchanged', () => {
  const rows = assets(), before = structuredClone(rows);
  assert.deepEqual(ids(filterHseAssets(rows)), ids(rows));
  assert.deepEqual(ids(filterHseAssets(rows, { category: '', status: '' })), ids(rows));
  assert.deepEqual(ids(filterHseAssets(rows, { category: 'lifting' })), ['synthetic-0', 'synthetic-4']);
  assert.deepEqual(ids(filterHseAssets(rows, { status: 'never' })), ['synthetic-4']);
  assert.deepEqual(ids(filterHseAssets(rows, { category: 'lifting', status: 'never' })), ['synthetic-4']);
  assert.deepEqual(filterHseAssets(rows, { category: 'ppe', status: 'never' }), []);
  assert.deepEqual(rows, before);
});

test('counts cover every state and total, including empty input', () => {
  assert.deepEqual(hseAssetCounts([...assets(), assets()[2]]), { ok: 1, due_soon: 1, overdue: 2, failed: 1, never: 1, total: 6 });
  assert.deepEqual(hseAssetCounts([]), { ok: 0, due_soon: 0, overdue: 0, failed: 0, never: 0, total: 0 });
});

test('inspection labels and all new UI keys have matching Italian and English translations', () => {
  const keys = Object.keys(messages.it).filter(key => /^(hseAsset|hseRegister$|hseInspections|inspection)/.test(key));
  assert.deepEqual(keys.sort(), Object.keys(messages.en).filter(key => /^(hseAsset|hseRegister$|hseInspections|inspection)/.test(key)).sort());
  for (const language of ['it', 'en']) {
    for (const key of keys) assert.ok(messages[language][key]?.length, `${language}: ${key}`);
    for (const status of INSPECTION_STATUSES) assert.ok(messages[language][inspectionStatusLabelKey(status)]);
  }
  assert.equal(inspectionStatusLabelKey('unmapped'), 'coreUnknown');
});

// Run the real renderers and shared table helper without browser processes or sockets.
function ui({ language = 'it', rows = assets(), events = [], layout = 'inspections', filters = {}, order = 'due', pending = false, error = null } = {}) {
  const main = { innerHTML: '', insertAdjacentHTML(_position, html) { this.innerHTML += html; }, setAttribute() {} };
  const requested = [], calls = [];
  const context = createContext({
    messages, language, validDate, formatDateInput, parseDateInput, INSPECTION_STATUSES, inspectionStatusLabelKey, filterHseAssets, sortHseAssets, hseAssetCounts,
    HSE_TYPES, HSE_SEVERITIES, filterHseEvents, hseCounts,
    view: 'hse', hseView: layout, hseAssetFilters: { category: '', status: '', ...filters }, hseAssetOrder: order,
    // Detail state lives outside the sliced block (increment 44 adds it).
    hseAssetDetail: { id: '', expanded: new Set() },
    coreFilters: { hse: { type: '', severity: '', from: '', to: '' } },
    coreData: name => name === 'hseAssets' ? rows : name === 'hse' ? events : [],
    coreResource: name => { requested.push(name); return { pending, error }; },
    moduleResources: { hse: ['hse', 'hseAssets'] },
    t: key => messages[language][key] ?? key, currentSite: () => ({ code: 'SYN', name: 'Synthetic site' }),
    permissions: () => ({ hse: true, hseWrite: true }),
    $: selector => selector === '#main' ? main : null,
    offline: false, navigator: { onLine: true }, columnFiltersOn: false,
    renderDeviations() {}, renderProgress() {}, renderBookings() {}, renderImpacts() {}, renderTools() {}, renderCertifications() {},
    renderAuditPanel: () => '<aside>Register history</aside>', bindAuditPanel() {},
    enhanceCoreTables: () => calls.push('enhance'), errorMessage: () => 'Synthetic load error',
  });
  for (const [start, end] of [
    ['const esc =', 'let session ='], ['const dateLabel =', 'const timeLabel ='],
    ['const paths =', 'const badge ='], ['const button =', 'function toast('],
    ['function heading(', 'function renderChrome('], ['function dateInput(', 'const formActions ='], ['const coreValue =', 'function progressBar('],
    ['function renderCore()', 'function auditEntityType()'],
    ['function renderHseViewToggle()', 'function showHseForm()'],
  ]) runInContext(fragment(start, end), context);
  runInContext('renderCore()', context);
  return { html: main.innerHTML, requested, calls, context };
}

for (const language of ['it', 'en']) {
  test(`register inspection actions preserve labels and carry both identifiers (${language})`, () => {
    const events = ['inspection', 'external_visit', 'near_miss', 'accident', 'observation'].map((type, index) => ({
      id: `synthetic-${index}`, type, severity: 'low', occurredOn: '2026-11-10',
      inspectionId: `inspection-${type}`, assetId: `asset-${type}`,
    }));
    const { html } = ui({ language, layout: 'register', events });
    const cells = [...html.matchAll(/<td data-label="(?:Tipo|Type)">([\s\S]*?)<\/td>/g)].map(match => match[1]);
    assert.equal(cells.length, events.length);
    const expectedLabel = language === 'it' ? "Apri l'ispezione" : 'Open the inspection';
    assert.equal(messages[language].hseInspectionOpen, expectedLabel);
    for (const [index, row] of events.entries()) {
      assert.ok(cells[index].startsWith(messages[language][`hseType_${row.type}`]));
      if (index < 2) {
        assert.match(cells[index], /<button type="button"[^>]*data-command="hse-inspection-open"/);
        assert.ok(cells[index].includes(`data-inspection-id="${row.inspectionId}"`));
        assert.ok(cells[index].includes(`data-asset-id="${row.assetId}"`));
        assert.ok(cells[index].includes(`>${expectedLabel}</button>`));
      } else {
        assert.equal(cells[index], messages[language][`hseType_${row.type}`]);
      }
    }
    assert.doesNotMatch(html, /hseInspectionOpen|undefined/);
    const unlinked = ui({ language, layout: 'register', events: [{ ...events[0], inspectionId: null, assetId: null }] }).html;
    assert.ok(unlinked.includes(`<td data-label="${messages[language].hseType}">${messages[language].hseType_inspection}</td>`));
  });

  test(`inspections render both view buttons, five columns and five distinct status badges (${language})`, () => {
    const { html, requested, calls } = ui({ language });
    assert.deepEqual(requested, ['hseAssets']);
    assert.deepEqual(calls, []);
    for (const [value, key] of [['register', 'hseRegister'], ['inspections', 'hseInspections']]) {
      assert.ok(html.includes(`data-value="${value}" aria-pressed="${value === 'inspections'}"`));
      assert.ok(html.includes(`>${messages[language][key]}</button>`));
    }
    // With write rights the table carries a sixth actions column (increment 43).
    const columns = ['hseAssetName', 'hseAssetFamily', 'hseAssetLastInspection', 'hseAssetNextDue', 'status', 'coreActions'];
    assert.deepEqual([...html.matchAll(/<th scope="col">([^<]+)<\/th>/g)].map(match => match[1]), columns.map(key => messages[language][key]));
    for (const status of INSPECTION_STATUSES) assert.ok(html.includes(`<span>${messages[language][inspectionStatusLabelKey(status)]}</span>`));
    const badges = [...html.matchAll(/<span class="badge core-status inspection-status ([^"]+)">(<svg[\s\S]*?<\/svg>)<span>([^<]+)<\/span><\/span>/g)];
    assert.equal(badges.length, 5);
    assert.equal(new Set(badges.map(match => match[1])).size, 5);
    assert.equal(new Set(badges.map(match => match[2])).size, 5);
    assert.match(html, /<small class="note hse-asset-code">SYN-001<\/small>/);
    assert.match(html, /<small class="note">Synthetic family<\/small>/);
    for (const category of ['lifting', 'lifting_accessories', 'ppe', 'scaffolding']) assert.ok(html.includes(messages[language][`inspectionCategory_${category}`]));
    assert.doesNotMatch(html, /hseAsset[A-Z]|coreUnknown|undefined|<form|hse-new|Register history/);
    assert.ok(html.indexOf('Subject 2') < html.indexOf('Subject 3'));
    assert.ok(html.indexOf('Subject 0') < html.indexOf('Subject 4'));
  });

  test(`no-subject and filtered-empty states differ and filters can be cleared (${language})`, () => {
    const empty = ui({ language, rows: [] }).html;
    assert.ok(empty.includes(messages[language].hseAssetEmpty));
    assert.doesNotMatch(empty, /hse-assets-clear|<table|hse-new/);
    const filtered = ui({ language, filters: { category: 'ppe', status: 'never' } }).html;
    assert.ok(filtered.includes(messages[language].hseAssetFilteredEmpty));
    assert.ok(!filtered.includes(messages[language].hseAssetEmpty));
    assert.match(filtered, /data-command="hse-assets-clear"/);
    assert.doesNotMatch(filtered, /<table|hseAsset|coreUnknown|undefined/);
    assert.match(source, /'hse-assets-clear': \(\) => \{ hseAssetFilters = \{ category: '', status: '' \}; render\(\); \}/);
  });

  test(`count line includes only non-zero states, singulars and plurals (${language})`, () => {
    const rows = [assets()[2], assets()[2], assets()[1]];
    const html = ui({ language, rows }).html;
    const expected = language === 'it' ? '3 soggetti — 2 scaduti, 1 in scadenza' : '3 subjects — 2 overdue, 1 due soon';
    assert.ok(html.includes(expected));
    const single = ui({ language, rows, filters: { status: 'due_soon' } }).html;
    assert.ok(single.includes(language === 'it' ? '1 soggetto — 1 in scadenza' : '1 subject — 1 due soon'));
  });
}

test('shared core table becomes phone cards below 800px and status cells retain readable text', () => {
  const { html } = ui();
  assert.match(html, /class="core-table-wrap"><table class="core-table"/);
  assert.match(html, /<td data-label="Stato"><span class="badge[^>]+><svg[^>]+[\s\S]*?<span>Scaduto<\/span>/);
  assert.match(css, /@media\(max-width:800px\)\{[\s\S]*?\.core-table tr,\.mobile-card-table tr\{display:block;[^}]*border-radius:10px/);
  assert.match(css, /\.core-table td::before,\.mobile-card-table td::before\{content:attr\(data-label\)/);
  assert.match(css, /\.badge\.inspection-never\s*\{[^}]*color: var\(--muted\)/);
  assert.match(css, /--muted:#5b6c72/);
});

test('inspection values are escaped and missing dates remain dashes', () => {
  const row = { ...assets()[4], name: '<img src=x>', code: '<b>code</b>', templateTitle: '<script>text</script>' };
  const { html } = ui({ rows: [row] });
  assert.match(html, /&lt;img src=x&gt;/);
  assert.match(html, /&lt;b&gt;code&lt;\/b&gt;/);
  assert.match(html, /&lt;script&gt;text&lt;\/script&gt;/);
  assert.equal((html.match(/<td data-label="(?:Ultima ispezione|Prossima scadenza)">—<\/td>/g) || []).length, 2);
  assert.doesNotMatch(html, /<img|<script|undefined/);
});

test('register keeps its event loader and actions; inspection loading and errors keep the toggle usable', () => {
  const register = ui({ layout: 'register' });
  assert.deepEqual(register.requested, ['hse']);
  assert.deepEqual(register.calls, ['enhance']);
  assert.match(register.html, /data-command="hse-new"/);
  assert.ok(register.html.includes(messages.it.hsePrivacy));
  assert.ok(register.html.includes('Register history'));
  for (const state of [{ pending: true }, { error: new Error('Synthetic') }]) {
    const { html } = ui(state);
    assert.equal((html.match(/data-command="hse-view"/g) || []).length, 2);
    assert.doesNotMatch(html, /hse-new|<table/);
  }
});

test('view defaults to register, persists in session storage and handles unavailable storage', () => {
  for (const saved of [null, 'register', 'invalid', 'inspections']) {
    const stored = new Map([['siteassistant-hse-view', saved]]);
    const context = createContext({ sessionStorage: { getItem: key => stored.get(key), setItem: (key, value) => stored.set(key, value) }, render() {},
      // selectHseView also resets the detail state introduced in increment 44.
      hseAssetDetail: { id: '', expanded: new Set() } });
    runInContext(fragment('let hseView =', 'function resetCore()'), context);
    assert.equal(runInContext('hseView', context), saved === 'inspections' ? 'inspections' : 'register');
    runInContext("selectHseView('inspections')", context);
    assert.equal(stored.get('siteassistant-hse-view'), 'inspections');
    runInContext("selectHseView('register')", context);
    assert.equal(stored.get('siteassistant-hse-view'), 'register');
  }
  const context = createContext({ sessionStorage: { getItem() { throw new Error('Storage unavailable'); }, setItem() { throw new Error('Storage unavailable'); } }, render() {},
    hseAssetDetail: { id: '', expanded: new Set() } });
  runInContext(fragment('let hseView =', 'function resetCore()'), context);
  assert.equal(runInContext('hseView', context), 'register');
  assert.doesNotThrow(() => runInContext("selectHseView('inspections')", context));
});

test('register action opens the subject in inspections with the matching inspection expanded', () => {
  const stored = new Map(), renders = [];
  const context = createContext({
    sessionStorage: { getItem: key => stored.get(key), setItem: (key, value) => stored.set(key, value) },
    hseAssetDetail: { id: '', expanded: new Set(['previous-inspection']) },
    render: () => renders.push('render'),
    target: { dataset: { assetId: 'synthetic-asset', inspectionId: 'synthetic-inspection' } },
  });
  runInContext(fragment('let hseView =', 'function resetCore()'), context);
  const action = /'hse-inspection-open': (\(\) => [^\n]+),/.exec(source)?.[1];
  assert.ok(action);
  runInContext(`(${action})()`, context);
  assert.equal(runInContext('hseView', context), 'inspections');
  assert.equal(stored.get('siteassistant-hse-view'), 'inspections');
  assert.equal(context.hseAssetDetail.id, 'synthetic-asset');
  assert.deepEqual([...context.hseAssetDetail.expanded], ['synthetic-inspection']);
  assert.deepEqual(renders, ['render']);
  runInContext("selectHseView('register')", context);
  assert.equal(context.hseAssetDetail.id, '');
  assert.equal(context.hseAssetDetail.expanded.size, 0);
});

test('asset client uses a read-only GET with encoded siteId and preserves nulls and response fields', async () => {
  const requests = [];
  const api = createApi({ baseUrl: 'https://api.example.invalid', fresh: true, fetchImpl: async (url, options) => {
    requests.push({ url, options });
    return Response.json([{ ...assets()[4], site_id: 'synthetic-site', template_code: 'synthetic', code: null }]);
  } });
  const rows = await api.listHseAssets({ siteId: 'synthetic /?&' });
  assert.equal(requests[0].url, 'https://api.example.invalid/api/hse/assets?siteId=synthetic+%2F%3F%26');
  assert.equal(requests[0].options.method ?? 'GET', 'GET');
  assert.equal(requests[0].options.body, undefined);
  assert.equal(requests[0].options.cache, 'reload');
  assert.equal(rows[0].siteId, 'synthetic-site');
  assert.equal(rows[0].templateCode, 'synthetic');
  assert.equal(rows[0].templateTitle, 'Synthetic family');
  assert.equal(rows[0].lastInspectionOn, null);
  assert.equal(rows[0].nextDueOn, null);
  assert.equal(rows[0].code, null);
});

test('asset loader caches per site, ignores stale completions and reloads after site reset', async () => {
  const calls = [], pending = [], renders = [];
  const context = createContext({
    siteId: 'synthetic-a', session: { user: { id: 'synthetic-user' } }, view: 'hse',
    moduleResources: { hse: ['hse', 'hseAssets'] }, coreCache: new Map(),
    freshApi: { listHseAssets: async input => { calls.push(input); return new Promise(resolve => pending.push(resolve)); } },
    render: () => renders.push(context.siteId), rememberTodayResource() {},
    hseAssetDetail: { id: '', expanded: new Set() },
  });
  runInContext(fragment('function coreResource(', 'const coreValue ='), context);
  const first = runInContext("coreResource('hseAssets')", context);
  assert.equal(first, runInContext("coreResource('hseAssets')", context));
  context.siteId = 'synthetic-b';
  const second = runInContext("coreResource('hseAssets')", context);
  pending[0]([{ name: 'Old site' }]); await first.promise;
  assert.equal(renders.length, 0);
  pending[1]([{ name: 'Current site' }]); await second.promise;
  assert.equal(runInContext("coreData('hseAssets')[0].name", context), 'Current site');
  assert.deepEqual(renders, ['synthetic-b']);
  runInContext(fragment('function resetCore()', 'async function loadBookingRows('), context);
  runInContext('resetCore()', context);
  const third = runInContext("coreResource('hseAssets')", context);
  pending[2]([]); await third.promise;
  assert.deepEqual(calls.map(input => input.siteId), ['synthetic-a', 'synthetic-b', 'synthetic-b']);
  assert.match(fragment('function selectSite(', 'function showModal('), /resetCore\(\)/);
});

test('service worker cache version is bumped', async () => {
  const sw = await readFile(new URL('../app/sw.js', import.meta.url), 'utf8');
  const version = Number(/siteassistant-v15-(\d+)/.exec(sw)?.[1]);
  assert.ok(Number.isInteger(version) && version >= 27, `cache version ${version} must follow the current build`);
});
