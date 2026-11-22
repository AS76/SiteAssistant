import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createContext, runInContext } from 'node:vm';
import { messages } from '../app/i18n.mjs';
import { formatDateInput, HSE_TYPES, HSE_MANUAL_TYPES, HSE_SEVERITIES, filterHseEvents, hseCounts } from '../app/domain.mjs';

const source = await readFile(new URL('../app/app.mjs', import.meta.url), 'utf8');
const css = await readFile(new URL('../app/styles.css', import.meta.url), 'utf8');

// Execute the real renderers without sockets or browser child processes.
function dateUi(language) {
  const main = { innerHTML: '' }, dialogs = [];
  const status = { textContent: '' };
  const context = createContext({
    language, formatDateInput, t: key => messages[language][key] || key,
    heading: () => '', empty: () => '', role: () => 'editor', canWriteTask: () => true,
    state: { diary: [] }, siteId: 'site-1', reportDate: '2026-11-10', offline: false, moduleVisible: () => true,
    currentSite: () => ({}), timeZoneForSite: () => 'Europe/Rome',
    dateLabel: date => date, today: () => '2026-11-10', operationalDay: () => ({ date: '2026-11-10', shift: 'day' }),
    coreData: () => [], coreFilters: { hse: { type: '', severity: '', from: '2026-11-01', to: '' } },
    permissions: () => ({ hseWrite: true }), hseEditingId: '',
    HSE_TYPES, HSE_MANUAL_TYPES, HSE_SEVERITIES, filterHseEvents, hseCounts,
    showModal: (title, html) => dialogs.push(html),
    wireLocationLookup: () => {}, wireTaskResponsibles: () => () => {},
    modalVersion: 0, PRIORITIES: ['normal'], TASK_KINDS: ['ordinary'], taskKindLabelKey: () => 'ordinary',
    freshApi: { listAssignable: async () => [], listWbs: async () => [] },
    taskWbsOptions: async () => '<option value=""></option>',
    $: selector => selector === '#main' ? main : selector === '#modal' ? { open: true }
      : selector === '#task-form' ? { querySelector: () => status } : null,
  });
  for (const [start, end] of [
    ['const esc =', '\nlet session'],
    ['const button =', 'function toast('],
    ['function field(', 'function formError('],
    ['const diaryContentFields =', 'async function loadWbs('],
    ['function coreSelect(', 'const coreDetailButton'],
    ['function renderHse()', 'function showHseDelete('],
    ['function showSiteForm()', 'function taskResponsibleFields('],
    ['function taskResponsibleFields()', 'function wireTaskResponsibles('],
    ['async function showTaskForm()', 'async function showDetail('],
  ]) {
    const from = source.indexOf(start), to = source.indexOf(end, from);
    assert.ok(from >= 0 && to > from, `Renderer source: ${start}`);
    runInContext(source.slice(from, to), context);
  }
  return { main, dialogs, run: script => runInContext(script, context) };
}

function assertDates(html, expected, language) {
  const inputs = [...html.matchAll(/<input\b[^>]*data-date-input[^>]*>/g)].map(match => match[0]);
  assert.equal(inputs.length, expected.length);
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(new Set(ids).size, ids.length, 'IDs must be unique');
  inputs.forEach((input, index) => {
    const { selector, value, required = false } = expected[index];
    assert.ok(input.includes(selector), selector);
    assert.ok(input.includes(`value="${formatDateInput(value, language)}"`));
    assert.match(input, /type="text"[^>]*inputmode="numeric" autocomplete="off"/);
    assert.equal(/\brequired\b/.test(input), required);
    const [, id] = /id="([^"]+)"/.exec(input);
    assert.ok(input.includes(`aria-describedby="${id}-format ${id}-error"`));
    assert.ok(input.includes(`placeholder="${language === 'it' ? 'GG/MM/AAAA' : 'MM/DD/YYYY'}"`));
    assert.ok(html.includes(`<small id="${id}-format">${messages[language].dateFormatHint}</small>`));
    assert.ok(html.includes(`<small id="${id}-error" class="date-error" role="alert"></small>`));
    assert.doesNotMatch(input, /maxlength/);
  });
}

