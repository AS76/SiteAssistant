import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createContext, runInContext } from 'node:vm';
import { DEVIATION_STATUSES, groupDeviationRows, filterSortRecords } from '../app/domain.mjs';
import { messages } from '../app/i18n.mjs';

const source = await readFile(new URL('../app/app.mjs', import.meta.url), 'utf8');
const css = await readFile(new URL('../app/styles.css', import.meta.url), 'utf8');
const knownRows = () => DEVIATION_STATUSES.map((status, index) => ({
  id: `synthetic-${index}`, title: `Example ${index}`, deviationNo: `SYN-${index}`, status,
}));

test('deviation presentation groups partition all official statuses exactly once', () => {
  const rows = knownRows(), before = structuredClone(rows), groups = groupDeviationRows(rows);
  assert.equal(groups.length, 4);
  assert.deepEqual(groups.map(group => group.statuses), [
    ['open', 'approved'], ['in_progress'], ['work_completed'], ['closed', 'rejected'],
  ]);
  const statuses = groups.flatMap(group => group.statuses);
  assert.deepEqual([...statuses].sort(), [...DEVIATION_STATUSES].sort());
  assert.equal(new Set(statuses).size, statuses.length);
  for (const row of rows) {
    assert.equal(groups.filter(group => group.statuses.includes(row.status)).length, 1);
    assert.equal(groups.flatMap(group => group.rows).filter(item => item === row).length, 1);
  }
  assert.deepEqual(groups.map(group => group.rows.length), [2, 1, 1, 2]);
  assert.deepEqual(rows, before);
  assert.deepEqual(groupDeviationRows().map(group => group.rows), [[], [], [], []]);
  groups[0].statuses.pop();
  assert.deepEqual(groupDeviationRows()[0].statuses, ['open', 'approved']);
});

test('unknown deviation statuses add only one conditional fifth group without losing raw values', () => {
  const unknown = [null, undefined, '', 'future_status'].map((status, index) => ({ id: `unknown-${index}`, status }));
  const rows = [...knownRows(), ...unknown], before = structuredClone(rows), groups = groupDeviationRows(rows);
  assert.equal(groups.length, 5);
  assert.equal(groups[4].label, 'coreUnmappedStatus');
  assert.deepEqual(groups[4].rows, unknown);
  for (const row of rows) assert.equal(groups.flatMap(group => group.rows).filter(item => item === row).length, 1);
  assert.deepEqual(rows, before);
  assert.equal(groupDeviationRows(knownRows()).length, 4);
});

// Execute actual renderers with synthetic records, without browser processes or sockets.
function deviationUi({ language = 'it', width = 1440, rows = knownRows(), layout = 'board' } = {}) {
  const context = createContext({
    language, DEVIATION_STATUSES, groupDeviationRows, filterSortRecords,
    t: key => messages[language][key] ?? key,
    coreData: () => rows, coreFilters: { deviations: { status: '', priority: '' } },
    deviationView: layout, compactNavigation: () => width < 800,
    renderReconciliation: () => '', empty: () => '',
  });
  for (const [start, end] of [
    ['const esc =', 'let session ='],
    ['const button =', 'function toast('],
    ['const coreValue =', 'function progressBar('],
    ['function renderDeviations()', 'function renderProgress()'],
  ]) {
    const from = source.indexOf(start), to = source.indexOf(end, from);
    assert.ok(from >= 0 && to > from);
    runInContext(source.slice(from, to), context);
  }
  return runInContext('renderDeviations()', context);
}

