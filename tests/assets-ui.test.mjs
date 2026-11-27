import test from 'node:test';
import assert from 'node:assert/strict';
import { assetActions, filterAssets, sortAssets } from '../app/assets-ui.mjs';
import { createApi } from '../app/api.mjs';
import { initialView, navGroups } from '../app/domain.mjs';

const rows = [
  { id: 'three', tag: 'PUMP-10', name: 'Pump', serial_number: 'SYN-84', status: 'installed' },
  { id: 'two', tag: 'PUMP-2', name: 'Pump', serial_number: null, status: 'planned' },
  { id: 'one', tag: 'VALVE-1', name: 'Valve', serial_number: 'Pump-2-serial', status: 'installed' },
];

test('asset search matches either tag or serial number and combines with the status filter', () => {
  const ids = options => filterAssets(rows, options).map(row => row.id);
  assert.deepEqual(ids({ search: ' PumP-2 ' }), ['two', 'one']);
  assert.deepEqual(ids({ search: 'pump-2', status: 'installed' }), ['one']);
  assert.deepEqual(ids({ search: 'pump-2', status: 'planned' }), ['two']);
  assert.deepEqual(ids({ search: 'syn-84' }), ['three']);
  assert.deepEqual(ids({ search: 'Valve', status: 'planned' }), []);
  assert.deepEqual(ids({ status: 'installed' }), ['three', 'one']);
  assert.deepEqual(ids({}), ['three', 'two', 'one']);
});

test('asset ordering uses the numeric parts of tags, then name and ID, without mutating inputs', () => {
  const catalog = Object.freeze([...rows, { ...rows[1], id: 'first', name: 'Backup pump' },
    { ...rows[1], id: 'second', name: 'Backup pump' }]);
  assert.deepEqual(sortAssets(catalog, 'en').map(row => row.id), ['first', 'second', 'two', 'three', 'one']);
  assert.deepEqual(catalog.map(row => row.id), ['three', 'two', 'one', 'first', 'second']);
});

test('asset actions depend on the site role, status and archive state', () => {
  for (const role of ['owner', 'editor', 'demo_user']) {
    assert.deepEqual(assetActions(role, { status: 'planned' }), ['install', 'decommission']);
    assert.deepEqual(assetActions(role, { status: 'installed' }), ['move', 'replace', 'decommission']);
    for (const status of ['replaced', 'decommissioned']) assert.deepEqual(assetActions(role, { status }), []);
    assert.deepEqual(assetActions(role, { status: 'installed', archived_at: '2026-01-01' }), []);
    assert.deepEqual(assetActions(role, null), []);
  }
  for (const role of ['verifier', 'viewer', undefined]) {
    for (const status of ['planned', 'installed']) assert.deepEqual(assetActions(role, { status }), []);
  }
});

test('Assets is a core Site destination on narrow and wide screens', () => {
  for (const width of [390, 1440]) assert.equal(initialView({ width, hash: '#assets' }), 'assets');
  assert.ok(navGroups({ assets: false }).find(group => group.label === 'navSite').items.includes('assets'));
});

test('asset API client uses the read routes and existing lifecycle mutations', async () => {
  const calls = [];
  const api = createApi({ baseUrl: 'https://example.invalid', fetchImpl: async (url, options) => {
    calls.push([url, options.method ?? 'GET', options.body && JSON.parse(options.body)]);
    return new Response('{}', { status: 200 });
  } });
  const filters = { tag: 'PUMP & 1', serial: 'SYN-1', status: 'planned', placeId: 'place', includeArchived: true };
  await api.listAssets('site', filters);
  await api.getAsset('asset');
  await api.listAssetPositions('asset');
  await api.updateAsset('asset', { status: 'installed', installedOn: '2026-01-01' });
  await api.moveAsset('asset', { placeId: 'place' });
  assert.deepEqual(calls, [
    ['https://example.invalid/api/assets?siteId=site&includeArchived=1&tag=PUMP+%26+1&serial=SYN-1&status=planned&placeId=place', 'GET', undefined],
    ['https://example.invalid/api/assets/asset', 'GET', undefined],
    ['https://example.invalid/api/assets/asset/positions', 'GET', undefined],
    ['https://example.invalid/api/assets/asset', 'PATCH', { status: 'installed', installedOn: '2026-01-01' }],
    ['https://example.invalid/api/assets/asset/move', 'POST', { placeId: 'place' }],
  ]);
});
