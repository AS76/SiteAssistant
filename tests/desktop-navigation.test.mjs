import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { navGroups, visibleModules } from '../app/domain.mjs';
import { messages } from '../app/i18n.mjs';

const source = await readFile(new URL('../app/app.mjs', import.meta.url), 'utf8');
const css = await readFile(new URL('../app/styles.css', import.meta.url), 'utf8');
const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end));

// Run the real chrome renderer and native toggle callbacks with synthetic DOM/storage.
function navigation({ width = 1440, height = 900, view = 'overview', saved, modules = {}, blocked = false } = {}) {
  const values = new Map(saved === undefined ? [] : [['sa-nav-open', saved]]), reads = [], writes = [];
  const node = () => ({ innerHTML: '', classList: { add() {} }, setAttribute() {}, insertAdjacentHTML() {} });
  const nodes = {}, nav = node();
  let html = '', details = [];
  Object.defineProperty(nav, 'innerHTML', {
    get: () => html,
    set(value) {
      details.forEach(item => { item.isConnected = false; });
      html = value;
      details = [...value.matchAll(/<details class="nav-group" data-group="([^"]+)"( open)?>/g)].map(match => ({
        dataset: { group: match[1] }, open: Boolean(match[2]), isConnected: true,
        addEventListener(event, callback) { assert.equal(event, 'toggle'); this.toggle = callback; },
      }));
    },
  });
  nav.querySelectorAll = selector => { assert.equal(selector, 'details[data-group]'); return details; };
  nodes['#navigation'] = nav;
  const context = {
    view, language: 'it', loading: false, actor: '', siteId: 'site-1', state: { sites: [] }, session: { user: {} },
    window: { innerHeight: height, matchMedia: () => ({ matches: width < 800 }) },
    document: { documentElement: {} }, sessionStorage: { getItem: () => null },
    localStorage: {
      getItem(key) { reads.push(key); if (blocked) throw new Error('Storage unavailable'); return values.get(key) ?? null; },
      setItem(key, value) { if (blocked) throw new Error('Storage unavailable'); writes.push([key, value]); values.set(key, value); },
    },
    navGroups, visibleModules, currentModules: () => modules, renderOffline() {}, button: () => '',
    t: key => messages[context.language][key], icon: key => `<svg data-icon="${key}"></svg>`, esc: String,
    $: selector => nodes[selector] ??= node(),
  };
  runInNewContext(section('const NAV_ITEMS =', 'const coreCache =')
    + section('function renderChrome()', 'function dueMarkup('), context);
  return {
    context, nav, reads, writes, values,
    render() { context.renderChrome(); return html; },
    get details() { return details; },
    toggle(id, open) {
      const detail = details.find(item => item.dataset.group === id);
      assert.ok(detail, id); detail.open = open; detail.toggle();
    },
    resize(nextWidth, nextHeight = height) { width = nextWidth; context.window.innerHeight = nextHeight; },
  };
}
const openState = ui => Object.fromEntries(ui.details.map(item => [item.dataset.group, item.open]));

