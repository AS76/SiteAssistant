import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createContext, runInContext } from 'node:vm';
import { createApi } from '../app/api.mjs';
import { initialView, navGroups, visibleModules, validDate } from '../app/domain.mjs';
import { messages } from '../app/i18n.mjs';

const source = await readFile(new URL('../app/app.mjs', import.meta.url), 'utf8');
const css = await readFile(new URL('../app/styles.css', import.meta.url), 'utf8');
const overview = () => ({ configured: true, scopes: [{
  scopeId: 'scope-a', projectReference: 'Synthetic project <A>', exportDate: '2026-11-12', loadedAt: '2026-11-13T10:15:00.000Z',
  counts: { employees: 11, work_days: 22, time_schedule: 33, site_progress_items: 44, daily_logs: 55, deviations: 66 },
  totalRows: 231, qualityIssues: 7,
}] });
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

function screen({ language = 'it', load = async () => overview() } = {}) {
  let panel, html, calls = 0, click;
  const pending = [], missingKeys = [];
  const main = {
    set innerHTML(value) {
      html = value;
      if (panel) panel.isConnected = false;
      panel = { innerHTML: value, isConnected: true, attributes: { 'aria-busy': 'true' },
        setAttribute(name, value) { this.attributes[name] = value; } };
    },
  };
  const context = createContext({
    language, messages, validDate, view: 'reporting', siteId: 'site-a', session: { user: { id: 'user-a' } },
    allowed: true, moduleVisible: () => context.allowed,
    document: { body: { contains: target => target.isConnected }, addEventListener: (_type, handler) => { click = handler; } },
    $: selector => selector === '#main' ? main : selector === '#reporting-overview' ? panel : null,
    t(key) { if (!Object.hasOwn(messages[context.language], key)) missingKeys.push(key); return messages[context.language][key] ?? key; },
    heading: (title, sub, actions) => `<h1>${context.t(title)}</h1><p>${context.t(sub)}</p>${actions}`,
    empty: (title, hint) => `<section><h2>${context.t(title)}</h2><p>${context.t(hint)}</p></section>`,
    freshApi: { reportingOverview() { calls++; const promise = Promise.resolve().then(load); pending.push(promise); return promise; } },
  });
  const slice = (start, end) => source.slice(source.indexOf(start), source.indexOf(end));
  // Use the production view, loader, formatters and delegated refresh handler.
  for (const [, name] of source.matchAll(/(?:async )?function (\w+)\(/g)) if (!(name in context)) context[name] = () => {};
  runInContext(slice('const esc =', 'let session =')
    + slice('const dateLabel =', 'const paths =')
    + slice('const button =', 'function toast(')
    + slice('function renderReporting()', 'function renderReport()')
    + slice("document.addEventListener('click',", "document.addEventListener('submit',"), context);
  return {
    context, missingKeys, get html() { return html; }, get panel() { return panel; }, get calls() { return calls; },
    render: () => context.renderReporting(),
    refresh: () => click({ target: { closest: () => ({ dataset: { command: 'reporting-refresh' } }) } }),
    async settle() { await Promise.allSettled(pending); await Promise.resolve(); },
  };
}

test('reporting navigation lives under Management and honors the module grant on both viewport sizes', () => {
  for (const width of [390, 1440]) assert.equal(initialView({ width, hash: '#reporting' }), 'reporting');
  assert.ok(navGroups().find(group => group.label === 'navManagement').items.includes('reporting'));
  assert.ok(!navGroups({ reporting: false }).flatMap(group => group.items).includes('reporting'));
  assert.deepEqual(visibleModules(['reporting'], { reporting: true }), ['reporting']);
  assert.deepEqual(visibleModules(['reporting'], { reporting: false }), []);
});

test('reporting API client is a credentialed, fresh, parameter-free GET', async () => {
  const calls = [], data = overview();
  const api = createApi({ baseUrl: 'https://api.example.invalid', fresh: true, fetchImpl: async (url, options) => {
    calls.push({ url, options }); return Response.json(data);
  } });
  assert.deepEqual(await api.reportingOverview(), data);
  assert.deepEqual(calls, [{ url: 'https://api.example.invalid/api/reporting/overview', options: { credentials: 'include', cache: 'reload' } }]);
});

test('reporting renders one aggregate card per scope with counts and date semantics in IT and EN', async () => {
  for (const language of ['it', 'en']) {
    const data = overview(); data.scopes.push({ ...data.scopes[0], scopeId: 'scope-b', projectReference: 'Synthetic project B' });
    const ui = screen({ language, load: async () => data }); ui.render();
    assert.match(ui.html, /data-command="reporting-refresh"/);
    assert.ok(ui.html.includes(messages[language].reportingSub));
    assert.ok(ui.html.includes(messages[language].reportingScopeNote));
    assert.ok(ui.html.includes(`<h1>${messages[language].reporting}</h1>`));
    assert.match(ui.panel.innerHTML, /role="status"/);
    assert.equal(ui.panel.attributes['aria-busy'], 'true');
    await ui.settle();
    const html = ui.panel.innerHTML;
    assert.equal((html.match(/<article /g) || []).length, 2);
    assert.match(html, /<span class="reporting-ref">Synthetic project &lt;A&gt;<\/span>/);
    assert.doesNotMatch(html, /<A>|<form|<input|data-command/);
    for (const value of [11, 22, 33, 44, 55, 66, 231]) assert.ok(html.includes(`<td>${value}</td>`));
    assert.ok(html.includes(`${messages[language].reportingQualityIssues}: <strong>7</strong>`));
    for (const family of Object.keys(data.scopes[0].counts)) assert.ok(html.includes(messages[language][`reportingFamily_${family}`]));
    assert.match(html, /scope-a/); assert.match(html, /scope-b/);
    assert.ok(html.includes(messages[language].reportingScopeId));
    assert.match(html, /datetime="2026-11-12"/);
    assert.match(html, /datetime="2026-11-13T10:15:00.000Z"/);
    const expectedDate = new Intl.DateTimeFormat(language === 'it' ? 'it-IT' : 'en-GB', { day: '2-digit', month: 'short', year: 'numeric' }).format(new Date('2026-11-12T12:00:00'));
    assert.ok(html.includes(expectedDate));
    const expectedTime = new Intl.DateTimeFormat(language === 'it' ? 'it-IT' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(data.scopes[0].loadedAt));
    assert.ok(html.includes(expectedTime));
    assert.equal(ui.panel.attributes['aria-busy'], 'false');
    assert.deepEqual(ui.missingKeys, []);
  }
});

test('reporting empty and not-configured states are distinct and bilingual', async () => {
  for (const language of ['it', 'en']) for (const configured of [true, false]) {
    const ui = screen({ language, load: async () => ({ configured, scopes: [] }) }); ui.render(); await ui.settle();
    assert.ok(ui.panel.innerHTML.includes(messages[language][configured ? 'reportingEmpty' : 'reportingNotConfigured']));
    assert.ok(ui.panel.innerHTML.includes(messages[language][configured ? 'reportingEmptyHint' : 'reportingNotConfiguredHint']));
    assert.doesNotMatch(ui.panel.innerHTML, /<table|<article/);
    assert.deepEqual(ui.missingKeys, []);
  }
});

test('reporting error state never displays backend details and refresh retries the read', async () => {
  for (const language of ['it', 'en']) {
    let fails = true;
    const ui = screen({ language, load: async () => { if (fails) throw new Error('Synthetic hidden connection details'); return overview(); } });
    ui.render(); await ui.settle();
    assert.match(ui.panel.innerHTML, /role="alert"/);
    assert.ok(ui.panel.innerHTML.includes(messages[language].reportingError));
    assert.doesNotMatch(ui.panel.innerHTML, /hidden connection/);
    assert.equal(ui.panel.attributes['aria-busy'], 'false');
    fails = false; ui.refresh(); await ui.settle();
    assert.equal(ui.calls, 2);
    assert.match(ui.panel.innerHTML, /<article/);
    assert.deepEqual(ui.missingKeys, []);
  }
});

test('reporting ignores late responses after refresh, navigation, site/account change or denial', async () => {
  const first = deferred(), second = deferred(); let calls = 0;
  const ui = screen({ load: () => (++calls === 1 ? first : second).promise });
  ui.render(); const old = ui.panel; ui.refresh();
  second.resolve({ configured: false, scopes: [] }); await Promise.resolve(); await Promise.resolve();
  first.resolve(overview()); await ui.settle();
  assert.ok(ui.panel.innerHTML.includes(messages.it.reportingNotConfigured));
  assert.doesNotMatch(old.innerHTML, /<article/);
  for (const change of ["view = 'tasks'", "siteId = 'site-b'", "session.user.id = 'user-b'", 'session = null', 'allowed = false']) {
    const pending = deferred(), other = screen({ load: () => pending.promise });
    other.render(); runInContext(change, other.context); pending.resolve(overview()); await other.settle();
    assert.doesNotMatch(other.panel.innerHTML, /<article/);
    if (["view = 'tasks'", 'session = null', 'allowed = false'].includes(change)) {
      const before = other.calls; other.refresh(); assert.equal(other.calls, before);
    }
  }
});

test('reporting labels have exact IT/EN key parity, including null metadata and zero counts', async () => {
  const keys = language => Object.keys(messages[language]).filter(key => key.startsWith('reporting')).sort();
  assert.deepEqual(keys('it'), keys('en'));
  for (const language of ['it', 'en']) {
    for (const key of keys(language)) assert.ok(messages[language][key].length);
    const data = overview(), scope = data.scopes[0];
    scope.projectReference = scope.exportDate = scope.loadedAt = null;
    for (const family of Object.keys(scope.counts)) scope.counts[family] = 0;
    scope.totalRows = scope.qualityIssues = 0;
    const ui = screen({ language, load: async () => data }); ui.render(); await ui.settle();
    assert.equal((ui.panel.innerHTML.match(/<td>0<\/td>/g) || []).length, 7);
    assert.ok(ui.panel.innerHTML.includes(messages[language].reportingUnknown));
    assert.doesNotMatch(ui.panel.innerHTML, /datetime="null"/);
    assert.deepEqual(ui.missingKeys, []);
  }
});

test('reporting references stay together and counts use a compact auto-layout table', () => {
  assert.match(css, /\.reporting-ref\s*\{\s*white-space: nowrap;/);
  assert.match(css, /\.reporting-scope \.table-scroll\s*\{\s*width: fit-content;\s*max-width: 100%;\s*\}/);
  assert.match(css, /\.reporting-scope table\s*\{[^}]*width: fit-content;[^}]*max-width: 100%;[^}]*min-width: 0;[^}]*table-layout: auto;[^}]*white-space: normal;/);
  assert.doesNotMatch(css, /\.reporting-scope[^{}]*\{[^}]*width:\s*(?:78|22)%;/);
  assert.match(css, /\.reporting-scope td:first-child\s*\{[^}]*min-width: 0;/);
  assert.match(css, /\.reporting-scope td:last-child\s*\{[^}]*padding-inline: 8px;[^}]*text-align: right;[^}]*font-variant-numeric: tabular-nums;/);
});


test('changing selected site preserves bundle provenance without inventing a site mapping', async () => {
  const ui = screen(); ui.render(); await ui.settle(); const first = ui.panel.innerHTML;
  ui.context.siteId = 'site-b'; ui.render(); await ui.settle();
  assert.equal(ui.panel.innerHTML, first);
  assert.doesNotMatch(ui.panel.innerHTML, /site-a|site-b/);
});
