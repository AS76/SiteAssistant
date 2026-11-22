import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createContext, runInContext } from 'node:vm';
import { messages } from '../app/i18n.mjs';

const [source, shell] = await Promise.all([
  readFile(new URL('../app/app.mjs', import.meta.url), 'utf8'),
  readFile(new URL('../app/index.html', import.meta.url), 'utf8'),
]);
const start = source.indexOf('const DEMO_NOTICE_KEY');
const end = source.indexOf('function demoLanguageLegend()', start);
assert.ok(start >= 0 && end > start);
const noticeSource = source.slice(start, end);
const noticeKey = 'sa-demo-notice-dismissed';

function demoUi({ values = new Map(), unavailable = false, language = 'it' } = {}) {
  const nodes = new Map([...shell.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g)].map(([tag, id]) => [
    '#' + id,
    {
      hidden: /\bhidden\b/.test(tag), textContent: '', attributes: {},
      setAttribute(name, value) { this.attributes[name] = value; },
      focus() { this.focused = true; },
    },
  ]));
  const context = createContext({
    language,
    $: selector => nodes.get(selector),
    t: key => messages[context.language][key],
    esc: String,
    localStorage: {
      getItem(key) {
        if (unavailable) throw new Error('Storage is disabled');
        return values.get(key) ?? null;
      },
      setItem(key, value) {
        if (unavailable) throw new Error('Storage is disabled');
        values.set(key, value);
      },
    },
    showModal(title, content) { context.panel = { title, content }; },
  });
  const run = code => runInContext(code, context);
  run(noticeSource + '\ninitDemoNotice();');
  return { context, run, node: selector => nodes.get(selector), values };
}

test('the demo notice is wired into startup with a GitHub Issues link and a footer entry', () => {
  assert.match(shell, /<section[^>]*id="demo-banner"[^>]*aria-labelledby="demo-notice-title"/);
  assert.match(shell, /<a id="demo-feedback" href="https:\/\/github\.com\/AS76\/SiteAssistant\/issues"/);
  assert.match(shell, /<button id="dismiss-demo-notice"[^>]*data-command="dismiss-demo-notice"/);
  assert.match(shell, /<footer>[\s\S]*<button id="demo-info"[^>]*data-command="open-demo-info"[^>]*aria-haspopup="dialog"[\s\S]*<\/footer>/);
  assert.match(source, /async function start\(\) \{\s*initDemoNotice\(\)/);
  assert.match(source, /'dismiss-demo-notice': dismissDemoNotice/);
  assert.match(source, /'open-demo-info': showDemoInfo/);
});

test('the notice appears on first visit and is translated when the language changes', () => {
  const ui = demoUi();
  assert.equal(ui.node('#demo-banner').hidden, false);
  assert.equal(ui.values.size, 0);
  for (const language of ['it', 'en']) {
    ui.context.language = language;
    ui.run('renderDemoNotice()');
    const labels = messages[language];
    assert.equal(ui.node('#demo-notice-title').textContent, labels.demoNoticeTitle);
    assert.equal(ui.node('#demo-notice-text').textContent, labels.demoNoticeText);
    assert.equal(ui.node('#demo-feedback').textContent, labels.demoNoticeFeedback);
    assert.equal(ui.node('#dismiss-demo-notice').attributes['aria-label'], labels.demoNoticeDismiss);
    assert.equal(ui.node('#demo-info').textContent, labels.demoInfoTitle);
  }
});

test('dismissal hides the notice across rerenders and reloads and leaves the footer entry available', () => {
  const ui = demoUi();
  ui.run('dismissDemoNotice()');
  assert.equal(ui.node('#demo-banner').hidden, true);
  assert.equal(ui.node('#main').focused, true);
  assert.equal(ui.values.get(noticeKey), '1');
  ui.context.language = 'en';
  ui.run('renderDemoNotice()');
  assert.equal(ui.node('#demo-banner').hidden, true);
  const reloaded = demoUi({ values: ui.values });
  assert.equal(reloaded.node('#demo-banner').hidden, true);
  assert.equal(reloaded.node('#demo-info').hidden, false);
});

test('the notice still opens and can be dismissed when localStorage is unavailable', () => {
  const ui = demoUi({ unavailable: true });
  assert.equal(ui.node('#demo-banner').hidden, false);
  ui.run('dismissDemoNotice(); renderDemoNotice()');
  assert.equal(ui.node('#demo-banner').hidden, true);
});

const limitKeys = [
  'demoInfoLogistics', 'demoInfoCountryModules', 'demoInfoQualityAcceptance', 'demoInfoLocationHierarchy',
];

for (const language of ['it', 'en']) {
  test(`${language}: the demo panel describes the environment, coverage, assistant usage and retention`, () => {
    const ui = demoUi({ language, values: new Map([[noticeKey, '1']]) });
    ui.run('showDemoInfo()');
    const { title, content } = ui.context.panel;
    const labels = messages[language];
    assert.equal(title, labels.demoInfoTitle);
    assert.ok(content.includes(`<h3>${labels.demoInfoLimits}</h3>`));
    assert.deepEqual([...content.matchAll(/<li>(.*?)<\/li>/g)].map(match => match[1]), limitKeys.map(key => labels[key]));
    for (const key of ['demoInfoEnvironment', 'demoInfoAssistant', 'demoInfoRetention']) {
      assert.ok(content.includes(`<p>${labels[key]}</p>`), key);
    }
  });
}

test('all new demo notice and panel keys have matching Italian and English entries', () => {
  const keys = [
    'demoNoticeTitle', 'demoNoticeText', 'demoNoticeFeedback', 'demoNoticeDismiss',
    'demoInfoTitle', 'demoInfoEnvironment', 'demoInfoLimits', ...limitKeys, 'demoInfoAssistant', 'demoInfoRetention',
  ].sort();
  for (const language of ['it', 'en']) {
    const labels = messages[language];
    assert.deepEqual(Object.keys(labels).filter(key => /^demo(?:Notice|Info)/.test(key)).sort(), keys);
    for (const key of keys) assert.match(labels[key], /\S/, `${language}: ${key}`);
  }
});