for (const language of ['it', 'en']) {
  test(`diary date keeps its label with a localized format hint (${language})`, () => {
    const ui = dateUi(language);
    ui.run('renderDiary()');
    assertDates(ui.main.innerHTML, [{ selector: 'id="report-date"', value: '2026-11-10', required: true }], language);
    assert.equal([...ui.main.innerHTML.matchAll(/<label\b/g)].length, 1);
    assert.ok(ui.main.innerHTML.includes(`<label for="report-date">${messages[language].reportDate}</label>`));
  });

  test(`HSE period has two labelled dates in the phone layout container (${language})`, () => {
    const ui = dateUi(language), html = ui.run('renderHse()');
    assertDates(html, [
      { selector: 'data-core-filter="from"', value: '2026-11-01' },
      { selector: 'data-core-filter="to"', value: '' },
    ], language);
    const period = html.match(/<div class="hse-period-filters">([\s\S]*?)<\/div>/);
    assert.ok(period);
    const labels = [...period[1].matchAll(/<label class="field core-filter">([\s\S]*?)<\/label>/g)];
    assert.equal(labels.length, 2);
    for (const [index, key] of ['hseFrom', 'hseTo'].entries()) {
      assert.ok(labels[index][1].includes(`<span>${messages[language][key]}</span>`));
      assert.match(labels[index][1], /<input\b[^>]*data-date-input/);
    }
  });

  test(`HSE required event date and period coexist with distinct format and error IDs (${language})`, () => {
    const ui = dateUi(language), register = ui.run('renderHse()');
    ui.run('showHseForm()');
    const form = ui.dialogs.at(-1);
    assertDates(form, [{ selector: 'name="occurredOn"', value: '', required: true }], language);
    assertDates(register + form, [
      { selector: 'data-core-filter="from"', value: '2026-11-01' },
      { selector: 'data-core-filter="to"', value: '' },
      { selector: 'name="occurredOn"', value: '', required: true },
    ], language);
  });

  test(`new site start and end dates have localized format hints (${language})`, () => {
    const ui = dateUi(language);
    ui.run('showSiteForm()');
    assertDates(ui.dialogs.at(-1), [
      { selector: 'name="start"', value: '2026-11-10' },
      { selector: 'name="end"', value: '' },
    ], language);
  });

  test(`new task due date has a localized format hint (${language})`, async () => {
    const ui = dateUi(language);
    await ui.run('showTaskForm()');
    assertDates(ui.dialogs.at(-1), [{ selector: 'name="due"', value: '2026-11-10' }], language);
  });
}

test('date format and error are associated alongside semantic descriptions', () => {
  for (const language of ['it', 'en']) {
    const ui = dateUi(language);
    const html = ui.run(`field('hseOccurredOn', 'exampleDate', '2026-11-10', { type: 'date', hint: 'hseSummaryHint' })`);
    assert.match(html, /aria-describedby="field-exampleDate-format field-exampleDate-error field-hint-exampleDate"/);
    assert.ok(html.includes(`<small id="field-hint-exampleDate">${messages[language].hseSummaryHint}</small>`));
  }
});

function mediaBlock(condition) {
  const start = css.indexOf(`@media (${condition}) {`);
  assert.ok(start >= 0, `Missing media condition: ${condition}`);
  const open = css.indexOf('{', start);
  let depth = 1, end = open + 1;
  while (end < css.length && depth) {
    if (css[end] === '{') depth++;
    if (css[end] === '}') depth--;
    end++;
  }
  assert.equal(depth, 0);
  return css.slice(open + 1, end - 1);
}

test('coarse pointer date inputs share the 44px minimum target rule', () => {
  const block = mediaBlock('pointer: coarse');
  const rules = [...block.matchAll(/([^{}]+)\{([^{}]+)\}/g)];
  assert.ok(rules.some(([, selectors, declarations]) => selectors.split(',').map(s => s.trim()).includes('input[data-date-input]')
    && /min-height:\s*44px\s*;/.test(declarations)));
});

test('phone dates use 16px text and HSE period labels stack at full width', () => {
  const block = mediaBlock('max-width: 520px');
  assert.match(block, /input\[data-date-input\]\s*\{[^}]*font-size:\s*16px\s*;/);
  assert.match(block, /\.hse-period-filters\s*\{[^}]*display:\s*flex\s*;[^}]*flex-direction:\s*column\s*;[^}]*width:\s*100%\s*;/);
  assert.match(block, /\.hse-period-filters\s*>\s*\.core-filter\s*\{[^}]*flex:\s*none\s*;[^}]*width:\s*100%\s*;/);
  assert.match(css, /\.hse-period-filters\s*\{\s*display:\s*contents;\s*\}/);
});

test('service worker cache version includes the desktop navigation and contrast update', async () => {
  const worker = await readFile(new URL('../app/sw.js', import.meta.url), 'utf8');
  // A version bump must not fail this suite; a regression to an older cache must.
  const version = /const VERSION = 'siteassistant-v15-(\d+)'/.exec(worker);
  assert.ok(version, 'il service worker deve dichiarare una versione');
  assert.ok(Number(version[1]) >= 17, `versione del service worker troppo vecchia: ${version[0]}`);
});
