import test from 'node:test';
import assert from 'node:assert/strict';
import { initialView, navGroups } from '../app/domain.mjs';
import { buildPlaceOptions, filterPlaceOptions, placeBreadcrumb } from '../app/place-selector.mjs';
import { buildPlaceTree, filterPlaceTree, placeActions } from '../app/places-ui.mjs';

const site = { id: 'site-a', name: 'Synthetic site' };
const row = (id, name, kind, parent_id = null, archived_at = null) =>
  ({ id, name, kind, parent_id, archived_at, site_id: site.id });
const east = row('east', 'East', 'building');
const west = row('west', 'West', 'building');
const first = row('first', 'Access room', 'room', east.id);
const second = row('second', 'Access room', 'room', west.id);
const yard = row('yard', 'Yard', 'zone');
const archive = row('archive', 'Old room', 'room', yard.id, '2026-01-20T09:00:00.000Z');
const places = [first, second, yard, west, east, archive];

test('buildPlaceTree uses parent IDs and supports omitted levels with unordered input', () => {
  const tree = buildPlaceTree(places);
  assert.deepEqual(tree.map(place => place.id), ['yard', 'west', 'east']);
  assert.deepEqual(tree.map(place => place.children.map(child => child.id)), [['archive'], ['second'], ['first']]);
  assert.ok(places.every(place => !Object.hasOwn(place, 'children')));
});

test('breadcrumb begins at the site and uses the current parent after a move', () => {
  const byId = new Map(places.map(place => [place.id, place]));
  assert.deepEqual(placeBreadcrumb(byId, first.id, site), [
    { ...site, kind: 'site' },
    { id: 'east', name: 'East', kind: 'building' },
    { id: 'first', name: 'Access room', kind: 'room' },
  ]);
  byId.set(first.id, { ...first, parent_id: west.id });
  assert.deepEqual(placeBreadcrumb(byId, first.id, site).map(place => place.id), [site.id, west.id, first.id]);
  assert.deepEqual(placeBreadcrumb(byId, yard.id, site).map(place => place.id), [site.id, yard.id]);
});

test('kind and status filters retain ancestors as context and preserve the unfiltered tree', () => {
  const tree = buildPlaceTree(places);
  const filtered = filterPlaceTree(tree, { kind: 'room', status: 'archived' });
  assert.deepEqual(filtered.map(place => [place.id, place.matches]), [['yard', false]]);
  assert.deepEqual(filtered[0].children.map(place => [place.id, place.matches]), [['archive', true]]);
  assert.deepEqual(filterPlaceTree(tree, { kind: 'room', status: 'active' }).map(place => place.id), ['west', 'east']);
  assert.deepEqual(filterPlaceTree(tree).map(place => place.children.length), [1, 1, 1]);
  assert.deepEqual(filterPlaceTree(tree, { kind: 'floor' }), []);
});

test('the selector shows full paths for homonyms, omits archived and other-site options, and searches names', () => {
  const foreign = { ...first, id: 'foreign', site_id: 'site-b' };
  const rows = [...places, foreign, row('accent', 'Área room', 'room', yard.id)];
  const options = buildPlaceOptions(rows, site);
  assert.deepEqual(filterPlaceOptions(options, 'ACCESS').map(option => option.label),
    ['Synthetic site › East › Access room', 'Synthetic site › West › Access room']);
  assert.deepEqual(filterPlaceOptions(options, 'area').map(option => option.id), ['accent']);
  assert.deepEqual(filterPlaceOptions(options, 'Synthetic site'), []);
  assert.deepEqual(filterPlaceOptions(options, 'Old room'), []);
  assert.ok(!options.some(option => option.id === foreign.id));
  const eligible = buildPlaceOptions(rows, site, place => place.kind === 'room');
  assert.equal(eligible[0].label, 'Synthetic site › East › Access room');
  const exact = buildPlaceOptions([...rows, { ...first, id: 'duplicate' }], site);
  assert.deepEqual(exact.filter(option => ['first', 'duplicate'].includes(option.id)).map(option => option.label), [
    'Synthetic site › East › Access room · first', 'Synthetic site › East › Access room · duplicate',
  ]);
});

test('only the site owner and sandbox role see edit actions, and archived records are read-only', () => {
  for (const role of ['owner', 'demo_user']) {
    assert.deepEqual(placeActions(role), ['create']);
    assert.deepEqual(placeActions(role, first), ['rename', 'move', 'archive']);
    assert.deepEqual(placeActions(role, archive), []);
  }
  for (const role of ['editor', 'verifier', 'viewer', undefined]) {
    assert.deepEqual(placeActions(role), []);
    assert.deepEqual(placeActions(role, first), []);
  }
});

test('legacy area text is searchable on the unmapped choice', () => {
  const empty = { id: null, label: 'No place selected', searchText: 'No place selected', place: null };
  const options = [empty, ...buildPlaceOptions(places, site)];
  assert.deepEqual(filterPlaceOptions(options, 'QUAY', 'Synthetic quay'), [empty]);
  assert.deepEqual(filterPlaceOptions(options, 'QUAY'), []);
});

test('Places deep links resolve on desktop and mobile, even with an explicit module denial', () => {
  for (const width of [390, 1440]) assert.equal(initialView({ width, hash: '#places' }), 'places');
  const [, siteGroup] = navGroups({ places: false, progress: false, bookings: false, wbs: false, impacts: false });
  // Places stays visible under an explicit denial; assets is the other core Site destination.
  assert.deepEqual(siteGroup.items, ['places', 'assets']);
});
