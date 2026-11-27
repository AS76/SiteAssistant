import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPrivacyConfig, renderPrivacyPage, renderCookiePage, languageFromRequest } from '../server/privacy.mjs';

const base = {
  ...JSON.parse(await readFile(new URL('../config/privacy.demo.json', import.meta.url), 'utf8')),
  notice: { state: 'approved', version: '1.0', approvedBy: 'Synthetic reviewer', approvedAt: '2026-11-25', reviewRef: 'TEST-1' },
  operator: { name: 'Synthetic Operator', address: 'Synthetic address', privacyEmail: 'privacy@controller.test', dpo: '' },
};

async function loadFixture(t, data) {
  const directory = await mkdtemp(join(tmpdir(), 'siteassistant-privacy-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'privacy.json');
  await writeFile(path, JSON.stringify(data));
  return loadPrivacyConfig({ env: { PRIVACY_CONFIG_FILE: path } });
}

test('privacy configuration fails closed until operator and legal basis are supplied', async t => {
  const config = await loadFixture(t, { ...base, operator: { ...base.operator, name: '' } });
  assert.equal(config.configured, false);
  assert.match(renderPrivacyPage(config, 'it'), /Informative non configurate/);
  assert.match(renderCookiePage(config, 'en'), /Notices not configured/);
});

test('privacy and cookie pages render both languages and carry the update date', async t => {
  const config = await loadFixture(t, base);
  assert.equal(config.configured, true);
  for (const language of ['it', 'en']) {
    const privacy = renderPrivacyPage(config, language);
    const cookie = renderCookiePage(config, language);
    assert.match(privacy, new RegExp(`<html lang="${language}">`));
    assert.match(privacy, /2026-11-25/);
    assert.match(cookie, /sa_session/);
    assert.match(cookie, /IndexedDB/);
    assert.match(privacy, /Synthetic Operator/);
  }
  assert.match(renderPrivacyPage(config, 'de'), /<html lang="de">/);
});

test('Accept-Language chooses the first supported language, with English fallback', () => {
  const request = { headers: { 'accept-language': 'de-DE,de;q=0.9,it-CH;q=0.8' } };
  assert.equal(languageFromRequest(request, new URL('https://example.invalid/privacy')), 'it');
  assert.equal(languageFromRequest({ headers: { 'accept-language': 'de-DE,fr;q=0.9' } }, new URL('https://example.invalid/privacy')), 'en');
  assert.equal(languageFromRequest({ headers: {} }, new URL('https://example.invalid/privacy?lang=en')), 'en');
});
