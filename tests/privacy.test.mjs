import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPrivacyConfig, renderPrivacyPage, renderCookiePage, languageFromRequest } from '../server/privacy.mjs';

const base = {
  updatedAt: '2026-11-25',
  operator: { name: 'Synthetic Operator', address: 'Synthetic address', privacyEmail: 'privacy@example.invalid', dpo: '' },
  legalBases: ['Synthetic legal basis for tests'],
  services: [],
  retention: {},
};

test('privacy configuration fails closed until operator and legal basis are supplied', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'siteassistant-privacy-')), path = join(directory, 'privacy.json');
  await writeFile(path, JSON.stringify({ ...base, operator: { ...base.operator, name: '' } }));
  const config = loadPrivacyConfig({ env: { PRIVACY_CONFIG_FILE: path } });
  assert.equal(config.configured, false);
  assert.match(renderPrivacyPage(config, 'it'), /Informative non configurate/);
  assert.match(renderCookiePage(config, 'en'), /Notices not configured/);
});

test('privacy and cookie pages render both languages and carry the update date', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'siteassistant-privacy-')), path = join(directory, 'privacy.json');
  await writeFile(path, JSON.stringify(base));
  const config = loadPrivacyConfig({ env: { PRIVACY_CONFIG_FILE: path } });
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
