import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { openTestDb } from './helpers/db.mjs';
import { authFixture, requestListener } from './helpers/auth.mjs';
import { createServer } from '../server/http.mjs';
import { createSite } from '../server/repository.mjs';
import { createRateLimiter } from '../server/limits.mjs';

async function fixture(t, options = {}) {
  const database = await openTestDb();
  t.after(database.close);
  const { db } = database;
  const site = await createSite(db, { code: 'BYPASS', name: 'Synthetic bypass site' });
  const auth = await authFixture(db, site);
  const warnings = t.mock.method(console, 'warn', () => {});
  const request = requestListener(createServer(db, { authBypassUser: auth.users.viewer.email, ...options }));
  return { db, site, request, warnings, ...auth };
}

test('configured bypass authenticates without a cookie using the chosen profile', async t => {
  const { db, site, request, warnings } = await fixture(t, { authBypassUser: ' VIEWER@EXAMPLE.INVALID ' });
  const sessionsBefore = await db.all('SELECT * FROM sessions ORDER BY id');
  const result = await request('/api/sites');
  t.assert.strictEqual(result.status, 200);
  t.assert.deepStrictEqual(result.body.map(row => row.id), [site.id]);
  t.assert.strictEqual(result.headers['set-cookie'], undefined);
  t.assert.deepStrictEqual(await db.all('SELECT * FROM sessions ORDER BY id'), sessionsBefore);
  t.assert.strictEqual(warnings.mock.callCount(), 1);
});

test('absent, empty and whitespace environment values retain AUTH_REQUIRED', async t => {
  const previous = process.env.AUTH_BYPASS_USER;
  t.after(() => {
    if (previous === undefined) delete process.env.AUTH_BYPASS_USER;
    else process.env.AUTH_BYPASS_USER = previous;
  });
  const { db, warnings } = await fixture(t, { authBypassUser: '' });
  for (const value of [undefined, '', '   ']) {
    if (value === undefined) delete process.env.AUTH_BYPASS_USER;
    else process.env.AUTH_BYPASS_USER = value;
    const request = requestListener(createServer(db));
    const result = await request('/api/sites');
    t.assert.strictEqual(result.status, 401);
    t.assert.deepStrictEqual(result.body, { error: 'A valid session is required.', code: 'AUTH_REQUIRED' });
    t.assert.deepStrictEqual((await request('/api/health')).body, { status: 'ok', auth_bypass: false });
  }
  t.assert.strictEqual(warnings.mock.callCount(), 0);
});

test('server reads AUTH_BYPASS_USER from the environment at creation', async t => {
  const { db, users } = await fixture(t, { authBypassUser: '' });
  const previous = process.env.AUTH_BYPASS_USER;
  let request;
  try {
    process.env.AUTH_BYPASS_USER = users.viewer.email;
    request = requestListener(createServer(db));
  } finally {
    if (previous === undefined) delete process.env.AUTH_BYPASS_USER;
    else process.env.AUTH_BYPASS_USER = previous;
  }
  t.assert.strictEqual((await request('/api/sites')).status, 200);
  t.assert.deepStrictEqual((await request('/api/health')).body, { status: 'ok', auth_bypass: true });
});

test('unknown configured email fails closed while health reports configuration', async t => {
  const { request, warnings } = await fixture(t, { authBypassUser: 'missing@example.invalid' });
  const result = await request('/api/sites');
  t.assert.strictEqual(result.status, 401);
  t.assert.strictEqual(result.body.code, 'AUTH_REQUIRED');
  t.assert.deepStrictEqual((await request('/api/health')).body, { status: 'ok', auth_bypass: true });
  t.assert.strictEqual(warnings.mock.callCount(), 0);
});

test('disabling the chosen user takes effect on the next bypass request', async t => {
  const { db, request, users, warnings } = await fixture(t);
  t.assert.strictEqual((await request('/api/sites')).status, 200);
  await db.run('UPDATE users SET disabled_at = ? WHERE id = ?', new Date().toISOString(), users.viewer.id);
  const result = await request('/api/sites');
  t.assert.strictEqual(result.status, 401);
  t.assert.strictEqual(result.body.code, 'AUTH_REQUIRED');
  t.assert.deepStrictEqual((await request('/api/health')).body, { status: 'ok', auth_bypass: true });
  t.assert.strictEqual(warnings.mock.callCount(), 1);
});

test('bypass preserves role, site membership and module restrictions', async t => {
  const { db, request, users, site } = await fixture(t);
  const input = { siteId: site.id, title: 'Synthetic task', executor: 'Example', verifier: 'Example' };
  t.assert.strictEqual((await request('/api/tasks', { method: 'POST', body: input })).status, 403);
  const other = await createSite(db, { code: 'HIDDEN', name: 'Other synthetic site' });
  t.assert.strictEqual((await request(`/api/sites/${other.id}`)).status, 403);
  t.assert.strictEqual((await request(`/api/tasks?siteId=${site.id}`)).status, 200);
  await db.run(`INSERT INTO member_module_access (id, site_id, user_id, module, allowed, created_at, updated_at)
    VALUES (?, ?, ?, 'tasks', FALSE, ?, ?)`, randomUUID(), site.id, users.viewer.id,
  new Date().toISOString(), new Date().toISOString());
  t.assert.strictEqual((await request(`/api/tasks?siteId=${site.id}`)).status, 403);
  await db.run('DELETE FROM site_members WHERE site_id = ? AND user_id = ?', site.id, users.viewer.id);
  t.assert.deepStrictEqual((await request('/api/sites')).body, []);
});

