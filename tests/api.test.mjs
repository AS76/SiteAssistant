import { authFixture } from './helpers/auth.mjs';
import { createSite } from '../server/repository.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApi, DEFAULT_BASE_URL, ApiError } from '../app/api.mjs';
import { createServer } from '../server/http.mjs';
import { openTestDb } from './helpers/db.mjs';

async function fixture(t) {
  const storage = await openTestDb();
  const bootstrap = await createSite(storage.db, { code: 'BOOTSTRAP', name: 'Synthetic bootstrap' });
  const { users, cookies } = await authFixture(storage.db, bootstrap);
  let cookie = cookies.owner;
  const server = createServer(storage.db);
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await storage.close(); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const fetchImpl = async (url, options = {}) => {
    const response = await fetch(url, { ...options, headers: { ...options.headers, cookie } });
    if (response.headers.has('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    return response;
  };
  return { baseUrl, bootstrap, users, db: storage.db, cookie, api: createApi({ baseUrl: `${baseUrl}/`, fetchImpl }) };
}

test('API client round-trip: sites, tasks, transitions/events and diary against the HTTP API', async t => {
  const { api, bootstrap, users, db } = await fixture(t);
  assert.deepEqual((await api.listSites()).map(site => site.id), [bootstrap.id]);
  const site = await api.createSite({ code: 'API-01', name: 'Example site', start: '2026-01-01' });
  await db.run("INSERT INTO site_members (site_id, user_id, role) VALUES (?, ?, 'verifier')", site.id, users.verifier.id);
  assert.equal(site.start, '2026-01-01');
  assert.equal(site.end, null);
  const task = await api.createTask({ siteId: site.id, title: 'Example task', assignee: 'Example executor', reviewer: 'Example verifier', due: '2026-01-02' });
  assert.equal(task.assignee, 'Example executor');
  assert.equal(task.reviewer, 'Example verifier');
  assert.equal(task.due, '2026-01-02');
  assert.deepEqual(await api.listTasks({ siteId: site.id, status: 'closed' }), []);
  assert.equal((await api.listTasks({ siteId: site.id }))[0].siteId, site.id);
  let updated = await api.transitionTask(task, { to: 'in_progress', actor: 'Example executor' });
  updated = await api.transitionTask(updated, { to: 'to_verify', actor: 'Example executor', note: 'Evidence' });
  await api.login({ email: users.verifier.email, password: 'Synthetic-test-password!' });
  updated = await api.transitionTask(updated, { to: 'closed', actor: 'Example verifier', note: 'Checked' });
  updated = await api.transitionTask(updated, { to: 'in_progress', actor: 'Example verifier', reason: 'Follow-up' });
  assert.equal(updated.events.length, 5);
  assert.equal(updated.events.at(-1).from_status, 'closed');
  assert.equal(updated.events.at(-1).to_status, 'in_progress');
  assert.equal(updated.events.at(-1).reason, 'Follow-up');
  assert.deepEqual(await api.getTask(task.id), updated);
  const diary = await api.createDiary({ siteId: site.id, date: '2026-01-01', shift: 'night', plan: 'Plan', actual: 'Actual', blockers: 'Delay', next: 'Next' });
  assert.equal(diary.blockers, 'Delay');
  assert.equal(diary.next, 'Next');
  assert.equal(diary.date, '2026-01-01');
  assert.ok(diary.createdAt);
  assert.deepEqual(await api.listDiary({ siteId: site.id }), [diary]);
  await assert.rejects(api.createDiary({ siteId: site.id, date: diary.date, shift: diary.shift }), error => error.status === 409 && error.code === 'DUPLICATE_DIARY');
  await api.login({ email: users.owner.email, password: 'Synthetic-test-password!' });
  await assert.rejects(api.createSite({ code: site.code, name: 'Duplicate' }), error => error instanceof ApiError && error.code === 'DUPLICATE_SITE_CODE');
});

test('CORS permits the frontend origin on preflight, reads, writes and errors only', async t => {
  const { baseUrl, cookie } = await fixture(t);
  const origin = 'https://siteassistant.asassi.cloud';
  const preflight = await fetch(`${baseUrl}/api/sites`, { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' } });
  assert.equal(preflight.status, 204);
  assert.equal(await preflight.text(), '');
  assert.equal(preflight.headers.get('access-control-allow-origin'), origin);
  assert.match(preflight.headers.get('access-control-allow-methods'), /POST/);
  assert.match(preflight.headers.get('access-control-allow-headers'), /Content-Type/i);
  for (const path of ['/api/sites', '/api/missing']) {
    const response = await fetch(`${baseUrl}${path}`, { headers: { Origin: origin } });
    assert.equal(response.headers.get('access-control-allow-origin'), origin);
    assert.equal(response.headers.get('vary'), 'Origin');
  }
  const post = await fetch(`${baseUrl}/api/sites`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', cookie }, body: JSON.stringify({ code: 'CORS-01', name: 'Example' }) });
  assert.equal(post.status, 201);
  assert.equal(post.headers.get('access-control-allow-origin'), origin);
  for (const method of ['GET', 'OPTIONS']) {
    const response = await fetch(`${baseUrl}/api/sites`, { method, headers: { Origin: 'https://other.example' } });
    assert.equal(response.headers.get('access-control-allow-origin'), null);
  }
});

test('client defaults to the public API and preserves network and response errors', async () => {
  let requested;
  await createApi({ fetchImpl: async (url, options) => { requested = { url, options }; return new Response('[]'); } }).listSites();
  assert.equal(requested.url, `${DEFAULT_BASE_URL}/api/sites`);
  assert.deepEqual(requested.options, { credentials: 'include' });
  await assert.rejects(createApi({ fetchImpl: async () => { throw new TypeError('Failed to fetch'); } }).listSites(), error => error.code === 'NETWORK_ERROR' && error.message === 'apiUnavailable');
  await assert.rejects(createApi({ fetchImpl: async () => new Response('<html>Unavailable</html>', { status: 502 }) }).listSites(), error => error.code === 'INVALID_RESPONSE' && error.status === 502);
  await assert.rejects(createApi({ fetchImpl: async () => Response.json({ error: 'Conflict', code: 'INVALID_TRANSITION' }, { status: 409 }) }).getTask('example'), error => error.code === 'INVALID_TRANSITION' && error.status === 409);
});

test('auth client uses credentialed requests and retains 401/403/429 machine codes', async t => {
  const calls = [];
  const api = createApi({ baseUrl: '/', fetchImpl: async (url, options) => {
    calls.push({ url, options }); return Response.json({ user: { id: 'synthetic' }, roles: [] });
  } });
  await api.login({ email: 'owner@example.invalid', password: 'Synthetic password' });
  await api.me(); await api.logout();
  t.assert.deepStrictEqual(calls.map(call => call.url), ['/api/auth/login', '/api/auth/me', '/api/auth/logout']);
  for (const call of calls) t.assert.strictEqual(call.options.credentials, 'include');
  t.assert.strictEqual(calls[0].options.method, 'POST');
  t.assert.strictEqual(calls[2].options.method, 'POST');
  for (const [status, code] of [[401, 'AUTH_REQUIRED'], [403, 'FORBIDDEN'], [429, 'RATE_LIMITED']]) {
    let expired = false;
    const client = createApi({ onUnauthorized: () => { expired = true; }, fetchImpl: async () => Response.json({ code, error: 'Synthetic error' }, { status }) });
    await t.assert.rejects(() => client.me(), error => error.status === status && error.code === code);
    t.assert.strictEqual(expired, status === 401);
  }
});
