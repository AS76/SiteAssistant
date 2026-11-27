import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPlaceTree, filterPlaceTree, placeActions, placeBreadcrumb } from '../app/places-ui.mjs';
import { searchPlaceOptions } from '../app/place-selector.mjs';
import { initialView, navGroups } from '../app/domain.mjs';

const site = { id: 'site', name: 'Cantiere esempio' };
const places = [
  { id: 'a', kind: 'building', name: 'Edificio A', parent_id: null },
  { id: 'b', kind: 'building', name: 'Edificio B', parent_id: null },
  { id: 'r1', kind: 'room', name: 'Locale tecnico', parent_id: 'a', aliases: [
    { namespace: 'catalogo', original_code: 'LT-À01', canonical_code: 'LT-001' },
    { original_code: 'Obsoleto', canonical_code: 'Old', valid_to: '2026-11-24' },
  ] },
  { id: 'r2', kind: 'room', name: 'Locale tecnico', parent_id: 'b', code: 'LT-002' },
  { id: 'r3', kind: 'room', name: 'Archivio', parent_id: 'b', archived_at: '2026-11-23' },
  { id: 'z', kind: 'zone', name: 'Zona esterna', parent_id: null },
];

test('tree connects omitted hierarchy levels and keeps site roots', () => {
  const roots = buildPlaceTree([places[2], ...places.filter(place => place.id !== 'r1')]);
  assert.deepEqual(roots.map(node => node.id), ['a', 'b', 'z']);
  assert.deepEqual(roots[0].children.map(node => node.id), ['r1']);
  assert.deepEqual(roots[1].children.map(node => node.id), ['r2', 'r3']);
  assert.equal(places[0].children, undefined);
});

test('breadcrumb follows current parent IDs and includes the site root', () => {
  assert.deepEqual(placeBreadcrumb(places, 'r1', site).map(node => node.name),
    ['Cantiere esempio', 'Edificio A', 'Locale tecnico']);
  const moved = places.map(place => place.id === 'r1' ? { ...place, parent_id: 'b' } : place);
  assert.deepEqual(placeBreadcrumb(moved, 'r1', site).map(node => node.id), ['site', 'b', 'r1']);
});

test('kind and status filters keep only matching nodes and their ancestor context', () => {
  const tree = buildPlaceTree(places);
  const archivedRooms = filterPlaceTree(tree, { kind: 'room', status: 'archived' });
  assert.deepEqual(archivedRooms.map(node => [node.id, node.matches]), [['b', false]]);
  assert.deepEqual(archivedRooms[0].children.map(node => [node.id, node.matches]), [['r3', true]]);
  const activeRooms = filterPlaceTree(tree, { kind: 'room', status: 'active' });
  assert.deepEqual(activeRooms.flatMap(node => node.children.map(child => child.id)), ['r1', 'r2']);
  assert.equal(tree[1].children.length, 2);
});

test('picker resolves homonyms by full path and searches original, canonical and direct codes', () => {
  const homonyms = searchPlaceOptions(places, 'LOCALE TECNICO', site);
  assert.deepEqual(homonyms.map(result => result.path), [
    'Cantiere esempio › Edificio A › Locale tecnico',
    'Cantiere esempio › Edificio B › Locale tecnico',
  ]);
  for (const query of ['lt-a\u030001', 'lt-001', 'catalogo lt-001']) {
    assert.deepEqual(searchPlaceOptions(places, query, site).map(result => result.place.id), ['r1']);
  }
  assert.deepEqual(searchPlaceOptions(places, 'lt-002', site).map(result => result.place.id), ['r2']);
  assert.deepEqual(searchPlaceOptions(places, 'archivio', site), []);
  assert.deepEqual(searchPlaceOptions(places, 'obsoleto', site), []);
  assert.deepEqual(searchPlaceOptions(places, 'locale tecnico', site, place => place.id === 'r2')
    .map(result => result.place.id), ['r2']);
});

test('viewers and verifiers see history without mutation buttons', () => {
  const place = places[2];
  for (const role of ['viewer', 'verifier']) {
    assert.deepEqual(placeActions({ role, place }), {
      history: true, create: false, rename: false, move: false, archive: false, aliases: false,
    });
  }
});

test('write buttons follow editor, owner, sandbox and archived state', () => {
  const place = places[2];
  for (const args of [{ role: 'owner' }, { role: 'editor' }, { role: 'demo_user', demoSandbox: true }]) {
    assert.deepEqual(placeActions({ ...args, place }), {
      history: true, create: true, rename: true, move: true, archive: true, aliases: true,
    });
  }
  assert.equal(placeActions({ role: 'demo_user', place }).aliases, false);
  assert.equal(placeActions({ role: 'owner', place: places[4] }).archive, false);
  assert.equal(placeActions({ role: 'owner', place, offline: true }).move, false);
});

test('places is a routable site destination available without optional modules', () => {
  assert.equal(initialView({ width: 375, hash: '#places' }), 'places');
  assert.ok(navGroups().find(group => group.label === 'navSite').items.includes('places'));
});