test('valid sessions take precedence over the configured bypass profile', async t => {
  const { request, cookies, warnings, site } = await fixture(t, { authBypassUser: 'owner@example.invalid' });
  const result = await request('/api/tasks', { method: 'POST', cookie: cookies.viewer,
    body: { siteId: site.id, title: 'Synthetic task' } });
  t.assert.strictEqual(result.status, 403);
  t.assert.strictEqual(warnings.mock.callCount(), 0);
});

test('invalid, expired and revoked sessions fall back to bypass', async t => {
  const { db, request, cookies, users } = await fixture(t);
  t.assert.strictEqual((await request('/api/sites', { cookie: 'sa_session=invalid' })).status, 200);
  await db.run('UPDATE sessions SET expires_at = ? WHERE user_id = ?', '2000-01-01T00:00:00.000Z', users.owner.id);
  t.assert.strictEqual((await request('/api/sites', { cookie: cookies.owner })).status, 200);
  await db.run('UPDATE sessions SET revoked_at = ? WHERE user_id = ?', new Date().toISOString(), users.editor.id);
  t.assert.strictEqual((await request('/api/sites', { cookie: cookies.editor })).status, 200);
});

test('excluded auth endpoints never use bypass and normal login and logout still work', async t => {
  const { request, users, warnings } = await fixture(t);
  for (const [path, method] of [
    ['/api/auth/logout', 'POST'], ['/api/auth/password', 'POST'],
  ]) {
    const result = await request(path, { method });
    t.assert.strictEqual(result.status, 401);
    t.assert.strictEqual(result.body.code, 'AUTH_REQUIRED');
  }
  for (const path of ['/api/auth/forgot', '/api/auth/request']) {
    const result = await request(path, { method: 'POST', body: {} });
    t.assert.strictEqual(result.status, 400);
    t.assert.strictEqual(result.body.code, 'VALIDATION_ERROR');
  }
  t.assert.strictEqual((await request('/api/auth/request/decide')).status, 410);
  const invalid = await request('/api/auth/login', { method: 'POST',
    body: { email: users.viewer.email, password: 'Wrong' } });
  t.assert.strictEqual(invalid.status, 401);
  t.assert.strictEqual(invalid.body.code, 'INVALID_CREDENTIALS');
  const loggedIn = await request('/api/auth/login', { method: 'POST',
    body: { email: users.viewer.email, password: 'Synthetic-test-password!' } });
  t.assert.strictEqual(loggedIn.status, 200);
  const cookie = loggedIn.headers['set-cookie'].split(';')[0];
  t.assert.deepStrictEqual((await request('/api/auth/me', { cookie })).body.user, users.viewer);
  t.assert.strictEqual((await request('/api/auth/logout', { method: 'POST', cookie })).status, 200);
  t.assert.strictEqual((await request('/api/auth/logout', { method: 'POST', cookie })).status, 401);
  t.assert.strictEqual(warnings.mock.callCount(), 0);
});

test('auth me uses bypass without a valid session and other auth paths are not excluded', async t => {
  const { request, users, cookies, site } = await fixture(t);
  for (const cookie of [undefined, 'sa_session=invalid']) {
    const result = await request('/api/auth/me', { cookie });
    t.assert.strictEqual(result.status, 200);
    t.assert.deepStrictEqual(result.body, {
      user: users.viewer, roles: [{ site_id: site.id, role: 'viewer' }], password_change_required: false,
    });
    t.assert.strictEqual(result.headers['set-cookie'], undefined);
  }
  t.assert.deepStrictEqual((await request('/api/auth/me', { cookie: cookies.owner })).body.user, users.owner);
  const unknown = await request('/api/auth/unknown');
  t.assert.strictEqual(unknown.status, 404);
  t.assert.strictEqual(unknown.body.code, 'NOT_FOUND');
});

test('bypass uses the user rate limiter rather than the anonymous limiter', async t => {
  const { request } = await fixture(t, {
    userLimiter: createRateLimiter({ max: 2 }), anonLimiter: createRateLimiter({ max: 1 }),
  });
  t.assert.strictEqual((await request('/api/sites')).status, 200);
  t.assert.strictEqual((await request('/api/sites')).status, 200);
  t.assert.strictEqual((await request('/api/sites')).status, 429);
});

test('bypass warnings count every request and log at most once per minute without query data', async t => {
  const { request, warnings, cookies, site } = await fixture(t);
  let now = 0;
  t.mock.method(Date, 'now', () => now);
  await request('/api/sites?private_query=synthetic');
  for (let i = 0; i < 105; i++) t.assert.strictEqual((await request('/api/sites')).status, 200);
  await request('/api/sites', { cookie: cookies.owner });
  await request('/api/auth/me');
  now = 59999;
  await request('/api/sites');
  t.assert.strictEqual(warnings.mock.callCount(), 1);
  now = 60000;
  // Authorization may deny an action after the request has authenticated via bypass.
  t.assert.strictEqual((await request(`/api/sites/${site.id}`, { method: 'PATCH', body: { name: 'Synthetic' } })).status, 403);
  t.assert.deepStrictEqual(warnings.mock.calls.map(call => JSON.parse(call.arguments[0])), [
    { event: 'AUTH_BYPASS', authentication: 'bypassed', method: 'GET', path: '/api/sites', count: 1 },
    { event: 'AUTH_BYPASS', authentication: 'bypassed', method: 'PATCH', path: `/api/sites/${site.id}`, count: 109 },
  ]);
});
