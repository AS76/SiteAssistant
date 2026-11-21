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
function navigation({ width = 1440, height = 1000, view = 'overview', saved, modules = {}, blocked = false } = {}) {
  const values = new Map(saved === undefined ? [] : [['sa-nav-open', saved]]), reads = [], writes = [];
  const node = () => ({ innerHTML: '', setAttribute() {}, insertAdjacentHTML() {},
    append(child) { child.parentElement = this; } });
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
    window: { innerHeight: height, matchMedia: query => ({ matches: query.includes('1180') ? width >= 1180 : width < 640 }) },
    document: { documentElement: {} }, sessionStorage: { getItem: () => null },
    localStorage: {
      getItem(key) { reads.push(key); if (blocked) throw new Error('Storage unavailable'); return values.get(key) ?? null; },
      setItem(key, value) { if (blocked) throw new Error('Storage unavailable'); writes.push([key, value]); values.set(key, value); },
    },
    navGroups, visibleModules, currentSite: () => undefined, role: () => undefined, currentModules: () => modules, renderOffline() {}, button: () => '',
    t: key => messages[context.language][key], icon: key => `<svg data-icon="${key}"></svg>`, esc: String,
    $: selector => nodes[selector] ??= node(),
  };
  runInNewContext(section('const NAV_ITEMS =', 'const coreCache =')
    + section('function demoLanguageLegend()', 'function dueMarkup('), context);
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

