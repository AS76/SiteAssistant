import test from 'node:test';
import assert from 'node:assert/strict';
import { createOfflineStore, overlayPending, scopeFor, registerSync, SYNC_TAG } from '../app/offline.mjs';
import { createApi, ApiError } from '../app/api.mjs';
import { mockIndexedDB, mockLocks } from './helpers/indexeddb.mjs';

const baseUrl = 'https://example.invalid';
const userId = 'synthetic-user';
const scope = scopeFor(baseUrl, userId);
const task = { siteId: 'synthetic-site', title: 'Synthetic task', assignee: 'Executor', reviewer: 'Verifier', status: 'todo' };
const diary = { siteId: task.siteId, date: '2026-01-02', shift: 'day', actual: 'Synthetic work' };
const networkError = () => new ApiError('apiUnavailable');
async function fixture() {
  const indexedDB = mockIndexedDB(), locks = mockLocks();
  const store = createOfflineStore({ indexedDB, locks });
  await store.setMirror('active', { scope, baseUrl, session: { user: { id: userId } } });
  await store.setMirror(`state:${scope}`, { sites: [], tasks: [], diary: [], attachments: [] });
  const api = { baseUrl, me: async () => ({ user: { id: userId } }) };
  return { store, indexedDB, locks, api, replay: () => store.replayOps(api, { scope, userId }),
    enqueue: (op_type, payload, extra = {}) => store.enqueue({ op_type, payload, scope, ...extra }) };
}

test('enqueue commits UUID/key once, FIFO survives connection reload and equal timestamps', async () => {
  const f = await fixture();
  const one = await f.enqueue('create_task', task, { created_at: '2026-01-01T00:00:00Z' });
  const two = await f.enqueue('create_diary', diary, { created_at: one.created_at });
  assert.match(one.id, /^[0-9a-f-]{36}$/); assert.equal(one.idempotency_key, one.id);
  assert.equal((await f.enqueue('create_task', task, { id: one.id })).id, one.id);
  const reloaded = createOfflineStore({ indexedDB: f.indexedDB, locks: f.locks });
  assert.deepEqual((await reloaded.listOps(scope)).map(op => op.id), [one.id, two.id]);
  const calls = [];
  f.api.createTask = async (payload, options) => { calls.push(['task', options.idempotencyKey]); return { ...payload, id: 'server-task' }; };
  f.api.createDiary = async (payload, options) => { calls.push(['diary', options.idempotencyKey]); return { ...payload, id: 'server-diary' }; };
  await reloaded.replayOps(f.api, { scope, userId });
  assert.deepEqual(calls, [['task', one.idempotency_key], ['diary', two.idempotency_key]]);
  assert.deepEqual(await reloaded.listOps(scope), []);
  assert.equal((await reloaded.getMirror(`state:${scope}`)).tasks[0].id, 'server-task');
  await reloaded.replayOps(f.api, { scope, userId }); assert.equal(calls.length, 2);
  assert.equal((await f.enqueue('create_task', task, { id: one.id })).status, 'confirmed');
  assert.deepEqual(await f.store.listOps(scope), []);
});

test('lost task response retries with the same key and creates no duplicate, preserving FIFO', async () => {
  const f = await fixture(), server = new Map(), keys = [];
  await f.enqueue('create_task', task); await f.enqueue('create_diary', diary);
  let first = true, diaryCalls = 0;
  f.api.createTask = async (payload, { idempotencyKey }) => {
    keys.push(idempotencyKey);
    if (!server.has(idempotencyKey)) server.set(idempotencyKey, { ...payload, id: 'server-id' });
    if (first) { first = false; throw networkError(); }
    return server.get(idempotencyKey);
  };
  f.api.createDiary = async payload => { diaryCalls++; return { ...payload, id: 'diary-id' }; };
  await f.replay(); assert.equal(diaryCalls, 0); assert.equal((await f.store.listOps(scope))[0].retries, 1);
  const reload = createOfflineStore({ indexedDB: f.indexedDB, locks: f.locks });
  await reload.replayOps(f.api, { scope, userId });
  assert.equal(server.size, 1); assert.equal(keys[0], keys[1]); assert.equal(diaryCalls, 1);
});