test('desktop renders three native collapsible sections in order, each with four unchanged destinations', () => {
  for (const width of [800, 1024, 1440]) {
    const ui = navigation({ width }), html = ui.render();
    const sections = [...html.matchAll(/<details[^>]*>(.*?)<\/details>/g)];
    assert.equal(sections.length, 3);
    navGroups().forEach((group, index) => {
      assert.match(sections[index][1], new RegExp(`^<summary class="nav-section">${messages.it[group.label]}</summary>`));
      assert.deepEqual([...sections[index][1].matchAll(/href="#([^"]+)"/g)].map(match => match[1]), group.items);
    });
    assert.equal((html.match(/<a href=/g) || []).length, 13);
    assert.deepEqual(openState(ui), { operations: true, site: true, management: true });
  }
});

test('Today is the first desktop link outside the sections, with the same icon as mobile and current-page semantics', () => {
  const desktop = navigation({ view: 'today' }), html = desktop.render();
  assert.match(html, /^<a href="#today" class="nav-today active" aria-current="page"><svg data-icon="today"><\/svg><span>Oggi<\/span><\/a><details/);
  assert.equal((html.match(/aria-current="page"/g) || []).length, 1);
  assert.match(navigation({ width: 390, view: 'today' }).render(), /<svg data-icon="today"><\/svg><span>Oggi<\/span>/);
});

test('first desktop visit uses height only for defaults, with no accordion open for Today on short windows', () => {
  for (const height of [799, 800]) {
    const ui = navigation({ height, view: 'bookings' }); ui.render();
    assert.deepEqual(openState(ui), { operations: height >= 800, site: true, management: height >= 800 });
  }
  const ui = navigation({ height: 600, view: 'today' }); ui.render();
  assert.deepEqual(openState(ui), { operations: false, site: false, management: false });
});

test('storage reads and native toggles persist boolean preferences across a reload, including the active section', () => {
  const ui = navigation({ saved: JSON.stringify({ operations: true, site: false, management: true }) }); ui.render();
  assert.deepEqual(ui.reads, ['sa-nav-open']);
  assert.deepEqual(openState(ui), { operations: true, site: false, management: true });
  ui.toggle('management', false); ui.toggle('site', true); ui.toggle('operations', false);
  ui.render();
  assert.deepEqual(openState(ui), { operations: false, site: true, management: false });
  assert.equal(ui.writes.length, 3);
  assert.ok(ui.writes.every(([key]) => key === 'sa-nav-open'));
  assert.deepEqual(JSON.parse(ui.values.get('sa-nav-open')), openState(ui));
  const reloaded = navigation({ view: 'today', height: 600, saved: ui.values.get('sa-nav-open') }); reloaded.render();
  assert.deepEqual(openState(reloaded), openState(ui));
});

test('entering a route opens and persists its group without closing others or reopening on unrelated renders', () => {
  const ui = navigation({ height: 600 }); ui.render();
  ui.toggle('management', true); ui.toggle('operations', false); ui.render();
  assert.equal(openState(ui).operations, false);
  ui.context.view = 'tasks';
  const html = ui.render();
  assert.deepEqual(openState(ui), { operations: true, site: false, management: true });
  assert.match(html, /href="#tasks" class="active" aria-current="page"/);
  assert.deepEqual(JSON.parse(ui.values.get('sa-nav-open')), openState(ui));
  ui.context.view = 'bookings'; ui.render();
  assert.deepEqual(openState(ui), { operations: true, site: true, management: true });
});

test('saved closed active group opens on entry; malformed, non-boolean and unavailable storage recover safely', () => {
  const ui = navigation({ saved: '{"operations":false,"site":false,"management":false}' }); ui.render();
  assert.deepEqual(openState(ui), { operations: true, site: false, management: false });
  for (const saved of ['{', 'null', '[]', '42', '{"operations":"false","site":0,"unknown":true}']) {
    const other = navigation({ saved }); other.render();
    assert.deepEqual(openState(other), { operations: true, site: true, management: true });
    other.toggle('site', false);
    assert.deepEqual(JSON.parse(other.values.get('sa-nav-open')), { operations: true, site: false, management: true });
  }
  const blocked = navigation({ blocked: true }); blocked.render(); blocked.toggle('site', false); blocked.render();
  assert.equal(openState(blocked).site, false);
});

test('initial and detached toggle notifications cannot overwrite current preferences', () => {
  const ui = navigation(); ui.render();
  ui.details.forEach(item => item.toggle()); assert.equal(ui.writes.length, 0);
  const old = ui.details[1]; ui.render(); old.open = false; old.toggle();
  assert.equal(ui.writes.length, 0); assert.equal(openState(ui).site, true);
});

test('disabled modules are omitted without empty sections or lost preferences', () => {
  const modules = Object.fromEntries(['progress', 'bookings', 'wbs', 'impacts', 'tasks', 'tools'].map(key => [key, false]));
  const ui = navigation({ modules, saved: '{"site":false}' }), html = ui.render();
  assert.deepEqual(ui.details.map(item => item.dataset.group), ['operations', 'management']);
  for (const key of Object.keys(modules)) assert.ok(!html.includes(`href="#${key}"`));
  ui.toggle('management', false);
  assert.equal(JSON.parse(ui.values.get('sa-nav-open')).site, false);
  modules.progress = true; ui.render(); assert.equal(openState(ui).site, false);
});

test('mobile still renders four primary links plus More and never accesses desktop storage, including on resize', () => {
  for (const width of [390, 799]) {
    const ui = navigation({ width }), html = ui.render();
    assert.deepEqual([...html.matchAll(/href="#([^"]+)"/g)].map(match => match[1]), ['today', 'tasks', 'deviations', 'bookings']);
    assert.match(html, /<button type="button" class="nav-more active" data-command="more-nav">.*Altro<\/button>$/);
    assert.doesNotMatch(html, /<details|<summary/);
    assert.equal(ui.reads.length, 0); assert.equal(ui.writes.length, 0);
    ui.resize(1024); ui.render(); ui.toggle('site', false);
    const writes = ui.writes.length;
    ui.resize(390); ui.render(); assert.equal(ui.details.length, 0); assert.equal(ui.writes.length, writes);
    ui.resize(1440); ui.render(); assert.equal(openState(ui).site, false);
  }
});

test('CSS and exported tokens agree; secondary text and every focus rule use the approved contrast values', async () => {
  const tokens = JSON.parse(await readFile(new URL('../docs/design-system.tokens.json', import.meta.url), 'utf8')).tokens;
  const live = Object.fromEntries([.../:root\{([^}]+)\}/.exec(css)[1].matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)].map(match => [match[1], match[2].trim()]));
  assert.deepEqual(tokens, live);
  assert.equal(live['--muted'], '#5b6c72');
  assert.equal(live['--green'], '#126c57');
  const luminance = hex => hex.slice(1).match(/../g).map(value => parseInt(value, 16) / 255)
    .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
    .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
  const contrast = (foreground, background) => (luminance(background) + 0.05) / (luminance(foreground) + 0.05);
  assert.equal(contrast(live['--muted'], live['--paper']).toFixed(2), '5.08');
  assert.equal(contrast(live['--muted'], '#ffffff').toFixed(2), '5.48');
  assert.equal(contrast(live['--green'], '#ffffff').toFixed(2), '6.35');
  const focusRules = [...css.matchAll(/([^{}]*:focus-visible[^{}]*)\{([^}]*)\}/g)].filter(match => match[2].includes('outline:'));
  assert.ok(focusRules.length >= 3);
  assert.ok(focusRules.some(match => match[1].includes('summary:focus-visible') && match[1].includes('a:focus-visible')));
  for (const [, , body] of focusRules) {
    assert.match(body, /outline:\s*3px solid var\(--green\)/);
    assert.match(body, /box-shadow:\s*(?:inset )?0 0 0 3px #fff/);
  }
  assert.doesNotMatch(css, /#d89a44/);
  assert.match(css, /@media\(width < 800px\)\{\s*\.sidebar/);
  assert.equal((css.match(/@media\(width < 800px\)/g) || []).length, 2);
  assert.match(css, /@media \(width < 800px\) \{\s*\.core-navigation/);
});
