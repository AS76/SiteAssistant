import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createContext, runInContext } from 'node:vm';
import { messages } from '../app/i18n.mjs';

const source = await readFile(new URL('../app/app.mjs', import.meta.url), 'utf8');

function section(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, start);
  return source.slice(from, to);
}

const settingsSource = [
  section('const esc =', 'let session ='),
  section('const button =', 'function toast('),
  section('const role =', 'const currentModules ='),
  section('const formActions =', 'function formError('),
  section('function showSettingsForm()', 'async function showImportForm()'),
  'showSettingsForm();',
].join('\n');

const user = { name: 'Synthetic <Owner> & "Crew"', email: 'synthetic&owner@example.invalid' };
const roles = [{ site_id: 'other-site', role: 'editor' }, { site_id: 'owner-site', role: 'owner' }];

function renderSettings(language, session, siteId = 'owner-site') {
  const labels = messages[language];
  const misses = [];
  let html;
  const context = createContext({
    session, siteId, prefs: { currency: 'CHF', separators: 'auto' },
    t(key) {
      if (Object.hasOwn(labels, key)) return labels[key];
      misses.push(key);
      return key;
    },
    showModal(title, content) {
      assert.equal(title, labels.settingsTitle);
      html = content;
    },
  });
  runInContext(settingsSource, context);
  assert.deepEqual(misses, []);
  return html;
}

function assertPreferences(html) {
  assert.match(html, /<form id="settings-form">/);
  assert.match(html, /<select name="currency">.*<option value="CHF" selected>/);
  assert.match(html, /<select name="separators"><option value="auto" selected>/);
  assert.match(html, /<button type="submit"/);
}

for (const language of ['it', 'en']) {
  const labels = messages[language];

  test(`${language}: Settings starts with the signed-in account and selected-site role`, () => {
    const html = renderSettings(language, { user, roles });
    const account = html.match(/^<section class="account-summary"[^>]*>([\s\S]*?)<\/section>\s*<form id="settings-form">/);
    assert.ok(account);
    const summary = account[1];
    for (const value of [labels.accountSection, 'Synthetic &lt;Owner&gt; &amp; &quot;Crew&quot;', 'synthetic&amp;owner@example.invalid',
      labels.accountUserType, labels.responsibleRole_owner, labels.accountCurrentSite]) {
      assert.ok(summary.includes(value), value);
    }
    assert.ok(!summary.includes(user.name));
    assert.ok(!summary.includes(user.email));
    for (const command of ['change-password', 'passkey-security']) {
      const attribute = `data-command="${command}"`;
      assert.ok(summary.includes(attribute));
      assert.equal(html.split(attribute).length - 1, 1, command);
    }
    assertPreferences(html);
  });

  test(`${language}: Settings shows a fallback when the user has no role at the selected site`, () => {
    const html = renderSettings(language, { user, roles }, 'unassigned-site');
    assert.match(html, /class="account-summary"/);
    assert.ok(html.includes(labels.accountNoRole));
  });

  test(`${language}: Settings shows only preferences without a session`, () => {
    const html = renderSettings(language, null);
    assert.ok(html.startsWith('<form id="settings-form">'));
    assert.doesNotMatch(html, /account-summary|data-command="(?:change-password|passkey-security)"/);
    assertPreferences(html);
  });
}

test('service worker activates the account update without waiting for old tabs', async () => {
  const worker = await readFile(new URL('../app/sw.js', import.meta.url), 'utf8');
  assert.match(worker, /const VERSION = 'siteassistant-v15-43'/);
  assert.match(worker, /self\.skipWaiting\(\)/);
});
