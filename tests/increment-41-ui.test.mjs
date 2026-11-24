import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createContext, runInContext } from 'node:vm';
import { formatDisplayNumber, formatDateInput, counts, PRIORITIES, DEVIATION_STATUSES, groupDeviationRows, filterSortRecords, flattenWbs,
  validDate, HSE_TYPES, HSE_SEVERITIES, filterHseEvents, hseCounts, CERT_CATEGORIES, CERT_STATUSES,
  certCategoryLabelKey, certStatusLabelKey, filterCertifications, certificationCounts } from '../app/domain.mjs';
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
      attributes: {}, focused: false, classList: { add() {} }, setAttribute(key, value) { this.attributes[key] = value; }, focus() { this.focused = true; }, insertAdjacentHTML() {}, append(child) { child.parentElement = this; } });
    return nodes.get(selector);
  };
  const data = { deviations, hse, reconciliation: reconciliation || { items: [], counts: { closed_without_date: 0, close_before_approval: 0 } } };
  const context = createContext({
    supportsPasskeys: () => false, validDate, language, prefs: { currency: 'EUR', separators: language, decimals: 0 }, formatDisplayNumber, formatDateInput, counts, PRIORITIES, DEVIATION_STATUSES, groupDeviationRows, filterSortRecords, flattenWbs,
    HSE_TYPES, HSE_SEVERITIES, filterHseEvents, hseCounts, state: { sites: [{ id: 'site-1', code: 'SYN-01', name: 'Synthetic site with a long name' }], diary },
    siteId: 'site-1', actor: 'Synthetic user', loading: false, offline: false, view: 'overview',
    session: { user: { id: 'user-1' }, roles: [{ site_id: 'site-1', role: 'owner' }] },
    t: key => {
      const label = messages[language][key] ?? evidenceLabels[key]?.[language === 'it' ? 0 : 1];
      assert.equal(typeof label, 'string', `${language}: ${key}`);
      return label;
    },
    today: () => '2026-11-14', siteTasks: () => tasks, currentSite: () => context.state.sites.find(site => site.id === context.siteId),
    coreData: name => data[name], coreFilters: { deviations: { status: '', priority: '' }, hse: { type: '', severity: '', from: '', to: '' } },
    permissions: () => ({ hseWrite: true }), deviationView: 'board', reconciliationFilter: '', reconciliationOpen: true,
    compactNavigation: () => width < 800, window: { matchMedia: query => ({
      matches: query.includes('1180') ? (query.startsWith('(min-width') ? width >= 1180 : width < 1180) : width <= 520,
    }) },
    syncBadge: () => '', icon: () => '', taskRow: () => '', renderOffline() {}, render() {},
    document: { documentElement: {} }, sessionStorage: { getItem: () => null }, localStorage: { getItem: () => '1' },
    visibleModules: items => items, moduleVisible: () => true, currentModules: () => [], headerNavItems: () => ['bookings'], canWriteTask: () => true, canAttachDiary: () => true,
    desktopNavigation: link => link('bookings'), bindDesktopNavigation() {}, $: node,
  });
  const evidenceLabels = runInContext(section('const evidenceLabels =', 'const t =') + '\nevidenceLabels', context);
  for (const [start, end] of [
    ['const esc =', 'let session ='], ['const money =', 'let offlineScope'], ['const dateLabel =', 'const paths ='], ['const button =', 'function toast('],
    ['function heading(', 'function renderChrome('], ['function renderChrome()', 'function dueMarkup('],
    ['const role =', 'const currentModules ='],
    ['const canAttachDiary =', 'const canTransitionTask ='],
    ['const notebookStates =', 'function todayTaskItem('],
    ['const coreValue =', 'function renderCore('], ['function localOverviewWidgets()', '// Every report opening'],
    ['function earnedValueSummary(', 'const STATUS_COLORS'],
    ['const deviationGlyphs =', 'function renderProgress()'], ['function renderHse()', 'function showHseForm()'],
    ['function field(', 'function formError('],
    ['function renderOverview()', 'function localOverviewWidgets()'],
  ]) runInContext(section(start, end), context);
  return { context, data, node, run: code => runInContext(code, context) };
}

