import test from 'node:test';
import { normalizeLanguage, resolveLanguage, resolveSessionLanguage } from '../app/language.mjs';

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

test('shared-demo sessions prefer the device and fall back to the profile or browser', t => {
  const sharedDemo = true;
  t.assert.strictEqual(resolveSessionLanguage({ sharedDemo, profile: 'it', device: 'en' }), 'en');
  t.assert.strictEqual(resolveSessionLanguage({ sharedDemo, profile: 'it', browser: 'en' }), 'it');
  t.assert.strictEqual(resolveSessionLanguage({ sharedDemo, device: 'de', browser: 'it-CH' }), 'it');
  t.assert.strictEqual(resolveSessionLanguage({ sharedDemo }), 'en');
});

test('only explicitly shared sessions prefer device over profile', t => {
  for (const sharedDemo of [false, undefined, null, 'true']) {
    t.assert.strictEqual(resolveSessionLanguage({ sharedDemo, profile: 'it', device: 'en' }), 'it');
  }
});

test('login and pending choices take precedence in authenticated sessions', t => {
  for (const sharedDemo of [true, false]) {
    const session = { sharedDemo, profile: 'it', device: 'it' };
    t.assert.strictEqual(resolveSessionLanguage({ ...session, chosen: 'en', pending: 'it' }), 'en');
    t.assert.strictEqual(resolveSessionLanguage({ ...session, pending: 'en' }), 'en');
  }
});
