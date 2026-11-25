import test from 'node:test';
import { normalizeLanguage, resolveLanguage } from '../app/language.mjs';

test('normalizes supported language tags', t => {
  for (const [value, expected] of [
    ['en-GB', 'en'], ['en-US', 'en'], ['it-IT', 'it'], ['it-CH', 'it'],
    [' EN ', 'en'], ['it', 'it'], ['de-DE', null], ['english', null],
    ['en-', null], ['', null], [null, null], [42, null],
  ]) t.assert.strictEqual(normalizeLanguage(value), expected);
});

test('resolves profile, device and preferred browser languages in order', t => {
  t.assert.strictEqual(resolveLanguage({ profile: 'it', device: 'en', browser: ['en-GB'] }), 'it');
  t.assert.strictEqual(resolveLanguage({ profile: 'de', device: 'en', browser: ['it-CH'] }), 'en');
  t.assert.strictEqual(resolveLanguage({ device: 'de', browser: ['de-DE', 'en-GB', 'it-CH'] }), 'en');
  t.assert.strictEqual(resolveLanguage({ browser: ['de-DE', 'it-CH', 'en-US'] }), 'it');
  t.assert.strictEqual(resolveLanguage({ browser: 'it-IT' }), 'it');
  t.assert.strictEqual(resolveLanguage({ browser: ['de-DE'] }), 'en');
  t.assert.strictEqual(resolveLanguage(), 'en');
});