test('two tabs and a worker serialize replay and do not send an operation twice', async () => {
  const f = await fixture(); await f.enqueue('create_task', task);
  let calls = 0;
  f.api.createTask = async payload => { calls++; await new Promise(resolve => setImmediate(resolve)); return { ...payload, id: 'server-id' }; };
  const worker = createOfflineStore({ indexedDB: f.indexedDB, locks: f.locks });
  await Promise.all([f.replay(), f.replay(), worker.replayOps(f.api, { scope, userId })]);
  assert.equal(calls, 1);
});

test('transition 409 stays failed, keeps server status and is not automatically retried', async () => {
  const f = await fixture(); let calls = 0;
  const serverTask = { ...task, id: 'task-id', events: [] };
  await f.enqueue('transition_task', { task: serverTask, input: { to: 'in_progress', actor: 'Executor' } }, { entity_id: serverTask.id });
  f.api.getTask = async () => serverTask;
  f.api.transitionTask = async () => { calls++; throw new ApiError('Conflict', { status: 409, code: 'INVALID_TRANSITION' }); };
  await f.replay(); await f.replay();
  const ops = await f.store.listOps(scope);
  assert.equal(calls, 1); assert.equal(ops[0].status, 'failed'); assert.equal(ops[0].error.status, 409);
  const visible = overlayPending({ tasks: [serverTask] }, ops);
  assert.equal(visible.tasks[0].status, 'todo'); assert.equal(visible.tasks[0].syncStatus, 'failed');
  await f.store.removeOp(ops[0].id); assert.equal((await f.store.listOps(scope)).length, 0);
});

test('blobs survive reload and dependent photo uses confirmed server entity ID', async () => {
  const f = await fixture(); const parent = await f.enqueue('create_task', task);
  const blob = new Blob(['synthetic photo bytes'], { type: 'image/png' });
  const photo = await f.enqueue('create_attachment', { site_id: task.siteId, entity_type: 'task', entity_id: parent.entity_id, filename: 'synthetic.png', blob });
  const reloaded = createOfflineStore({ indexedDB: f.indexedDB, locks: f.locks });
  assert.equal(await (await reloaded.listOps(scope))[1].payload.blob.text(), await blob.text());
  f.api.createTask = async () => ({ ...task, id: 'server-parent' });
  f.api.listAttachments = async () => [];
  f.api.createAttachment = async (payload, options) => {
    assert.equal(payload.entity_id, 'server-parent'); assert.equal(options.idempotencyKey, photo.idempotency_key);
    assert.equal(await payload.blob.text(), await blob.text()); return { id: 'server-photo', entity_id: payload.entity_id };
  };
  await reloaded.replayOps(f.api, { scope, userId });
  assert.equal((await reloaded.listOps(scope)).length, 0);
});

test('LWW uses timestamps for unsent diary slots and preserves ID and FIFO position', async () => {
  const f = await fixture();
  const original = await f.enqueue('create_diary', diary, { created_at: '2026-01-02T10:00:00Z' });
  const newer = await f.enqueue('create_diary', { ...diary, actual: 'Latest synthetic note' }, { created_at: '2026-01-02T11:00:00Z' });
  await f.enqueue('create_diary', { ...diary, actual: 'Older note' }, { created_at: '2026-01-02T09:00:00Z' });
  const ops = await f.store.listOps(scope);
  assert.equal(ops.length, 1); assert.equal(newer.id, original.id); assert.equal(ops[0].payload.actual, 'Latest synthetic note');
});

test('lost diary response is reconciled by content without a second POST', async () => {
  const f = await fixture(); await f.enqueue('create_diary', diary); let calls = 0;
  f.api.createDiary = async () => { calls++; throw networkError(); };
  f.api.listDiary = async () => [{ ...diary, id: 'confirmed-diary' }];
  await f.replay(); assert.equal((await f.store.listOps(scope))[0].status, 'uncertain');
  await f.replay(); assert.equal(calls, 1); assert.deepEqual(await f.store.listOps(scope), []);
});