test('41.01 A2 — desktop floating assistant moves to the top bar on phones', () => {
  assert.match(css, /\.shell:has\(#navigation:not\(\[hidden\]\)\) \{ padding-bottom: calc\(56px \+ env\(safe-area-inset-bottom\)\)/);
  assert.match(css, /\.ai-fab\s*\{[^}]*width: 48px; height: 48px/);
  assert.match(css, /@media \(width < 1180px\) \{\s*\.ai-fab \{ display: none; \}\s*\.ai-top \{ display: inline-flex;/);
  for (const id of ['ai-fab', 'ai-top']) assert.match(shell, new RegExp(`<button id="${id}"[^>]*data-command="ai-open"[^>]*aria-expanded="false" aria-controls="ai-panel"`));
  for (const width of [390, 800, 1440]) {
    const app = ui({ width }); app.context.renderAssistant = () => {};
    app.run('renderChrome()');
    for (const id of ['ai-fab', 'ai-top', 'ai-panel']) assert.equal(app.node(`#${id}`).hidden, true);
    app.context.state.sites[0].assistant_enabled = true;
    app.run('renderChrome()');
    for (const id of ['ai-fab', 'ai-top']) assert.equal(app.node(`#${id}`).hidden, false);
    for (const command of ['ai-open', 'ai-close']) {
      const line = source.split('\n').find(line => line.includes(`'${command}':`));
      app.run(`(${line.slice(line.indexOf('() =>'), line.lastIndexOf(','))})()`);
      assert.equal(app.node('#ai-panel').hidden, command === 'ai-close');
      for (const id of ['ai-fab', 'ai-top']) assert.equal(app.node(`#${id}`).attributes['aria-expanded'], String(command === 'ai-open'));
    }
    assert.equal(app.node(width < 1180 ? '#ai-top' : '#ai-fab').focused, true);
    app.context.session = null; app.run('renderChrome()');
    for (const id of ['ai-fab', 'ai-top', 'ai-panel']) assert.equal(app.node(`#${id}`).hidden, true);
  }
});

test('41.02 A3 — dates associate localized format and error with semantic hints', () => {
  for (const language of ['it', 'en']) {
    const app = ui({ language });
    const described = app.run(`field('hseOccurredOn', 'date', '2026-11-14', { type: 'date', hint: 'hseSummaryHint' })`);
    assert.match(described, /aria-describedby="field-date-format field-date-error field-hint-date"/);
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
    app.context.prefs.separators = 'auto';
    assert.equal(app.run('money(2400)'), number(2400, 'money'));
    app.context.prefs.separators = language === 'it' ? 'en' : 'it';
    assert.equal(app.run('money(2400)'), formatDisplayNumber(2400, { kind: 'money', language: app.context.prefs.separators, currency: 'EUR' }));
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
    app.context.operationalDay = () => ({ date: '2026-11-14' });
    const empty = app.run('localOverviewWidgets().journal_today');
    assert.equal((empty.match(/data-command="go-diary"/g) || []).length, 1);
    assert.equal((empty.match(/<button/g) || []).length, 1);
    assert.ok(empty.includes(messages[language].noDiary)); assert.doesNotMatch(empty, /href="#diary"/);
    assert.match(empty, /datetime="2026-11-14"/);
    app.context.state.diary.push({ siteId: 'site-1', date: '2026-11-14', actual: 'Synthetic work completed' });
    const filled = app.run('localOverviewWidgets().journal_today');
    assert.equal((filled.match(/href="#diary"/g) || []).length, 1);
    assert.match(filled, /href="#diary" data-command="go-diary"/);
    assert.doesNotMatch(filled, /<button/); assert.match(filled, /Synthetic work completed/);
    app.context.siteId = 'other-site';
    app.context.operationalDay = () => ({ date: '2026-11-15' });
    const changed = app.run('localOverviewWidgets().journal_today');
    assert.match(changed, /datetime="2026-11-15"/);
    assert.doesNotMatch(changed, /Synthetic work completed|Other synthetic entry/);
  }
  assert.match(source, /'go-diary': .*reportDate = operationalDay\(\).date; go\('diary'\)/);
});

test('41.09 M5 — person is plain text populated from the signed-in identity', () => {
  assert.match(shell, /<span class="actor-control"><span id="actor-name"><\/span><strong id="actor-role"><\/strong><\/span>/);
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

test('deviation details show the localized source field without changing the record', async () => {
  for (const language of ['it', 'en']) {
    const app = ui({ language });
    const modal = app.node('#modal');
    const row = { id: 'synthetic', siteId: 'site-1', status: 'open', sourceSystem: 'internal',
      creationDate: '2026-10-30T23:00:00Z', closedDate: '2026-10-30T23:00:00Z', sourceExportDate: '2026-10-30', dueDate: null };
    app.context.session.roles[0].role = 'viewer';
    Object.assign(app.context, {
      modalVersion: 0, navigator: { onLine: true }, state: { attachments: [] },
      freshApi: { getDeviation: async () => row, listDeviationEvents: async () => [], listAttachments: async () => [] },
      todayResource: () => [], rememberTodayResource() {},
      showModal: (_title, html) => { modal.open = true; modal.innerHTML = html; },
    });
    app.run(section('function coreFields(', 'function progressStepsSection('));
    app.run(section('const deviationWrite =', 'function showBookingDelete('));
    app.run(section('function attachmentSection(', 'function showAttachmentForm('));
    const field = language === 'it' ? 'Sistema sorgente' : 'Source system';
    const manual = language === 'it' ? 'Inserimento manuale' : 'Manual entry';
    const missing = language === 'it' ? 'Non disponibile' : 'Not available';
    await app.run("showCoreDetail('deviations', 'synthetic')");
    assert.ok(modal.innerHTML.includes(`<dt>${field}</dt><dd>${manual}</dd>`));
    const localDate = language === 'it' ? '30 ott 2026' : '30 Oct 2026';
    for (const label of [messages[language].coreCreated, messages[language].coreClosed, app.run("t('evidenceExportDate')")]) {
      assert.ok(modal.innerHTML.includes(`<dt>${label}</dt><dd>${localDate}</dd>`), label);
    }
    assert.ok(modal.innerHTML.includes(`<dt>${messages[language].due}</dt><dd>${messages[language].coreUnknown}</dd>`));
    assert.doesNotMatch(modal.innerHTML, /2026-10-30/);
    assert.equal(row.sourceSystem, 'internal');
    row.sourceSystem = null;
    await app.run("showCoreDetail('deviations', 'synthetic')");
    assert.ok(modal.innerHTML.includes(`<dt>${field}</dt><dd>${missing}</dd>`));
    assert.equal(row.sourceSystem, null);
  }
});

test('deviation, HSE and fitness registers localize displayed dates in Italian and English', () => {
  const day = '2026-10-30';
  for (const [language, expected] of [['it', '30 ott 2026'], ['en', '30 Oct 2026']]) {
    const app = ui({ language,
      deviations: [{ id: 'd', status: 'open', creationDate: `${day}T23:00:00Z`, closedDate: null, lastSeenInExportDate: day }],
      hse: [{ id: 'e', type: 'observation', severity: 'low', occurredOn: day }],
    });
    Object.assign(app.data, {
      certifications: [{ id: 'c', employeeId: 'employee', category: 'qualification', name: 'Synthetic qualification',
        status: 'valid', issuedOn: day, expiresOn: day }],
      employees: [{ id: 'employee', firstName: 'Synthetic employee' }],
    });
    Object.assign(app.context, { CERT_CATEGORIES, CERT_STATUSES, certCategoryLabelKey, certStatusLabelKey,
      filterCertifications, certificationCounts, deviationView: 'list' });
    app.context.coreFilters.certifications = { employee: '', category: '', status: '' };
    app.run(section('function certificationStatusBadge(', 'function showCertificationForm('));
    for (const [renderer, dates] of [['renderDeviations()', 2], ['renderHse()', 1], ['renderCertifications()', 2]]) {
      const html = app.run(renderer);
      assert.equal(html.split(expected).length - 1, dates, renderer);
      assert.doesNotMatch(html, /2026-10-30/);
    }
  }
});

test('progress list and item detail link the server-reported verification conflict', async () => {
  for (const [language, expected] of [
    ['it', 'Avanzamento dichiarato 100%, verifica aperta (2 attività)'],
    ['en', 'Progress reported at 100%, verification open (2 tasks)'],
  ]) {
    const app = ui({ language });
    const modal = app.node('#modal');
    const item = { id: 'complete', siteId: 'site-1', wbsId: 'node-a', progressPct: 100, verificationConflict: true, verificationOpenTasks: 2 };
    const rows = [item,
      { ...item, id: 'above', progressPct: 101, verificationConflict: false },
      { ...item, id: 'below', progressPct: 80, verificationConflict: false },
      { ...item, id: 'verified', verificationConflict: false, verificationOpenTasks: 0, openVerifications: 1 },
      { ...item, id: 'cached', verificationConflict: undefined, verificationOpenTasks: undefined, openVerifications: 2 },
    ];
    Object.assign(app.data, { progress: rows, progressTypes: [], wbs: [] });
    app.context.coreFilters.progress = { wbsId: '' };
    Object.assign(app.context, {
      modalVersion: 0, navigator: { onLine: true }, moduleVisible: () => true,
      freshApi: { getProgress: async id => rows.find(row => row.id === id) },
      todayResource: () => [], rememberTodayResource() {},
      showModal: (_title, html) => { modal.open = true; modal.innerHTML = html; },
    });
    app.run(section('function renderProgress()', 'function renderBookings()'));
    app.run(section('function coreFields(', 'const deviationWrite ='));
    app.run(section('const deviationWrite =', 'function showBookingDelete('));
    const link = `<a href="#tasks" data-command="progress-verifications" data-id="node-a">${expected}</a>`;
    const list = app.run('renderProgress()');
    assert.equal(list.split(link).length - 1, 1);
    assert.equal((list.match(/progress-verification-warning/g) || []).length, 1);
    for (const row of rows) {
      await app.run(`showCoreDetail('progress', '${row.id}')`);
      assert.equal(modal.innerHTML.includes(link), row === item, row.id);
      assert.doesNotMatch(modal.innerHTML, /role="alert"/);
    }
  }
});

test('41.13 B1 — desktop and tablet navigation use the same hours label and preserve the page title', () => {
  for (const language of ['it', 'en']) for (const width of [900, 1440]) {
    const app = ui({ language, width }); app.run('renderChrome()');
    assert.ok(app.node('#navigation').innerHTML.includes(`<span>${messages[language].bookingsShort}</span>`));
    assert.notEqual(messages[language].bookingsShort, messages[language].bookings);
  }
});

test('41.14 B2 — work produced explains hours in plain language and flags partial bookings', () => {
  for (const language of ['it', 'en']) {
    const html = ui({ language }).run('earnedValueSummary({ available: true, ev_hours: 5, pv_hours: 6, ac_hours: 7, cpi: 1, spi: 1 })');
    for (const key of ['earnedValuePlanned', 'earnedValueProduced', 'earnedValueBooked', 'earnedValueEfficiency', 'earnedValueSchedule']) {
      assert.ok(html.includes(messages[language][key]), `${language}: ${key}`);
    }
    assert.equal(html.split(messages[language].earnedValueIntro).length - 1, 1);
    assert.match(html, /class="earned-bars"/);
    assert.doesNotMatch(html, /<dt>(EV|PV|AC)<\/dt>/);
    assert.ok(!html.includes(messages[language].earnedValuePartial));
    const partial = ui({ language }).run('earnedValueSummary({ available: true, ev_hours: 10, pv_hours: 12, ac_hours: 3, cpi: 1, spi: 1 })');
    assert.equal(partial.split(messages[language].earnedValuePartial).length - 1, 1);
    assert.ok(partial.includes(messages[language].earnedValuePartialBadge));
  }
});

test('41.15 B3 — HSE actions stay inline with a separator and 44px coarse targets', () => {
  const html = ui({ hse: [{ id: 'event-1', type: 'observation', severity: 'low' }] }).run('renderHse()');
  assert.match(html, /class="tool-actions hse-actions">.*data-command="hse-edit".*<span aria-hidden="true">·<\/span>.*data-command="hse-delete"/);
  assert.match(css, /\.hse-actions\s*\{[^}]*display:\s*inline-flex;[^}]*flex-wrap:\s*nowrap/);
  assert.match(css, /@media \(pointer: coarse\)\s*\{\s*\.hse-actions button\s*\{[^}]*min-width:\s*44px;[^}]*min-height:\s*44px/);
});

test('bilingual demo legend renders before sign-in and above overview cards in IT/EN', () => {
  const expected = {
    it: "Northline Piacenza presenta dati in italiano e Northline Midlands in inglese. L'interfaccia segue la lingua scelta.",
    en: 'Northline Piacenza has Italian data and Northline Midlands has English data. The interface follows your chosen language.',
  };
  for (const language of ['it', 'en']) for (const width of [390, 1440]) {
    const app = ui({ language, width }), inserted = [];
    app.context.session = null;
    app.context.loadError = null;
    app.context.loginRetryUntil = 0;
    app.context.document.body = { classList: { toggle() {} } };
    let legendExists = false;
    app.context.$ = selector => selector === '#login-demo-language' && !legendExists ? null : app.node(selector);
    app.node('#demo-banner').insertAdjacentHTML = (position, html) => {
      inserted.push({ position, html }); legendExists = true;
    };
    app.run(section('function render() {', 'function go('));
    app.run('render()');
    assert.match(app.node('#main').innerHTML, /id="login-form"/);
    assert.deepEqual(inserted, [{ position: 'afterend', html: '<div id="login-demo-language" class="demo-banner"></div>' }]);
    const loginLegend = app.node('#login-demo-language');
    assert.equal(loginLegend.hidden, false);
    const html = loginLegend.innerHTML;
    assert.match(html, /<p class="note demo-language-note" role="note"/);
    assert.ok(html.includes(`aria-label="${messages[language].demoLanguageLabel}"`));
    const text = html.replace(/<[^>]+>/g, '').replaceAll('&#39;', "'");
    assert.equal(text, expected[language]);
    assert.doesNotMatch(html, /<button|hidden|data-command/);

    app.context.session = { user: { id: 'user-1' } };
    app.context.canImport = () => false;
    app.context.canWriteTask = () => false;
    app.context.loadOverviewDashboard = () => {};
    app.run('renderChrome(); renderOverview()');
    assert.equal(loginLegend.hidden, true);
    assert.equal(loginLegend.innerHTML, '');
    const overview = app.node('#main').innerHTML;
    assert.equal(overview.split(html).length - 1, 1, 'Overview reuses the same accessible sentence');
    assert.ok(overview.indexOf(html) > overview.indexOf('</h1>'));
    assert.ok(overview.indexOf(html) < overview.indexOf('id="overview-widgets"'));
    assert.equal(inserted.length, 1, 'Rerendering reuses the login legend container');
  }
  assert.deepEqual(Object.keys(messages.it).sort(), Object.keys(messages.en).sort());
});

test('demo legend wraps within 390px containers without truncation or horizontal scrolling', () => {
  // Structural CSS checks only: no browser layout engine or pixel measurements.
  const declarations = /\.demo-language-note\s*\{([^}]+)\}/.exec(css)?.[1];
  assert.ok(declarations);
  assert.match(declarations, /min-width:\s*0\s*;/);
  assert.match(declarations, /max-width:\s*100%\s*;/);
  assert.match(declarations, /white-space:\s*normal\s*;/);
  assert.match(declarations, /overflow-wrap:\s*anywhere\s*;/);
  assert.doesNotMatch(declarations, /(?:width|min-width):\s*\d+px|nowrap|hidden|ellipsis|line-clamp/);
  assert.match(css, /#login-demo-language \.demo-language-note\s*\{\s*margin:\s*0;\s*color:\s*inherit;/);
  assert.match(css, /\.shell \{ --shell-gutter: 16px; \}/);
  assert.match(css, /\.shell main \{[^}]*padding: 26px var\(--shell-gutter\) 45px/);
  assert.match(css, /\*\{box-sizing:border-box\}/);
});

test('money preferences migrate old separators once while preserving currency and later explicit choices', () => {
  for (const [separators, expected] of [[undefined, 'auto'], [null, 'auto'], ['invalid', 'auto'], ['auto', 'auto'], ['it', 'it'], ['en', 'en']]) {
    let value = JSON.stringify({ version: 2, currency: 'CHF', separators });
    const context = createContext({ localStorage: { getItem: () => value, setItem: (_key, next) => { value = next; } } });
    runInContext(section('const PREF_KEY =', 'const money ='), context);
    assert.deepEqual(JSON.parse(value), { version: 2, currency: 'CHF', separators: expected });
  }
  for (const stored of [null, { currency: 'CHF', separators: 'it' }, { version: 1, currency: 'USD', separators: 'en' }]) {
    let value = JSON.stringify(stored);
    const context = createContext({ localStorage: { getItem: () => value, setItem: (_key, next) => { value = next; } } });
    const preferences = section('const PREF_KEY =', 'const money =');
    runInContext(preferences, context);
    assert.deepEqual(JSON.parse(value), { version: 2, currency: stored?.currency || 'EUR', separators: 'auto' });
    runInContext("prefs.separators = 'en'; savePrefs()", context);
    runInContext(preferences, createContext({ localStorage: { getItem: () => value, setItem: (_key, next) => { value = next; } } }));
    assert.equal(JSON.parse(value).separators, 'en');
  }
  for (const language of ['it', 'en']) {
    const app = ui({ language });
    app.context.showModal = (_title, html) => { app.context.settings = html; };
    app.context.formActions = () => '';
    app.run(section('function showSettingsForm()', 'async function showImportForm()'));
    app.context.prefs.separators = 'auto'; app.run('showSettingsForm()');
    assert.ok(app.context.settings.includes(messages[language].settingsSeparatorsAuto));
    assert.match(app.context.settings, /option value="auto" selected/);
  }
});

test('diary shows the selected date, chronological contributions and localized counts', t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-21T12:00:00Z') });
  for (const language of ['it', 'en']) {
    const app = ui({ language });
    app.context.reportDate = '2026-11-14';
    app.context.session.roles[0].role = 'editor';
    app.context.Date = Date;
    app.run(section('const diaryContentFields =', 'async function loadWbs()'));
    app.run('renderDiary()');
    const html = app.node('#main').innerHTML;
    assert.ok(html.includes(`value="${language === 'it' ? '14/11/2026' : '11/14/2026'}"`));
    assert.ok(html.includes(app.run("dateLabel(reportDate)")));
    assert.ok(html.includes(`0 ${messages[language].entries}`));
    assert.ok(html.includes(messages[language].diaryLimit));
    app.context.state.diary.push({ id: 'later', siteId: 'site-1', date: app.context.reportDate, shift: 'night',
      createdAt: '2026-11-20T19:00:00Z', actual: 'Synthetic later entry', author_id: 'other-user',
      updated_at: '2026-11-21T10:00:00Z', updated_by_name: 'Synthetic editor' });
    app.run('renderDiary()');
    assert.ok(app.node('#main').innerHTML.includes(`1 ${messages[language].entriesOne}`));
    app.context.state.diary.push({ ...app.context.state.diary[0], id: 'earlier', shift: 'day',
      createdAt: '2026-11-20T13:00:00Z', actual: 'Synthetic earlier entry', author_id: 'user-1',
      updated_at: null, updated_by_name: null });
    app.run('renderDiary()');
    const register = app.node('#main').innerHTML;
    assert.ok(register.includes(`2 ${messages[language].entries}`));
    assert.ok(register.indexOf('Synthetic earlier entry') < register.indexOf('Synthetic later entry'));
    assert.doesNotMatch(register, /data-command="new-entry"/);
    assert.match(register, /data-command="diary-correct" data-id="earlier"/);
    assert.doesNotMatch(register, /data-command="diary-correct" data-id="later"/);
    assert.match(register, /data-command="diary-versions" data-id="later"/);
    assert.ok(register.includes('Synthetic editor'));
    t.mock.timers.setTime(Date.parse('2026-11-22T12:00:00Z'));
    app.run('renderDiary()');
    assert.doesNotMatch(app.node('#main').innerHTML, /data-command="diary-correct"/);
    app.context.state.diary[0].recorded_late = true;
    app.context.state.diary[0].createdAt = '2026-11-22T11:00:00Z';
    app.run('renderDiary()');
    assert.ok(app.node('#main').innerHTML.includes(messages[language].diaryRecordedLate.split('{date}')[0]));
    t.mock.timers.setTime(Date.parse('2026-11-21T12:00:00Z'));
  }
});

test('41.07 M2 — mobile pages keep their scale: no pinch zoom, no focus zoom, no text inflation', () => {
  assert.match(shell, /<meta name="viewport" content="[^"]*width=device-width[^"]*initial-scale=1[^"]*maximum-scale=1[^"]*user-scalable=no/);
  assert.match(css, /html\{[^}]*-webkit-text-size-adjust:100%;text-size-adjust:100%;touch-action:pan-x pan-y/);
  assert.match(css, /@media \(max-width: 800px\) \{\s*input, select, textarea \{ font-size: 16px !important; \}/);
  assert.match(source, /for \(const type of \['gesturestart', 'gesturechange', 'gestureend'\]\)/);
  assert.match(source, /if \(event\.touches\.length > 1\) event\.preventDefault\(\)/);
});

test('WBS filter announces exact and subtree scopes with unique visible item counts', () => {
  for (const language of ['it', 'en']) {
    const app = ui({ language });
    const child = { id: 'child', wbs_code: '1.1', description: 'Child node', children: [] };
    Object.assign(app.data, { wbs: [{ id: 'root', wbs_code: '1', description: 'Root node', children: [child] }, child],
      progress: [{ id: 'root-row', wbsId: 'root' }, { id: 'child-row', wbsId: 'child' }, { id: 'unassigned' }] });
    app.context.coreFilters.progress = { wbsId: 'root' };
    app.run(section('function renderProgress()', 'function openProgressVerifications('));
    const exact = app.run('renderProgress()');
    assert.ok(exact.includes(messages[language].wbsScopeExact));
    assert.doesNotMatch(exact, /child-row|unassigned/);
    app.context.coreFilters.progress.includeDescendants = true;
    const subtree = app.run('renderProgress()');
    assert.ok(subtree.includes(messages[language].wbsScopeSubtree));
    assert.equal((subtree.match(/data-id="child-row"/g) || []).length, 1);
    assert.doesNotMatch(subtree, /unassigned/);
  }
});

test('progress explains empty data and labels the origin of measured zero and calculated values', () => {
  for (const language of ['it', 'en']) {
    const app = ui({ language });
    Object.assign(app.data, { wbs: [], progress: [] });
    app.context.coreFilters.progress = { wbsId: '' };
    app.run(section('function renderProgress()', 'function openProgressVerifications('));
    assert.ok(app.run('renderProgress()').includes(messages[language].progressEmptyHint));
    app.data.progress = [{ id: 'import-zero', progressPct: 0, progressPctSource: 'imported' },
      { id: 'app-progress', progressPct: 20, progressPctSource: 'computed' },
      { id: 'missing', progressPct: null, progressPctSource: 'imported' }];
    const html = app.run('renderProgress()');
    assert.equal(html.split(messages[language].coreImported).length - 1, 1);
    assert.equal(html.split(messages[language].coreComputed).length - 1, 1);
    assert.match(html, /value="0"/);
    assert.ok(html.includes(messages[language].coreUnknown));
  }
});
