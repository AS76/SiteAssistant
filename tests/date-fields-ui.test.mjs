import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createContext, runInContext } from 'node:vm';
import { messages } from '../app/i18n.mjs';
import { HSE_TYPES, HSE_SEVERITIES, filterHseEvents, hseCounts } from '../app/domain.mjs';

const source = await readFile(new URL('../app/app.mjs', import.meta.url), 'utf8');
const css = await readFile(new URL('../app/styles.css', import.meta.url), 'utf8');

// Execute the real renderers without sockets or browser child processes.
function dateUi(language) {
  const main = { innerHTML: '' }, dialogs = [];
  const status = { textContent: '' };
  const context = createContext({
    t: key => messages[language][key] || key,
    heading: () => '', empty: () => '', role: () => 'editor',
    state: { diary: [] }, siteId: 'site-1', reportDate: '2026-11-10',
    dateLabel: date => date, today: () => '2026-11-10',
    coreData: () => [], coreFilters: { hse: { type: '', severity: '', from: '2026-11-01', to: '' } },
    permissions: () => ({ hseWrite: true }), hseEditingId: '',
    HSE_TYPES, HSE_SEVERITIES, filterHseEvents, hseCounts,
    showModal: (title, html) => dialogs.push(html),
    wireLocationLookup: () => {}, wireTaskResponsibles: () => () => {},
    modalVersion: 0, PRIORITIES: ['normal'], TASK_KINDS: ['ordinary'], taskKindLabelKey: () => 'ordinary',
    freshApi: { listAssignable: async () => [] },
    $: selector => selector === '#main' ? main : selector === '#modal' ? { open: true }
      : selector === '#task-form' ? { querySelector: () => status } : null,
  });
  for (const [start, end] of [
    ['const esc =', '\nlet session'],
    ['const button =', 'function toast('],
    ['function field(', 'function formError('],
    ['function renderDiary()', 'async function loadWbs('],
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
  const inputs = [...html.matchAll(/<input\b[^>]*type="date"[^>]*>/g)].map(match => match[0]);
  assert.equal(inputs.length, expected.length);
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(new Set(ids).size, ids.length, 'IDs must be unique');
  inputs.forEach((input, index) => {
    const { selector, value, required = false } = expected[index];
    assert.ok(input.includes(selector), selector);
    assert.ok(input.includes(`value="${value}"`));
    assert.match(input, /min="0001-01-01"/);
    assert.match(input, /max="9999-12-31"/);
    assert.equal(/\brequired\b/.test(input), required);
    const describedBy = input.match(/aria-describedby="([^"]+)"/);
    assert.ok(describedBy, `Missing hint association: ${selector}`);
    const hint = `<small class="field-hint" id="${describedBy[1]}">${messages[language].dateFormatHint}</small>`;
    assert.ok(html.includes(hint), `Missing visible hint: ${selector}`);
    assert.equal(ids.filter(id => id === describedBy[1]).length, 1);
  });
}

for (const language of ['it', 'en']) {
  test(`diary date has its existing label and a visible associated hint (${language})`, () => {
    const ui = dateUi(language);
    ui.run('renderDiary()');
    assertDates(ui.main.innerHTML, [{ selector: 'id="report-date"', value: '2026-11-10' }], language);
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
      assert.match(labels[index][1], /<input\b[^>]*type="date"/);
    }
  });

  test(`HSE required event date and period hints coexist without duplicate IDs (${language})`, () => {
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

  test(`new site start and end dates both receive the common hint (${language})`, () => {
    const ui = dateUi(language);
    ui.run('showSiteForm()');
    assertDates(ui.dialogs.at(-1), [
      { selector: 'name="start"', value: '2026-11-10' },
      { selector: 'name="end"', value: '' },
    ], language);
  });

  test(`new task due date receives the common hint (${language})`, async () => {
    const ui = dateUi(language);
    await ui.run('showTaskForm()');
    assertDates(ui.dialogs.at(-1), [{ selector: 'name="due"', value: '2026-11-10' }], language);
  });
}

test('date hint translations specify the unchanged calendar value format', () => {
  assert.equal(messages.it.dateFormatHint, 'Data: giorno/mese/anno');
  assert.equal(messages.en.dateFormatHint, 'Date: day/month/year');
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
  assert.ok(rules.some(([, selectors, declarations]) => selectors.split(',').map(s => s.trim()).includes('input[type="date"]')
    && /min-height:\s*44px\s*;/.test(declarations)));
});

test('phone dates use 16px text and HSE period labels stack at full width', () => {
  const block = mediaBlock('max-width: 520px');
  assert.match(block, /input\[type="date"\]\s*\{[^}]*font-size:\s*16px\s*;/);
  assert.match(block, /\.hse-period-filters\s*\{[^}]*display:\s*flex\s*;[^}]*flex-direction:\s*column\s*;[^}]*width:\s*100%\s*;/);
  assert.match(block, /\.hse-period-filters\s*>\s*\.core-filter\s*\{[^}]*flex:\s*none\s*;[^}]*width:\s*100%\s*;/);
  assert.match(css, /\.hse-period-filters\s*\{\s*display:\s*contents;\s*\}/);
});

test('service worker cache version includes the date field UI update', async () => {
  const worker = await readFile(new URL('../app/sw.js', import.meta.url), 'utf8');
  assert.match(worker, /const VERSION = 'siteassistant-v15-14';/);
});