test('ambiguous non-idempotent response is flagged for review, never blindly duplicated', async () => {
  const f = await fixture(); await f.enqueue('create_diary', diary); let calls = 0;
  f.api.createDiary = async () => { calls++; throw networkError(); };
  f.api.listDiary = async () => [];
  await f.replay(); await f.replay(); await f.replay();
  assert.equal(calls, 1); const [op] = await f.store.listOps(scope);
  assert.equal(op.status, 'failed'); assert.equal(op.error.code, 'SYNC_UNCERTAIN');
});

test('auth expiry and account/API changes stop replay without losing queued work', async () => {
  const f = await fixture(); await f.enqueue('create_task', task);
  f.api.me = async () => { throw new ApiError('Login', { status: 401 }); };
  await assert.rejects(f.replay(), error => error.status === 401);
  f.api.me = async () => ({ user: { id: 'another-user' } });
  await assert.rejects(f.replay(), /offlineSessionChanged/);
  await f.store.setMirror('active', { scope: 'another-scope', baseUrl });
  await f.replay(); assert.equal((await f.store.listOps(scope)).length, 1);
  assert.deepEqual(await f.store.listOps('another-scope'), []);
});

test('failed parent prevents dependent uploads and does not block unrelated later work', async () => {
  const f = await fixture(); const parent = await f.enqueue('create_task', task);
  await f.enqueue('create_attachment', { entity_id: parent.entity_id }); await f.enqueue('create_diary', diary);
  f.api.createTask = async () => { throw new ApiError('Forbidden', { status: 403 }); };
  f.api.createDiary = async () => ({ ...diary, id: 'server-diary' });
  await f.replay(); const ops = await f.store.listOps(scope);
  assert.equal(ops.length, 2); assert.equal(ops[1].error.code, 'SYNC_DEPENDENCY_FAILED');
});

test('transaction failure rejects enqueue and never shows an uncommitted entity', async () => {
  const f = await fixture(); f.indexedDB.abortNextCommit();
  await assert.rejects(f.enqueue('create_task', task), /QuotaExceededError/);
  assert.equal((await f.store.listOps(scope)).length, 0);
  assert.equal(overlayPending({ tasks: [] }, []).tasks.length, 0);
});

test('queue overlay is repeatable and preserves authoritative states, nulls and pending labels', async () => {
  const f = await fixture(); await f.enqueue('create_task', { ...task, due: null }); await f.enqueue('create_diary', diary);
  const ops = await f.store.listOps(scope); const state = { tasks: [], diary: [] };
  const first = overlayPending(state, ops), second = overlayPending(first, ops);
  assert.deepEqual(first, second); assert.equal(state.tasks.length, 0); assert.equal(second.tasks[0].due, null);
  assert.equal(second.tasks[0].syncStatus, 'pending'); assert.equal(second.diary[0].syncStatus, 'pending');
  assert.equal(overlayPending(second, []).tasks.length, 0);
});

test('API forwards stable keys on all four operations and encodes blob bytes only at upload', async () => {
  const calls = [];
  const api = createApi({ baseUrl, fresh: true, fetchImpl: async (url, input) => { calls.push({ url, ...input }); return Response.json({ id: 'server-id' }); } });
  const options = { idempotencyKey: 'synthetic-operation-key' };
  await api.createTask(task, options); await api.createDiary(diary, options);
  await api.transitionTask({ ...task, id: 'server-id' }, { actor: 'Executor', to: 'in_progress' }, options);
  await api.createAttachment({ entity_type: 'task', entity_id: 'server-id', filename: 'synthetic.png', blob: new Blob(['synthetic'], { type: 'image/png' }) }, options);
  for (const call of calls) { assert.equal(call.headers['Idempotency-Key'], options.idempotencyKey); assert.equal(call.credentials, 'include'); }
  assert.equal(JSON.parse(calls[3].body).data_base64, btoa('synthetic'));
  await api.me(); assert.equal(calls[4].cache, 'reload');
});

