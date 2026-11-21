import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createContext, runInContext } from 'node:vm';

const source = await readFile(new URL('../app/app.mjs', import.meta.url), 'utf8');
const from = source.indexOf('function renderCore()');
const to = source.indexOf('function auditEntityType()', from);
assert.ok(from >= 0 && to > from);
const renderCoreSource = source.slice(from, to);

// Regression: coreResource takes an optional loader, so passing it straight to
// Array#map made the second resource receive the array index and throw
// "(loader || loaders[name]) is not a function". Every two-resource view broke.
test('renderCore asks each resource by name, never with the map index', () => {
  const main = { innerHTML: '', insertAdjacentHTML(_position, html) { this.innerHTML += html; }, setAttribute() {} };
  const content = { ...main };
  const calls = [];
  const context = createContext({
    view: 'deviations', hseView: 'register', hseAssetDetail: { id: '' },
    language: 'it', offline: false, navigator: { onLine: true },
    moduleResources: { deviations: ['deviations', 'reconciliation'] },
    coreFilters: {}, columnFiltersOn: false,
    $: selector => ({ '#main': main, '#deviation-content': content })[selector],
    coreResource: (...args) => { calls.push(args); return { pending: false, error: null, data: [] }; },
    heading: () => '', button: () => '', empty: () => '', t: key => key,
    permissions: () => ({ hse: true, hseWrite: true }), errorMessage: () => '',
    renderDeviations: () => '<div id="deviation-board"></div>',
    renderProgress: () => '', renderBookings: () => '', renderImpacts: () => '', renderTools: () => '',
    renderCertifications: () => '', renderHse: () => '', renderHseAssets: () => '', renderHseAssetDetail: () => '',
    renderAuditPanel: () => '', bindAuditPanel() {}, enhanceCoreTables() {},
    updateDeviationBoardScroll() {},
  });
  runInContext(renderCoreSource, context);
  runInContext('renderCore()', context);
  assert.deepEqual(calls.map(args => args.length), [1, 1]);
  assert.deepEqual(calls.map(args => args[0]), ['deviations', 'reconciliation']);
  assert.match(content.innerHTML, /deviation-board/);
});
