import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultViewState, sanitizeViewState, viewStatePayload, TASK_COLUMNS, STATUSES, PRIORITIES } from '../app/domain.mjs';
import { createApi, ApiError } from '../app/api.mjs';

test('saved view defaults are independent and use the seven task columns in order', () => {
  assert.deepEqual(TASK_COLUMNS, ['title', 'area', 'status', 'company', 'assignee', 'reviewer', 'due']);
  const state = defaultViewState();
  assert.deepEqual(state, { filters: { search: '', status: '', person: '', priority: '' },
    sort: { key: 'due', direction: 'asc' }, columns: [...TASK_COLUMNS], layout: 'board' });
  state.filters.search = 'Synthetic search'; state.sort.key = 'title'; state.columns.pop();
  assert.equal(defaultViewState().filters.search, '');
  assert.equal(defaultViewState().sort.key, 'due');
  assert.deepEqual(defaultViewState().columns, TASK_COLUMNS);
});

test('non-object and legacy saved payloads fall back to defaults without coercion', () => {
  for (const value of [undefined, null, false, 42, NaN, 1n, Symbol('synthetic'), 'list', '{"layout":"list"}', [], ['title'], () => {}, new Date(0)]) {
    assert.deepEqual(sanitizeViewState(value), defaultViewState());
  }
  assert.deepEqual(sanitizeViewState({ search: 'Old format', taskView: 'list', sortBy: 'title' }), defaultViewState());
});

test('partial states retain valid values and discard all unknown keys', () => {
  const payload = { filters: { search: 'Synthetic', person: 'Example person', extra: 'ignored' },
    sort: { direction: 'desc', extra: true }, layout: 'list', extra: { deeply: ['ignored'] } };
  const before = structuredClone(payload);
  assert.deepEqual(sanitizeViewState(payload), { filters: { search: 'Synthetic', status: '', person: 'Example person', priority: '' },
    sort: { key: 'due', direction: 'desc' }, columns: [...TASK_COLUMNS], layout: 'list' });
  assert.deepEqual(payload, before);
});

test('wrong nested types, enums, sort keys and layout are repaired', () => {
  for (const value of [null, [], 'wrong', 5, true]) {
    assert.deepEqual(sanitizeViewState({ filters: value, sort: value, columns: value, layout: value }), defaultViewState());
  }
  assert.deepEqual(sanitizeViewState({ filters: { search: {}, person: 9, status: 'unknown', priority: 'unknown' },
    sort: { key: '__proto__', direction: 'ascending' }, columns: ['unknown'], layout: 'grid' }), defaultViewState());
  assert.deepEqual(sanitizeViewState({ filters: { status: ['closed'], priority: { toString: () => 'high' } },
    sort: { key: ['title'], direction: {} }, layout: ['list'] }), defaultViewState());
});

test('every known status, priority, sort key, direction and layout survives', () => {
  for (const status of STATUSES) assert.equal(sanitizeViewState({ filters: { status } }).filters.status, status);
  for (const priority of PRIORITIES) assert.equal(sanitizeViewState({ filters: { priority } }).filters.priority, priority);
  for (const key of TASK_COLUMNS) for (const direction of ['asc', 'desc']) {
    assert.deepEqual(sanitizeViewState({ sort: { key, direction } }).sort, { key, direction });
  }
  for (const layout of ['board', 'list']) assert.equal(sanitizeViewState({ layout }).layout, layout);
});

test('columns are deduplicated and canonical; unusable selections restore all columns', () => {
  assert.deepEqual(sanitizeViewState({ columns: ['due', 'title', 'bogus', 'title', null, {}] }).columns, ['title', 'due']);
  assert.deepEqual(sanitizeViewState({ columns: ['reviewer'] }).columns, ['reviewer']);
  for (const columns of [[], [null, 1, {}, 'unknown'], 'title']) {
    assert.deepEqual(sanitizeViewState({ columns }).columns, TASK_COLUMNS);
  }
});

test('huge nested junk, cycles and hostile objects never get traversed or serialized', () => {
  const payload = { filters: { search: 'x'.repeat(100000), person: 'y'.repeat(100000) }, columns: new Array(100000).fill({ junk: true }) };
  payload.extra = payload;
  Object.defineProperty(payload, 'unknown', { get() { throw new Error('Must not read unknown fields'); } });
  const clean = sanitizeViewState(payload);
  assert.equal(clean.filters.search.length, 512);
  assert.equal(clean.filters.person.length, 512);
  assert.deepEqual(clean.columns, TASK_COLUMNS);
  assert.doesNotThrow(() => JSON.stringify(viewStatePayload(payload)));
  const hostile = { get filters() { throw new Error('Synthetic getter'); } };
  assert.deepEqual(sanitizeViewState(hostile), defaultViewState());
  const { proxy, revoke } = Proxy.revocable({}, {}); revoke();
  assert.deepEqual(sanitizeViewState(proxy), defaultViewState());
  assert.deepEqual(sanitizeViewState(Object.create({ layout: 'list', filters: { search: 'inherited' } })), defaultViewState());
  assert.deepEqual(sanitizeViewState(JSON.parse('{"__proto__":{"layout":"list"},"constructor":{"evil":true}}')), defaultViewState());
});

