import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { promisify } from 'node:util';
import { createServer } from '../server/http.mjs';
import { validatePrivacyNotice } from '../server/privacy.mjs';
import { requestListener } from './helpers/auth.mjs';

const fixture = {
  notice: { state: 'approved', version: '1.2-test', approvedBy: 'Synthetic reviewer', approvedAt: '2026-11-24', reviewRef: 'TEST-12' },
  updatedAt: '2026-11-25',
  operator: { name: 'Synthetic Controller', address: 'Fictional postal address', privacyEmail: 'privacy@controller.test' },
  purposes: [{ purpose: 'Manage synthetic accounts', legalBasis: 'Synthetic contract basis' }],
  legalBases: ['Synthetic contract basis'],
  services: [{ name: 'Synthetic hosting', purpose: 'Host fictional records', role: 'Synthetic processor', location: 'Fictional EEA region', transfer: 'None declared' }],
  retention: { activeSessions: { period: '7 days', basis: 'Synthetic session lifetime' } },
  rights: 'Synthetic rights description',
  complaintAuthority: 'Fictional supervisory authority',
};

const routes = ['/privacy', '/cookie-policy'];
const requestWith = privacyConfig => requestListener(createServer({}, { privacyConfig, authBypassUser: '' }));

test('notice state defaults to example, fails closed on unknown values, and downgrades incomplete approval', async () => {
  for (const state of [undefined, 'Example', 'unexpected', null]) {
    const config = { ...fixture, notice: { ...fixture.notice, state } };
    const result = validatePrivacyNotice(config);
    assert.equal(result.state, 'example');
    assert.equal(result.complete, true);
    const response = await requestWith(config)('/privacy?state=approved&approved=true', {
      headers: { 'x-privacy-notice-state': 'approved' },
    });
    assert.equal(response.status, 503);
    assert.match(response.body, /Notices not configured/);
    assert.ok(!response.body.includes(fixture.operator.name));
  }
  for (const [field, value] of [['approvedBy', undefined], ['approvedAt', ' '], ['reviewRef', 12]]) {
    const config = { ...fixture, notice: { ...fixture.notice, [field]: value } };
    assert.deepEqual(validatePrivacyNotice(config), {
      state: 'pending-legal-review', complete: true, missing: [], reason: 'missing-approval',
    });
    const response = await requestWith(config)('/privacy?state=approved');
    assert.equal(response.status, 200);
    assert.equal(response.headers['x-robots-tag'], 'noindex');
    assert.match(response.body, /pending legal review/);
  }
});

test('incomplete checklist reports field names without echoing configuration values', async () => {
  const config = {
    ...fixture,
    configured: true,
    operator: { ...fixture.operator, address: '...', privacyEmail: 'not-an-email' },
    updatedAt: '2026-02-30',
    purposes: [{ purpose: fixture.purposes[0].purpose, legalBasis: [] }],
    legalBases: [' '],
    services: [{ ...fixture.services[0], role: '', transfer: null }],
    retention: { 'synthetic-private-category': { period: 7, basis: '' } },
    rights: '',
    complaintAuthority: { name: fixture.complaintAuthority },
    notice: { ...fixture.notice, version: 1.2 },
  };
  const missing = [
    'operator.address', 'operator.privacyEmail', 'purposes[].legalBasis', 'legalBases', 'services[].role',
    'services[].transfer', 'retention[].period', 'retention[].basis', 'rights', 'complaintAuthority', 'notice.version', 'updatedAt',
  ];
  assert.deepEqual(validatePrivacyNotice(config), { state: 'example', complete: false, missing, reason: 'incomplete-config' });
  const request = requestWith(config);
  for (const route of routes) {
    const response = await request(route);
    assert.equal(response.status, 503);
    assert.deepEqual([...response.body.matchAll(/<li><code>(.*?)<\/code><\/li>/g)].map(match => match[1]), missing);
    for (const confidential of [fixture.operator.name, config.operator.privacyEmail, config.updatedAt, fixture.notice.reviewRef, 'synthetic-private-category']) {
      assert.ok(!response.body.includes(confidential));
    }
  }
});

test('reserved privacy and controller contacts are rejected above example', () => {
  for (const domain of ['example', 'example.com', 'SUB.EXAMPLE', 'demo.invalid', 'localhost', 'sub.localhost']) {
    const operator = { name: fixture.operator.name, contact: `https://${domain}/privacy`, privacyEmail: `privacy@${domain}` };
    for (const state of ['example', 'pending-legal-review', 'approved']) {
      const result = validatePrivacyNotice({ ...fixture, operator, notice: { ...fixture.notice, state } });
      assert.equal(result.state, 'example');
      assert.equal(result.complete, state === 'example');
      assert.deepEqual(result.missing, state === 'example' ? [] : ['operator.contact', 'operator.privacyEmail']);
    }
  }
  const address = 'controller@demo.invalid';
  assert.deepEqual(validatePrivacyNotice({ ...fixture, operator: { ...fixture.operator, address } }).missing, ['operator.address']);
  const contact = 'https://controller.test/privacy';
  assert.equal(validatePrivacyNotice({ ...fixture, operator: { ...fixture.operator, address: '', contact } }).state, 'approved');
});