test('Background Sync registration has an optional unsupported/denied fallback', async () => {
  let tag; await registerSync({ sync: { register: async value => { tag = value; } } }); assert.equal(tag, SYNC_TAG);
  await registerSync({}); await registerSync({ sync: { register: async () => { throw new Error('Denied'); } } });
});

test('lost photo response reconciles checksum and excludes files present before this upload', async () => {
  const f = await fixture(); const blob = new Blob(['synthetic'], { type: 'image/png' });
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())), byte => byte.toString(16).padStart(2, '0')).join('');
  const original = { id: 'old-file', filename: 'synthetic.png', content_sha256: digest, size: blob.size };
  const files = [original]; let calls = 0;
  await f.enqueue('create_attachment', { site_id: task.siteId, entity_type: 'task', entity_id: 'server-task', filename: original.filename, blob });
  f.api.listAttachments = async () => files;
  f.api.createAttachment = async () => { calls++; files.push({ ...original, id: 'new-file' }); throw networkError(); };
  await f.replay(); await f.replay();
  assert.equal(calls, 1); assert.deepEqual(await f.store.listOps(scope), []);
  assert.equal((await f.store.getMirror(`state:${scope}`)).attachments[0].id, 'new-file');
});

test('lost transition response is reconciled by a new matching event without executing it again', async () => {
  const f = await fixture(); const events = []; let calls = 0;
  const record = { ...task, id: 'server-task', events };
  await f.enqueue('transition_task', { task: record, input: { actor: 'Executor', to: 'in_progress', note: 'Synthetic note' } }, { entity_id: record.id });
  f.api.getTask = async () => ({ ...record, status: events.length ? 'in_progress' : 'todo' });
  f.api.transitionTask = async () => { calls++; events.push({ id: 'event-id', from_status: 'todo', to_status: 'in_progress', actor: 'Executor', note: 'Synthetic note' }); throw networkError(); };
  await f.replay(); await f.replay();
  assert.equal(calls, 1); assert.deepEqual(await f.store.listOps(scope), []);
});

test('confirmation transaction failure preserves task and key for crash-safe acknowledgement', async () => {
  const f = await fixture(); let calls = 0;
  const op = await f.enqueue('create_task', task);
  f.api.createTask = async (payload, options) => {
    assert.equal(options.idempotencyKey, op.idempotency_key);
    if (++calls === 1) f.indexedDB.abortNextCommit();
    return { ...payload, id: 'one-server-task' };
  };
  await f.replay(); assert.equal((await f.store.listOps(scope)).length, 1);
  assert.equal((await f.store.getMirror(`state:${scope}`)).tasks.length, 0);
  await f.replay(); assert.equal((await f.store.getMirror(`state:${scope}`)).tasks.length, 1);
  assert.equal((await f.store.listOps(scope)).length, 0);
});

// Execute the worker with browser primitives and controlled cache/network objects.
// This checks behavior without a socket; the browser flow exercises real installation.
async function workerFixture() {
  const { readFile } = await import('node:fs/promises');
  const { runInNewContext } = await import('node:vm');
  const listeners = {}, buckets = new Map(), notices = [];
  const state = { active: { scope, baseUrl, session: { user: { id: userId } } }, network: async () => Response.json({ version: 1 }), replay: async () => ({ pending: 0 }) };
  const caches = {
    async keys() { return [...buckets.keys()]; },
    async delete(key) { return buckets.delete(key); },
    async open(key) {
      if (!buckets.has(key)) buckets.set(key, new Map());
      const entries = buckets.get(key), url = request => typeof request === 'string' ? request : request.url;
      return {
        async addAll(urls) { for (const url of urls) entries.set(url, new Response('synthetic shell')); },
        async match(request) { return entries.get(url(request))?.clone(); },
        async put(request, response) { entries.set(url(request), response.clone()); },
        async delete(request) { return entries.delete(url(request)); },
      };
    },
  };
  const source = (await readFile(new URL('../app/sw.js', import.meta.url), 'utf8')).replace(/^import .*;\n/gm, '');
  runInNewContext(source, {
    self: { location: { origin: baseUrl }, registration: { scope: `${baseUrl}/` }, addEventListener: (event, handler) => { listeners[event] = handler; }, clients: { claim: async () => {}, matchAll: async () => [{ postMessage: message => notices.push(message) }] } },
    caches, URL, fetch: request => state.network(request), getMirror: async () => state.active,
    createApi: () => ({}), replayOps: (...args) => state.replay(...args), SYNC_TAG,
  });
  async function dispatch(type, props = {}) {
    const waits = []; let response;
    listeners[type]({ ...props, waitUntil: promise => waits.push(promise), respondWith: promise => { response = promise; } });
    const result = await response;
    await Promise.all(waits);
    return result;
  }
  return { state, caches, notices, dispatch, buckets };
}