test('desktop renders three native collapsible sections in order with their module destinations', () => {
  for (const width of [1180, 1280, 1440]) {
    const ui = navigation({ width }), html = ui.render();
    const sections = [...html.matchAll(/<details[^>]*>(.*?)<\/details>/g)];
    assert.equal(sections.length, 3);
    navGroups().forEach((group, index) => {
      assert.match(sections[index][1], new RegExp(`^<summary class="nav-section">${messages.it[group.label]}</summary>`));
      assert.deepEqual([...sections[index][1].matchAll(/href="#([^"]+)"/g)].map(match => match[1]), group.items);
    });
    assert.equal((html.match(/<a href=/g) || []).length, 14);
    assert.deepEqual(openState(ui), { operations: true, site: true, management: true });
  }
});

test('Today is the first desktop link outside the sections, with the same icon as mobile and current-page semantics', () => {
  const desktop = navigation({ view: 'today' }), html = desktop.render();
  assert.match(html, /^<a href="#today" aria-current="page"><svg data-icon="today"><\/svg><span>Oggi<\/span><\/a><details/);
  assert.equal((html.match(/aria-current="page"/g) || []).length, 1);
  assert.match(navigation({ width: 390, view: 'today' }).render(), /<svg data-icon="today"><\/svg><span>Oggi<\/span>/);
});

test('first desktop visit opens all sections only at 1000px, with only the active group below', () => {
  for (const height of [799, 800, 900, 999, 1000]) {
    const ui = navigation({ height, view: 'bookings' }); ui.render();
    assert.deepEqual(openState(ui), { operations: height >= 1000, site: true, management: height >= 1000 });
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
  assert.match(html, /href="#tasks" aria-current="page"/);
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

test('phone and tablet render their tab links plus More and only the rail uses desktop storage', () => {
  for (const width of [390, 639, 640, 1179]) {
    const ui = navigation({ width }), html = ui.render();
    const links = ['today', 'tasks', 'diary', 'deviations', 'progress'];
    if (width >= 640) links.push('bookings');
    assert.deepEqual([...html.matchAll(/href="#([^"]+)"/g)].map(match => match[1]), links);
    assert.match(html, /href="#progress"><svg data-icon="progress"><\/svg><span>Avanz\.<\/span>/);
    assert.match(html, /<button type="button" class="nav-more active" data-command="more-nav" aria-haspopup="dialog">.*<span>Altro<\/span><\/button>$/);
    assert.doesNotMatch(html, /<details|<summary/);
    assert.equal(ui.reads.length, 0); assert.equal(ui.writes.length, 0);
    ui.context.language = 'en';
    assert.match(ui.render(), /href="#progress"><svg data-icon="progress"><\/svg><span>Progress<\/span>/);
    ui.resize(1180);
    assert.match(ui.render(), /href="#progress"><svg data-icon="progress"><\/svg><span>Site progress<\/span>/);
    ui.toggle('site', false);
    const writes = ui.writes.length;
    ui.resize(390); ui.render(); assert.equal(ui.details.length, 0); assert.equal(ui.writes.length, writes);
    ui.context.language = 'it';
    ui.resize(1440);
    assert.match(ui.render(), /href="#progress"><svg data-icon="progress"><\/svg><span>Avanzamento<\/span>/);
    assert.equal(openState(ui).site, false);
  }
});

test('the site selector follows the session at the desktop login viewport', () => {
  const ui = navigation({ width: 1440, height: 900 });
  const session = ui.context.session;
  const siteControl = ui.context.$('.site-control');
  ui.context.session = null;
  ui.render();
  assert.equal(siteControl.hidden, true);
  ui.context.session = session;
  ui.render();
  assert.equal(siteControl.hidden, false);
  ui.context.session = null;
  ui.render();
  assert.equal(siteControl.hidden, true);
});

test('shell tokens use the notebook palette and the base focus ring uses ink', () => {
  const live = Object.fromEntries([.../:root\s*\{([^}]+)\}/.exec(css)[1].matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)]
    .map(match => [match[1], match[2].trim()]));
  assert.deepEqual(Object.values(live).filter(value => value.startsWith('#')), [
    '#FAF6EC', '#FFFCF5', '#F2ECDD', '#E9E1CE', '#1E1A15', '#544E46', '#8B8378',
    '#E3DAC8', '#CFC3AC', '#8E2E24', '#6E211A', '#F7EAE4',
  ]);
  assert.equal(live['--shadow'], 'none');
  assert.match(css, /button:focus-visible,a:focus-visible[^}]+outline:\s*2px solid var\(--ink-2\)/);
  assert.match(css, /@media \(width < 640px\) \{\s*#navigation \{[^}]*position: fixed;[^}]*min-height: 56px/);
  assert.match(css, /@media \(min-width: 640px\)[\s\S]*?\.topbar-navigation #navigation \{ display: flex;/);
  assert.match(css, /@media \(min-width: 1180px\) \{\s*\.sidebar \{[^}]*width: 216px/);
});

test('exported tokens agree with the live block and the notebook palette keeps its contrast', async () => {
  const tokens = JSON.parse(await readFile(new URL('../docs/design-system.tokens.json', import.meta.url), 'utf8')).tokens;
  const live = Object.fromEntries([.../:root\s*\{([^}]+)\}/.exec(css)[1].matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)]
    .map(match => [match[1], match[2].trim()]));
  assert.deepEqual(tokens, live);
  const resolve = name => {
    let value = live[name], guard = 0;
    while (guard++ < 8) {
      const alias = /^var\((--[a-z0-9-]+)\)$/.exec(value || '');
      if (!alias) return value;
      value = live[alias[1]];
    }
    return value;
  };
  const luminance = hex => hex.slice(1).match(/../g).map(value => parseInt(value, 16) / 255)
    .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
    .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
  const contrast = (foreground, background) => {
    const [light, dark] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
    return (light + 0.05) / (dark + 0.05);
  };
  // Body and secondary text must clear WCAG AA on both surfaces; the strongest ink is the page title colour.
  for (const surface of ['--paper', '--surface']) {
    assert.ok(contrast(resolve('--ink'), resolve(surface)) >= 7, `ink on ${surface}`);
    assert.ok(contrast(resolve('--ink-2'), resolve(surface)) >= 4.5, `ink-2 on ${surface}`);
  }
  // The single brand fill carries ivory text, and brick itself stays readable on paper.
  assert.ok(contrast(resolve('--paper'), resolve('--brick')) >= 4.5);
  assert.ok(contrast(resolve('--brick'), resolve('--paper')) >= 4.5);
  // Decorative ink only: never the sole carrier of a state or a label.
  assert.ok(contrast(resolve('--ink-3'), resolve('--paper')) < 4.5);
  const stateLabel = /\.notebook-state\s*\{([^}]*)\}/.exec(css)[1];
  assert.match(stateLabel, /color:\s*var\(--ink-2\)/);
  assert.doesNotMatch(stateLabel, /--ink-3/);
});

test('sidebar exposes a thin visible scrollbar', () => {
  assert.match(css, /\.sidebar\s*\{[^}]*scrollbar-width: thin;[^}]*scrollbar-color:/);
});

test('manual link follows the current module and language and aligns with the top-bar controls', () => {
  const ui = navigation({ view: 'impacts' });
  ui.render();
  assert.equal(ui.context.$('#manual-link').href, 'https://as76.github.io/SiteAssistant/moduli/impatti-economici/');
  ui.context.language = 'en'; ui.context.view = 'logistics'; ui.render();
  assert.equal(ui.context.$('#manual-link').href, 'https://as76.github.io/SiteAssistant/en/moduli/logistica/');
  ui.context.view = 'reporting'; ui.render();
  assert.equal(ui.context.$('#manual-link').href, 'https://as76.github.io/SiteAssistant/en/');
  assert.match(css, /\.manual-link\s*\{[^}]*display: inline-flex[^}]*align-items: center/);
});