test('pending notices show a persistent review banner and noindex on both routes', async () => {
  const request = requestWith({ ...fixture, notice: { state: 'pending-legal-review', version: fixture.notice.version } });
  for (const route of routes) {
    const response = await request(route);
    assert.equal(response.status, 200);
    assert.equal(response.headers['x-robots-tag'], 'noindex');
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.match(response.body, /<p class="note notice-review" role="note">This notice is pending legal review and is not final\.<\/p>/);
    assert.ok(response.body.includes(fixture.operator.name));
  }
});

test('approved notices show version and update date without the review banner', async () => {
  const request = requestWith(fixture);
  for (const route of routes) {
    const response = await request(route);
    assert.equal(response.status, 200);
    assert.equal(response.headers['x-robots-tag'], undefined);
    assert.match(response.body, /Version: 1\.2-test/);
    assert.match(response.body, /<time datetime="2026-11-25">2026-11-25<\/time>/);
    assert.doesNotMatch(response.body, /class="note notice-review"/);
    assert.ok(!response.body.includes(fixture.notice.approvedBy));
    assert.ok(!response.body.includes(fixture.notice.reviewRef));
  }
});

test('Italian and English notices expose the same sections and configured content', async () => {
  const request = requestWith({ ...fixture, notice: { ...fixture.notice, state: 'pending-legal-review' } });
  for (const route of routes) {
    const sections = route === '/privacy' ? [
      ['Data controller', 'Titolare del trattamento'], ['What data we process and why', 'Quali dati trattiamo e perché'],
      ['Cookies and device storage', 'Cookie e memoria del dispositivo'], ['Providers and recipients', 'Fornitori e destinatari'],
      ['Retention', 'Conservazione'], ['Legal bases', 'Basi giuridiche'], ['Rights and contact', 'Diritti e contatti'], ['Changes', 'Modifiche'],
    ] : [
      ['Cookies', 'Cookie'], ['Browser local storage', 'Memoria locale del browser'], ['Consent', 'Consenso'], ['Contact', 'Contatti'],
    ];
    for (const [index, language] of ['en', 'it'].entries()) {
      const response = await request(`${route}?lang=${language}`);
      assert.equal(response.status, 200);
      assert.equal(response.headers['x-robots-tag'], 'noindex');
      assert.ok(response.body.includes(`<html lang="${language}">`));
      assert.deepEqual([...response.body.matchAll(/<h2>(.*?)<\/h2>/g)].map(match => match[1]), sections.map(pair => pair[index]));
      assert.ok(response.body.includes(fixture.operator.name));
      if (language === 'it') assert.match(response.body, /Informativa in attesa di revisione legale\. Il testo non è definitivo\./);
      if (route === '/privacy') {
        for (const value of [fixture.purposes[0].purpose, fixture.purposes[0].legalBasis, fixture.services[0].role, fixture.services[0].transfer,
          fixture.retention.activeSessions.period, fixture.retention.activeSessions.basis, fixture.rights, fixture.complaintAuthority]) {
          assert.ok(response.body.includes(value), value);
        }
      }
    }
  }
});

test('tracked notice configurations contain only synthetic controller details', async () => {
  const root = new URL('../', import.meta.url);
  const files = ['config/privacy.demo.json', 'config/privacy.example.json'];
  const { stdout: tracked } = await promisify(execFile)('git', ['ls-files', '-z', '--', 'config/*privacy*.json'], { cwd: root });
  assert.deepEqual(tracked.split('\0').filter(Boolean), files);
  const operators = [
    { name: 'Demo Operator (synthetic)', address: 'Demo site, fictional jurisdiction', privacyEmail: 'privacy@example.invalid', dpo: '' },
    { name: '', address: '', contact: '', privacyEmail: '', dpo: '' },
  ];
  for (const [index, file] of files.entries()) {
    const config = JSON.parse(await readFile(new URL(file, root), 'utf8'));
    assert.deepEqual(config.operator, operators[index]);
    assert.equal(config.notice.state, 'example');
    for (const field of ['approvedBy', 'approvedAt', 'reviewRef']) assert.equal(config.notice[field], '');
    assert.equal((await requestWith(config)('/privacy')).status, 503);
  }
});