test('worker precaches the shell and serves navigation and modules with the network down', async () => {
  const f = await workerFixture(); await f.dispatch('install'); await f.dispatch('activate');
  f.state.network = async () => { throw networkError(); };
  for (const path of ['/app.mjs', '/offline.mjs', '/manifest.webmanifest']) {
    assert.equal(await (await f.dispatch('fetch', { request: new Request(`${baseUrl}${path}`) })).text(), 'synthetic shell');
  }
  assert.equal(await (await f.dispatch('fetch', { request: { method: 'GET', url: `${baseUrl}/`, mode: 'navigate' } })).text(), 'synthetic shell');
});

test('worker GET cache is stale-while-revalidate, scoped, and explicit refresh bypasses it', async () => {
  const f = await workerFixture(), request = new Request(`${baseUrl}/api/tasks`);
  assert.equal((await (await f.dispatch('fetch', { request })).json()).version, 1);
  f.state.network = async () => Response.json({ version: 2 });
  assert.equal((await (await f.dispatch('fetch', { request })).json()).version, 1);
  assert.equal((await (await f.dispatch('fetch', { request })).json()).version, 2);
  f.state.network = async () => { throw networkError(); };
  assert.equal((await (await f.dispatch('fetch', { request })).json()).version, 2);
  await assert.rejects(f.dispatch('fetch', { request: new Request(request, { cache: 'reload' }) }));
  f.state.active = { ...f.state.active, scope: 'another-user' };
  await assert.rejects(f.dispatch('fetch', { request }));
});

test('worker excludes auth, POST, binary and unrelated origins and evicts authorization errors', async () => {
  const f = await workerFixture();
  const request = new Request(`${baseUrl}/api/tasks`);
  await f.dispatch('fetch', { request });
  f.state.network = async () => Response.json({ error: 'Forbidden', code: 'MODULE_FORBIDDEN' }, { status: 403 });
  assert.equal((await f.dispatch('fetch', { request: new Request(request, { cache: 'reload' }) })).status, 403);
  assert.equal(f.notices[0].type, 'offline-access-denied');
  assert.equal(f.notices[0].code, 'MODULE_FORBIDDEN');
  for (const url of [`${baseUrl}/api/auth/me`, `${baseUrl}/api/attachments/file`, 'https://other.invalid/api/tasks']) await f.dispatch('fetch', { request: new Request(url) });
  assert.equal(await f.dispatch('fetch', { request: new Request(request, { method: 'POST' }) }), undefined);
  f.state.network = async () => { throw networkError(); };
  for (const url of [request.url, `${baseUrl}/api/auth/me`, `${baseUrl}/api/attachments/file`, 'https://other.invalid/api/tasks']) await assert.rejects(f.dispatch('fetch', { request: new Request(url) }));
});

test('worker Background Sync replays without a page and rejects transient work for browser retry', async () => {
  const f = await workerFixture(); let calls = 0;
  f.state.replay = async (api, options) => { calls++; assert.equal(options.scope, scope); return { pending: 0 }; };
  await f.dispatch('sync', { tag: SYNC_TAG }); assert.equal(calls, 1); assert.equal(f.notices[0].type, 'offline-synced');
  f.state.replay = async () => ({ pending: 1 });
  await assert.rejects(f.dispatch('sync', { tag: SYNC_TAG }), /connectivity/);
  f.state.active = null; await f.dispatch('sync', { tag: SYNC_TAG });
});
