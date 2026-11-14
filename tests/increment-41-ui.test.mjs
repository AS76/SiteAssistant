import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createContext, runInContext } from 'node:vm';
import { formatDisplayNumber, counts, PRIORITIES, DEVIATION_STATUSES, groupDeviationRows, filterSortRecords,
  HSE_TYPES, HSE_SEVERITIES, filterHseEvents, hseCounts } from '../app/domain.mjs';
import { messages } from '../app/i18n.mjs';

const source = await readFile(new URL('../app/app.mjs', import.meta.url), 'utf8');
const css = await readFile(new URL('../app/styles.css', import.meta.url), 'utf8');
const shell = await readFile(new URL('../app/index.html', import.meta.url), 'utf8');
function section(start, end) {
  const from = source.indexOf(start), to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, start);
  return source.slice(from, to);
}
function media(condition) {
  const start = css.indexOf(`@media (${condition}) {`);
  assert.ok(start >= 0, condition);
  let depth = 1, end = css.indexOf('{', start) + 1, from = end;
  while (depth && end < css.length) { if (css[end] === '{') depth++; if (css[end] === '}') depth--; end++; }
  assert.equal(depth, 0);
  return css.slice(from, end - 1);
}
function ui({ language = 'it', width = 1440, tasks = [], diary = [], reconciliation, deviations = [], hse = [] } = {}) {
  const nodes = new Map();
  const node = selector => {
    if (!nodes.has(selector)) nodes.set(selector, { textContent: '', innerHTML: '', hidden: false,
      classList: { add() {} }, setAttribute() {}, insertAdjacentHTML() {} });
    return nodes.get(selector);
  };
  const data = { deviations, hse, reconciliation: reconciliation || { items: [], counts: { closed_without_date: 0, close_before_approval: 0 } } };
  const context = createContext({
    language, prefs: { currency: 'EUR', separators: language, decimals: 0 }, formatDisplayNumber, counts, PRIORITIES, DEVIATION_STATUSES, groupDeviationRows, filterSortRecords,
    HSE_TYPES, HSE_SEVERITIES, filterHseEvents, hseCounts, state: { sites: [{ id: 'site-1', code: 'SYN-01', name: 'Synthetic site with a long name' }], diary },
    siteId: 'site-1', actor: 'Synthetic user', loading: false, view: 'overview', session: { user: { id: 'user-1' } },
    t: key => { assert.ok(Object.hasOwn(messages[language], key), `${language}: ${key}`); return messages[language][key]; },
    today: () => '2026-11-14', siteTasks: () => tasks, currentSite: () => ({ code: 'SYN-01', name: 'Synthetic site with a long name' }),
    coreData: name => data[name], coreFilters: { deviations: { status: '', priority: '' }, hse: { type: '', severity: '', from: '', to: '' } },
    permissions: () => ({ hseWrite: true }), deviationView: 'board', reconciliationFilter: '', reconciliationOpen: true,
    compactNavigation: () => width < 800, window: { matchMedia: () => ({ matches: width <= 520 }) },
    syncBadge: () => '', icon: () => '', taskRow: () => '', renderOffline() {}, render() {},
    document: { documentElement: {} }, sessionStorage: { getItem: () => null },
    visibleModules: items => items, currentModules: () => [], MOBILE_PRIMARY: ['bookings'], NAV_ITEMS: ['bookings'],
    desktopNavigation: link => link('bookings'), bindDesktopNavigation() {}, $: node,
  });
  for (const [start, end] of [
    ['const esc =', 'let session ='], ['const money =', 'let offlineScope'], ['const button =', 'function toast('],
    ['function heading(', 'function renderChrome('], ['function renderChrome()', 'function dueMarkup('],
    ['const coreValue =', 'function renderCore('], ['function localOverviewWidgets()', '// Every report opening'],
    ['function earnedValueSummary(', 'const STATUS_COLORS'],
    ['const RECONCILIATION_KINDS', 'function renderProgress()'], ['function renderHse()', 'function showHseForm()'],
    ['function field(', 'function formError('],
  ]) runInContext(section(start, end), context);
  return { context, data, node, run: code => runInContext(code, context) };
}