for (const language of ['it', 'en']) {
  const labels = language === 'it' ? ['Aperte', 'In corso', 'Da chiudere', 'Chiuse'] : ['Open', 'In progress', 'To close', 'Closed'];
  test(`desktop deviation board renders four translated groups with counts and precise status badges (${language})`, () => {
    for (const width of [800, 1024, 1440]) {
      const html = deviationUi({ language, width });
      const columns = [...html.matchAll(/<section class="core-column">([\s\S]*?)<\/section>/g)];
      assert.equal(columns.length, 4);
      columns.forEach(([, column], index) => {
        assert.ok(column.includes(`<span>${labels[index]}</span><span>${[2, 1, 1, 2][index]}</span>`));
      });
      for (const status of DEVIATION_STATUSES) {
        assert.ok(html.includes(`core-status-${status}">${messages[language][status]}</span>`));
      }
      assert.doesNotMatch(html, /<details|class="core-unknown"/);
      assert.match(html, /aria-describedby="deviation-board-scroll-hint"/);
      assert.ok(html.includes(`>${messages[language].deviationsScroll} ↔</p>`));
    }
  });

  test(`phone deviation accordion retains native disclosures and uses the same four groups (${language})`, () => {
    const html = deviationUi({ language, width: 390 });
    const groups = [...html.matchAll(/<details class="board-status"[^>]*>([\s\S]*?)<\/details>/g)];
    assert.equal(groups.length, 4);
    groups.forEach(([, group], index) => {
      assert.ok(group.includes(`<summary><span>${labels[index]}</span><span class="count">${[2, 1, 1, 2][index]}</span></summary>`));
    });
    assert.equal((html.match(/class="board-status" open/g) || []).length, 1);
    assert.doesNotMatch(html, /class="core-column"|deviation-board-scroll-hint/);
    for (const status of DEVIATION_STATUSES) assert.ok(html.includes(`core-status-${status}">${messages[language][status]}</span>`));
  });

  test(`deviation list already uses core cards with all seven translated cell labels (${language})`, () => {
    const html = deviationUi({ language, width: 390, layout: 'list' });
    assert.match(html, /class="core-table-wrap"><table class="core-table"/);
    assert.equal((html.match(/<td data-label=/g) || []).length, 7 * DEVIATION_STATUSES.length);
    for (const key of ['coreReference', 'title', 'status', 'priority', 'coreAssignedTo', 'coreCreated', 'coreClosed']) {
      assert.ok(html.includes(`data-label="${messages[language][key]}"`));
    }
  });
}

test('unknown deviation rows appear in a fifth column or disclosure only when present', () => {
  for (const width of [1440, 390]) {
    const html = deviationUi({ width, rows: [...knownRows(), { id: 'unknown', title: 'Synthetic unknown', status: null }] });
    assert.equal((html.match(width === 390 ? /<details class="board-status"/g : /<section class="core-column"/g) || []).length, 5);
    assert.equal((html.match(/data-id="unknown"/g) || []).length, 1);
    assert.match(html, /Stato non mappato/);
    assert.match(html, /core-status-unknown">Non disponibile<\/span>/);
  }
});

test('scroll hint and edge fades respond to overflow, scrolling and resizing', () => {
  const classes = new Set(), hint = { hidden: true };
  const board = { clientWidth: 900, scrollWidth: 1088, scrollLeft: 0,
    parentElement: { classList: { toggle(key, enabled) { if (enabled) classes.add(key); else classes.delete(key); } } } };
  const context = createContext({ $: selector => selector === '#deviation-board' ? board : hint });
  runInContext(source.slice(source.indexOf('function updateDeviationBoardScroll()'), source.indexOf('function renderDeviations()')), context);
  const update = () => runInContext('updateDeviationBoardScroll()', context);
  update(); assert.equal(hint.hidden, false); assert.deepEqual([...classes], ['scroll-right']);
  board.scrollLeft = 90; update(); assert.deepEqual([...classes].sort(), ['scroll-left', 'scroll-right']);
  board.scrollLeft = 188; update(); assert.deepEqual([...classes], ['scroll-left']);
  board.clientWidth = 1200; board.scrollLeft = 0; update(); assert.equal(hint.hidden, true); assert.equal(classes.size, 0);
  assert.match(source, /window\.addEventListener\('resize', updateDeviationBoardScroll\)/);
  assert.match(source, /addEventListener\('scroll', updateDeviationBoardScroll, \{ passive: true \}\)/);
  assert.match(css, /\.deviation-board-frame::after\s*\{[^}]*linear-gradient\(to left/);
  assert.match(css, /\.deviation-board-frame\.scroll-right::after\s*\{\s*opacity: 1/);
  context.$ = () => null; assert.doesNotThrow(update);
});

function phoneCardCss() {
  const start = css.indexOf('/* Phones: tables become cards.');
  const end = css.indexOf('/* Assistant:', start);
  assert.ok(start >= 0 && end > start);
  const block = css.slice(start, end);
  assert.match(block, /@media\(max-width:800px\)/);
  return block;
}

test('light table shares the existing phone card CSS while desktop styles remain unchanged', () => {
  const block = phoneCardCss();
  assert.match(block, /\.core-table-wrap,\.mobile-card-wrap\{[^}]*overflow:visible/);
  assert.match(block, /\.core-table tr,\.mobile-card-table tr\{display:block;[^}]*border-radius:10px/);
  assert.match(block, /\.core-table td::before,\.mobile-card-table td::before\{content:attr\(data-label\)/);
  assert.match(block, /\.mobile-card-table td\{[^}]*overflow-wrap:anywhere;min-width:0;max-width:none/);
  assert.match(block, /\.mobile-card-table td\.mobile-card-actions\{flex-direction:column;align-items:stretch/);
  assert.match(block, /\.mobile-card-table \.mobile-card-action\{width:100%;min-height:44px/);
  const outside = css.replace(block, '');
  assert.doesNotMatch(outside, /mobile-card-(?:wrap|table|actions?)/);
});