test('payload round-trips unchanged with only contract keys and well under 16 KB', () => {
  // JSON escaping costs six bytes per control character or unpaired surrogate.
  for (const text of ['\u0000'.repeat(512), '\ud800'.repeat(512), '界'.repeat(512), '😀'.repeat(256)]) {
    const state = { filters: { search: text, status: 'in_progress', person: text, priority: 'urgent' },
      sort: { key: 'reviewer', direction: 'desc' }, columns: [...TASK_COLUMNS], layout: 'list' };
    const payload = viewStatePayload(state);
    assert.deepEqual(payload, state);
    assert.deepEqual(sanitizeViewState(JSON.parse(JSON.stringify(payload))), payload);
    assert.deepEqual(Object.keys(payload), ['filters', 'sort', 'columns', 'layout']);
    assert.ok(Buffer.byteLength(JSON.stringify(payload), 'utf8') < 8 * 1024);
    payload.columns.pop(); payload.filters.search = 'changed';
    assert.equal(state.columns.length, 7); assert.equal(state.filters.search, text);
  }
});

const input = { site_id: 'synthetic-site', module: 'tasks', name: 'Example view', shared: true, payload: defaultViewState() };
const calls = [
  { name: 'listViews', run: api => api.listViews('site /?&', 'tasks &'), path: '/api/views?site_id=site+%2F%3F%26&module=tasks+%26', method: 'GET', response: [{ id: 'synthetic-view', ...input }] },
  { name: 'createView', run: api => api.createView(input), path: '/api/views', method: 'POST', body: input, response: { id: 'synthetic-view', ...input }, status: 201 },
  { name: 'updateView', run: api => api.updateView('view /?&', { name: 'Renamed', shared: false, payload: defaultViewState() }), path: '/api/views/view%20%2F%3F%26', method: 'PATCH', body: { name: 'Renamed', shared: false, payload: defaultViewState() }, response: { id: 'synthetic-view', ...input, name: 'Renamed' } },
  { name: 'deleteView', run: api => api.deleteView('view /?&'), path: '/api/views/view%20%2F%3F%26', method: 'DELETE', response: { deleted: true } },
];

for (const call of calls) {
  test(`${call.name}: URL, method, credentials, body and unchanged response`, async () => {
    let count = 0;
    const api = createApi({ baseUrl: 'https://api.example.invalid///', fetchImpl: async (url, options) => {
      count++;
      assert.equal(url, `https://api.example.invalid${call.path}`);
      assert.equal(options.credentials, 'include');
      assert.equal(options.method || 'GET', call.method);
      if (call.body) {
        assert.equal(options.headers['Content-Type'], 'application/json');
        assert.deepEqual(JSON.parse(options.body), call.body);
      } else assert.equal(options.body, undefined);
      return Response.json(call.response, { status: call.status || 200 });
    } });
    assert.deepEqual(await call.run(api), call.response);
    assert.equal(count, 1);
  });

  test(`${call.name}: API error codes and unauthorized callback survive`, async () => {
    for (const [status, code] of [[409, 'VIEW_NAME_TAKEN'], [404, 'VIEW_NOT_FOUND'], [403, 'VIEW_FORBIDDEN'], [400, 'VIEW_INVALID'], [401, 'AUTH_REQUIRED'], [403, 'FORBIDDEN']]) {
      let cleared = 0;
      const api = createApi({ onUnauthorized: () => cleared++, fetchImpl: async () => Response.json({ error: 'Synthetic error', code }, { status }) });
      await assert.rejects(() => call.run(api), error => error instanceof ApiError && error.code === code && error.status === status && error.message === 'Synthetic error');
      assert.equal(cleared, status === 401 ? 1 : 0);
    }
  });

  test(`${call.name}: network and malformed-response errors use the existing mapping`, async () => {
    await assert.rejects(() => call.run(createApi({ fetchImpl: async () => { throw new Error('Synthetic network failure'); } })),
      error => error instanceof ApiError && error.code === 'NETWORK_ERROR' && error.message === 'apiUnavailable');
    await assert.rejects(() => call.run(createApi({ fetchImpl: async () => new Response('not json', { status: 502 }) })),
      error => error instanceof ApiError && error.code === 'INVALID_RESPONSE' && error.status === 502);
  });
}

test('view reads respect fresh credentials and partial PATCH bodies stay partial', async () => {
  const requests = [];
  const api = createApi({ baseUrl: '/', fresh: true, fetchImpl: async (url, options) => {
    requests.push({ url, options }); return Response.json({});
  } });
  await api.listViews('synthetic-site', 'tasks');
  assert.deepEqual(requests[0].options, { credentials: 'include', cache: 'reload' });
  for (const patch of [{ name: 'Renamed' }, { payload: defaultViewState() }]) {
    await api.updateView('synthetic-view', patch);
    assert.deepEqual(JSON.parse(requests.at(-1).options.body), patch);
  }
});