test('41.01 A2 — phone main reserves space for the unchanged floating assistant', () => {
  assert.match(media('max-width: 520px'), /\.shell main\s*\{[^}]*padding-bottom:\s*calc\(164px \+ env\(safe-area-inset-bottom\)\)/);
  assert.match(css, /\.ai-fab\{[^}]*width:56px;height:56px/);
  assert.match(css, /\.ai-fab\{right:16px;bottom:calc\(84px \+ env\(safe-area-inset-bottom\)\);width:52px;height:52px/);
});

test('41.02 A3 — dates omit format hints and preserve associated semantic hints', () => {
  for (const language of ['it', 'en']) {
    const app = ui({ language });
    assert.doesNotMatch(source, /dateHint|date-hint|dateFormatHint/);
    assert.doesNotMatch(app.run(`field('hseOccurredOn', 'date', '2026-11-14', { type: 'date' })`), /aria-describedby/);
    const described = app.run(`field('hseOccurredOn', 'date', '2026-11-14', { type: 'date', hint: 'hseSummaryHint' })`);
    assert.match(described, /aria-describedby="field-hint-date"/);
    assert.ok(described.includes(`<small id="field-hint-date">${messages[language].hseSummaryHint}</small>`));
  }
});

test('41.03 A4 — the truncating selector exposes the full selected name and refreshes it', () => {
  const app = ui(); app.run('renderChrome()');
  assert.equal(app.node('#site-select').title, 'Synthetic site with a long name');
  app.context.state.sites.push({ id: 'site-2', name: 'Another synthetic site' });
  app.context.siteId = 'site-2'; app.run('renderChrome()');
  assert.equal(app.node('#site-select').title, 'Another synthetic site');
  app.context.siteId = undefined; app.run('renderChrome()'); assert.equal(app.node('#site-select').title, '');
});

test('41.04 A5 — both reconciliation counters toggle their loaded results and pressed state without API writes', () => {
  const items = ['closed_without_date', 'close_before_approval'].map((kind, index) => ({
    id: `finding-${index}`, kind, title: `Synthetic finding ${index}`, official_status: 'closed', disagreement_days: index,
  }));
  for (const language of ['it', 'en']) {
    const app = ui({ language, reconciliation: { items, counts: { closed_without_date: 1, close_before_approval: 1 } } });
    const before = structuredClone(app.data.reconciliation);
    const click = source.split('\n').find(line => line.includes("'reconciliation-filter':"));
    const handler = click.slice(click.indexOf('() =>'), click.lastIndexOf(','));
    for (const [index, kind] of ['closed_without_date', 'close_before_approval'].entries()) {
      app.context.target = { dataset: { kind } };
      app.run(`(${handler})()`);
      let html = app.run('renderReconciliation()');
      assert.match(html, new RegExp(`data-kind="${kind}" aria-controls="reconciliation-results" aria-pressed="true"`));
      assert.match(html, new RegExp(`data-id="finding-${index}"`));
      assert.doesNotMatch(html, new RegExp(`data-id="finding-${1 - index}"`));
      app.run(`(${handler})()`); html = app.run('renderReconciliation()');
      assert.doesNotMatch(html, /aria-pressed="true"/);
      for (let i = 0; i < 2; i++) assert.match(html, new RegExp(`data-id="finding-${i}"`));
    }
    assert.deepEqual(app.data.reconciliation, before);
    app.data.reconciliation.items = []; app.data.reconciliation.counts = { closed_without_date: 0, close_before_approval: 0 };
    app.run(`(${handler})()`);
    assert.match(app.run('renderReconciliation()'), /aria-pressed="true"/);
  }
});

test('41.05 M1 — one helper enforces money, hours, counts and percentage precision in IT/EN', () => {
  for (const [language, decimal, group] of [['it', ',', '.'], ['en', '.', ',']]) {
    const number = (value, kind, extra = {}) => formatDisplayNumber(value, { kind, language, ...extra });
    assert.ok(number(2400, 'money').includes(`2${group}400${decimal}00`));
    assert.ok(number(3, 'money', { currency: 'CHF' }).includes(`3${decimal}00`));
    assert.equal(number(585.2, 'hours'), `585${decimal}2`);
    assert.equal(number(696, 'hours'), `696${decimal}0`);
    assert.equal(number(12.72, 'hours'), `12${decimal}7`);
    assert.equal(number(0, 'hours'), `0${decimal}0`);
    assert.equal(number(-2, 'hours', { signed: true }), `-2${decimal}0`);
    assert.equal(number(17, 'count'), '17');
    assert.equal(number(25, 'percent'), '25');
    assert.equal(number(12.72, 'percent'), `12${decimal}72`);
    assert.equal(number(null, 'hours'), '—');
    const app = ui({ language });
    assert.equal(app.run('money(2400)'), number(2400, 'money'));
    app.context.prefs.currency = 'invalid';
    assert.equal(app.run('money(2400)'), '2400');
    assert.equal(app.run(`coreNumber(696, 'hours')`), `<span class="mono">696${decimal}0</span>`);
    const summary = app.run('earnedValueSummary({ available: true, ev_hours: 585.2, pv_hours: 696, ac_hours: 12.72, cpi: 1, spi: 0.84 })');
    for (const value of [`585${decimal}2`, `696${decimal}0`, `12${decimal}7`]) assert.ok(summary.includes(value));
  }
  assert.equal((source.match(/new Intl.NumberFormat/g) || []).length, 0);
  assert.doesNotMatch(source, /prefs\.decimals|name="decimals"/);
});

test('41.06 M2 — optional HSE people use a dash for absence and retain the known zero', () => {
  for (const language of ['it', 'en']) {
    for (const personsInvolved of [null, undefined, 0, 3]) {
      const app = ui({ language, hse: [{ id: 'event-1', type: 'near_miss', severity: 'low', occurredOn: '2026-11-14', personsInvolved }] });
      const html = app.run('renderHse()');
      const cell = html.match(new RegExp(`<td data-label="${messages[language].hsePersons}">(.*?)</td>`))[1];
      assert.equal(cell, personsInvolved == null ? '—' : `<span class="mono">${personsInvolved}</span>`);
      assert.equal(app.run('coreValue(null)'), messages[language].coreUnknown);
    }
  }
});

test('41.07 M3 — no blockers and no reviews share one line; the explanation requires a review', () => {
  for (const language of ['it', 'en']) {
    for (const statuses of [[], ['todo'], ['blocked'], ['to_verify'], ['blocked', 'to_verify']]) {
      const app = ui({ language, tasks: statuses.map((status, index) => ({ id: `task-${index}`, status })) });
      const html = app.run('localOverviewWidgets().daily_pulse');
      const summary = html.slice(html.indexOf('<div class="summary-stack">'));
      const hasReview = statuses.includes('to_verify'), hasBlocker = statuses.includes('blocked');
      assert.equal(summary.includes(messages[language].pulseClear), !hasReview && !hasBlocker);
      assert.equal(summary.includes(messages[language].workingRuleNote), hasReview);
      if (!hasReview && !hasBlocker) {
        assert.equal((summary.match(/<p/g) || []).length, 1);
        assert.doesNotMatch(summary, /class="summary-line"/);
      }
    }
  }
});

test('41.08 M4 — today diary has exactly one invitation: a button when empty, otherwise a link', () => {
  for (const language of ['it', 'en']) {
    const app = ui({ language, diary: [{ siteId: 'other-site', date: '2026-11-14', actual: 'Other synthetic entry' },
      { siteId: 'site-1', date: '2026-11-13', actual: 'Previous synthetic entry' }] });
    const empty = app.run('localOverviewWidgets().journal_today');
    assert.equal((empty.match(/data-command="go-diary"/g) || []).length, 1);
    assert.equal((empty.match(/<button/g) || []).length, 1);
    assert.ok(empty.includes(messages[language].noDiary)); assert.doesNotMatch(empty, /href="#diary"/);
    app.context.state.diary.push({ siteId: 'site-1', date: '2026-11-14', actual: 'Synthetic work completed' });
    const filled = app.run('localOverviewWidgets().journal_today');
    assert.equal((filled.match(/href="#diary"/g) || []).length, 1);
    assert.doesNotMatch(filled, /<button/); assert.match(filled, /Synthetic work completed/);
  }
  assert.match(source, /'go-diary': \(\) => \{ reportDate = today\(\); go\('diary'\); \}/);
});

test('41.09 M5 — person is plain text populated from the signed-in identity', () => {
  assert.match(shell, /<div class="actor-control"><span id="actor-label">Persona<\/span><span id="actor-name"><\/span><\/div>/);
  assert.doesNotMatch(shell + source, /actor-input/);
  const app = ui(); app.run('renderChrome()'); assert.equal(app.node('#actor-name').textContent, 'Synthetic user');
});

test('41.10 M6 — informative text is at least 11px; only spaced uppercase section headings may use 10px', () => {
  const exceptions = new Set(['.eyebrow', '.nav-label', '.nav-section', '.entry-section h3']);
  for (const [, selector, declarations] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    for (const [, size] of declarations.matchAll(/font-size:\s*([\d.]+)px/g)) {
      if (Number(size) >= 11) continue;
      assert.equal(Number(size), 10, selector.trim()); assert.ok(exceptions.has(selector.trim()), selector.trim());
      assert.match(declarations, /letter-spacing:\s*[\d.]+px/);
    }
  }
});

test('41.11 M7 — the phone eyebrow keeps the code and hides only the full site name at 520px', () => {
  const html = ui().run(`heading('overview', 'overviewSub')`);
  assert.match(html, /class="eyebrow">SYN-01<span class="eyebrow-site-name"> · Synthetic site with a long name<\/span>/);
  assert.match(media('max-width: 520px'), /\.eyebrow-site-name\s*\{\s*display:\s*none/);
  assert.equal((css.match(/\.eyebrow-site-name/g) || []).length, 1);
});

test('41.12 M8 — reconciliation follows the phone list and stays before it above 520px, including empty results', () => {
  for (const language of ['it', 'en']) for (const width of [390, 520, 521, 800, 1440]) for (const layout of ['board', 'list']) {
    const app = ui({ language, width }); app.context.deviationView = layout;
    const html = app.run('renderDeviations()');
    const position = html.indexOf('id="deviation-reconciliation"'); assert.ok(position >= 0);
    assert.equal(position > html.indexOf('class="toolbar core-toolbar"'), width <= 520);
    assert.equal((html.match(/id="deviation-reconciliation"/g) || []).length, 1);
    if (width <= 520) assert.ok(html.endsWith('</details>'));
  }
  assert.match(source, /matchMedia\('\(max-width: 520px\)'\)\.addEventListener\('change', \(\) => \{ if \(view === 'deviations'\) render\(\); \}\)/);
});

test('41.13 B1 — desktop and phone navigation use the same hours label and preserve the page title', () => {
  for (const language of ['it', 'en']) for (const width of [390, 1440]) {
    const app = ui({ language, width }); app.run('renderChrome()');
    assert.ok(app.node('#navigation').innerHTML.includes(`<span>${messages[language].bookingsShort}</span>`));
    assert.notEqual(messages[language].bookingsShort, messages[language].bookings);
  }
});

test('41.14 B2 — EV, PV and AC omit units and declare hours in one caption', () => {
  for (const language of ['it', 'en']) {
    const html = ui({ language }).run('earnedValueSummary({ available: true, ev_hours: 5, pv_hours: 6, ac_hours: 7, cpi: 1, spi: 1 })');
    for (const code of ['EV', 'PV', 'AC']) assert.ok(html.includes(`<dt>${code}</dt>`));
    assert.equal(html.split(messages[language].earnedValueHoursCaption).length - 1, 1);
    assert.doesNotMatch(html, /EV \(|PV \(|AC \(/);
  }
});

test('41.15 B3 — HSE actions stay inline with a separator and 44px coarse targets', () => {
  const html = ui({ hse: [{ id: 'event-1', type: 'observation', severity: 'low' }] }).run('renderHse()');
  assert.match(html, /class="tool-actions hse-actions">.*data-command="hse-edit".*<span aria-hidden="true">·<\/span>.*data-command="hse-delete"/);
  assert.match(css, /\.hse-actions\s*\{[^}]*display:\s*inline-flex;[^}]*flex-wrap:\s*nowrap/);
  assert.match(css, /@media \(pointer: coarse\)\s*\{\s*\.hse-actions button\s*\{[^}]*min-width:\s*44px;[^}]*min-height:\s*44px/);
});
