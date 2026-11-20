import test from 'node:test';
import assert from 'node:assert/strict';
import { confirmPhrase, isSyntheticEmail, planHygiene, sitesMissingSyntheticOwner } from '../scripts/demo-identity-hygiene.mjs';

test('synthetic demo domains are recognized, real domains are not', () => {
  assert.equal(isSyntheticEmail('owner@siteassistant.invalid'), true);
  assert.equal(isSyntheticEmail('team@example.invalid'), true);
  assert.equal(isSyntheticEmail('person@example.com'), false);
  assert.equal(isSyntheticEmail(''), false);
});

test('hygiene plan keeps only non-synthetic accounts and masks their labels', () => {
  const plan = planHygiene([
    { user_id: 'u1', email: 'owner@siteassistant.invalid', site_code: 'FITT-01', role: 'owner' },
    { user_id: 'u2', email: 'person@example.com', site_code: 'FITT-01', role: 'owner' },
    { user_id: 'u2', email: 'person@example.com', site_code: 'NL-IT-01', role: 'viewer' },
  ]);
  assert.equal(plan.length, 1);
  assert.equal(plan[0].label, 'account-1');
  assert.deepEqual(plan[0].memberships, [
    { siteCode: 'FITT-01', role: 'owner' },
    { siteCode: 'NL-IT-01', role: 'viewer' },
  ]);
  assert.equal(JSON.stringify(plan).includes('person@example.com'), false);
});

test('reports an affected site with no synthetic owner', () => {
  const rows = [
    { user_id: 'u1', email: 'owner@siteassistant.invalid', site_code: 'FITT-01', role: 'owner' },
    { user_id: 'u2', email: 'person@example.com', site_code: 'FITT-01', role: 'viewer' },
    { user_id: 'u2', email: 'person@example.com', site_code: 'NL-IT-01', role: 'owner' },
  ];
  assert.deepEqual(sitesMissingSyntheticOwner(rows, planHygiene(rows)), ['NL-IT-01']);
});

test('accepts an active synthetic owner on every affected site', () => {
  const rows = [
    { user_id: 'u1', email: 'owner@siteassistant.invalid', site_code: 'FITT-01', role: 'owner' },
    { user_id: 'u2', email: 'team@siteassistant.example', site_code: 'NL-IT-01', role: 'owner' },
    { user_id: 'u3', email: 'person@example.com', site_code: 'FITT-01', role: 'owner' },
    { user_id: 'u3', email: 'person@example.com', site_code: 'NL-IT-01', role: 'viewer' },
  ];
  assert.deepEqual(sitesMissingSyntheticOwner(rows, planHygiene(rows)), []);
});

test('reports an affected site whose synthetic owner is disabled', () => {
  const rows = [
    { user_id: 'u1', email: 'owner@siteassistant.invalid', site_code: 'FITT-01', role: 'owner', disabled_at: '2026-01-01T00:00:00Z' },
    { user_id: 'u2', email: 'person@example.com', site_code: 'FITT-01', role: 'owner' },
  ];
  assert.deepEqual(sitesMissingSyntheticOwner(rows, planHygiene(rows)), ['FITT-01']);
});

test('parses separate and inline confirmation values', () => {
  assert.equal(confirmPhrase(['--apply', '--confirm', 'demo-identity-hygiene']), 'demo-identity-hygiene');
  assert.equal(confirmPhrase(['--apply', '--confirm=demo-identity-hygiene']), 'demo-identity-hygiene');
  assert.equal(confirmPhrase(['--apply', '--confirm', 'wrong']), 'wrong');
  assert.equal(confirmPhrase(['--apply', '--confirm=wrong']), 'wrong');
});

test('returns null for missing, empty, or conflicting confirmation values', () => {
  assert.equal(confirmPhrase(['--apply']), null);
  assert.equal(confirmPhrase(['--apply', '--confirm']), null);
  assert.equal(confirmPhrase(['--confirm', '--apply']), null);
  assert.equal(confirmPhrase(['--apply', '--confirm', '']), null);
  assert.equal(confirmPhrase(['--apply', '--confirm=']), null);
  assert.equal(confirmPhrase(['--apply', '--confirm=demo-identity-hygiene', '--confirm', 'wrong']), null);
});
