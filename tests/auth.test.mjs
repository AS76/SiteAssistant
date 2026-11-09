import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { openTestDb } from './helpers/db.mjs';
import { authFixture, requestListener } from './helpers/auth.mjs';
import { createServer } from '../server/http.mjs';
import { createSite, createTask, getTask } from '../server/repository.mjs';
import { createLoginLimiter, hashPassword, verifyPassword, SESSION_TTL, tokenHash } from '../server/auth.mjs';
import { seed } from '../server/seed.mjs';

async function fixture(t, options) {
  const database = await openTestDb(); t.after(database.close);
  const { db } = database;
  const site = await createSite(db, { code: 'AUTH', name: 'Synthetic auth site' });
  const auth = await authFixture(db, site);
  const request = requestListener(createServer(db, options));
  const as = (role, path, body, headers) => request(path, {
    method: body === undefined ? 'GET' : 'POST', body, headers, cookie: auth.cookies[role],
  });
  const task = await createTask(db, { siteId: site.id, title: 'Synthetic task', executor: auth.users.editor.name,
    verifier: auth.users.verifier.name, executor_id: auth.users.editor.id, verifier_id: auth.users.verifier.id });
  return { db, site, task, request, as, ...auth };
}

test('scrypt uses salted versioned hashes and rejects wrong passwords and unknown formats', async t => {
  const first = await hashPassword('Synthetic password'), second = await hashPassword('Synthetic password');
  t.assert.match(first, /^scrypt\$16384\$8\$1\$[a-f0-9]{32}\$[a-f0-9]{128}$/);
  t.assert.notStrictEqual(first, second);
  t.assert.strictEqual(await verifyPassword('Synthetic password', first), true);
  t.assert.strictEqual(await verifyPassword('Wrong', first), false);
  t.assert.strictEqual(await verifyPassword('Synthetic password', 'invalid'), false);
});

test('login normalizes email, emits HttpOnly cookie, persists only token hash and exposes safe me', async t => {
  const { db, request, users, site } = await fixture(t, { production: true });
  const result = await request('/api/auth/login', { method: 'POST', body: { email: ' OWNER@EXAMPLE.INVALID ', password: 'Synthetic-test-password!' }, headers: { 'user-agent': 'Synthetic agent' } });
  t.assert.strictEqual(result.status, 200);
  const cookie = result.headers['set-cookie'];
  t.assert.match(cookie, /^sa_session=[A-Za-z0-9_-]{43}; Path=\/api; HttpOnly; SameSite=Lax; Max-Age=604800; Secure$/);
  const token = cookie.split(';')[0].split('=')[1];
  const stored = await db.get('SELECT * FROM sessions WHERE token_hash = ?', tokenHash(token));
  t.assert.strictEqual(stored.token_hash.length, 64);
  t.assert.strictEqual(Date.parse(stored.expires_at) - Date.parse(stored.created_at), SESSION_TTL);
  t.assert.strictEqual(stored.user_agent, 'Synthetic agent');
  t.assert.strictEqual(stored.ip, '127.0.0.1');
  t.assert.doesNotMatch(JSON.stringify(stored), new RegExp(token));
  const me = await request('/api/auth/me', { cookie: cookie.split(';')[0] });
  t.assert.deepStrictEqual(me.body, { user: users.owner, roles: [{ site_id: site.id, role: 'owner' }] });
  t.assert.doesNotMatch(JSON.stringify(result.body), /password|token|session_id/);
  for (const email of ['owner@example.invalid', 'missing@example.invalid']) {
    const failed = await request('/api/auth/login', { method: 'POST', body: { email, password: 'Wrong' } });
    t.assert.strictEqual(failed.status, 401); t.assert.strictEqual(failed.body.code, 'INVALID_CREDENTIALS');
    t.assert.strictEqual(failed.headers['set-cookie'], undefined);
  }
});

test('public health, protected routes, expiry, disabled users and revocation', async t => {
  const { db, request, as, cookies, users } = await fixture(t);
  t.assert.deepStrictEqual((await request('/api/health')).body, { status: 'ok' });
  for (const path of ['/api/sites', '/api/tasks', '/api/diary', '/api/auth/me', '/api/missing', '/api/auth/logout']) {
    const result = await request(path); t.assert.strictEqual(result.status, 401); t.assert.strictEqual(result.body.code, 'AUTH_REQUIRED');
  }
  t.assert.strictEqual((await request('/api/sites', { cookie: 'sa_session=invalid' })).status, 401);
  t.assert.strictEqual((await request('/api/sites', { cookie: `${cookies.owner}; ${cookies.owner}` })).status, 401);
  await db.run('UPDATE sessions SET expires_at = ? WHERE user_id = ?', new Date().toISOString(), users.viewer.id);
  t.assert.strictEqual((await as('viewer', '/api/auth/me')).status, 401);
  await db.run('UPDATE users SET disabled_at = ? WHERE id = ?', new Date().toISOString(), users.editor.id);
  t.assert.strictEqual((await as('editor', '/api/auth/me')).status, 401);
  t.assert.strictEqual((await request('/api/auth/login', { method: 'POST', body: { email: users.editor.email, password: 'Synthetic-test-password!' } })).status, 401);
  const logout = await as('owner', '/api/auth/logout', {});
  t.assert.strictEqual(logout.status, 200); t.assert.match(logout.headers['set-cookie'], /Max-Age=0/);
  t.assert.ok((await db.get('SELECT revoked_at FROM sessions WHERE user_id = ?', users.owner.id)).revoked_at);
  t.assert.strictEqual((await as('owner', '/api/auth/me')).status, 401);
});

test('login limiter counts ten attempts, isolates IP/email and slides its window', async t => {
  let now = 0;
  const limiter = createLoginLimiter({ now: () => now });
  const { request } = await fixture(t, { limiter });
  const attempt = (email = 'missing@example.invalid', ip = '127.0.0.1') => request('/api/auth/login', {
    method: 'POST', ip, body: { email, password: 'Wrong' },
  });
  for (let n = 0; n < 10; n++) { t.assert.strictEqual((await attempt()).status, 401); now += 1000; }
  const limited = await attempt(' MISSING@EXAMPLE.INVALID ');
  t.assert.strictEqual(limited.status, 429); t.assert.strictEqual(limited.body.code, 'RATE_LIMITED');
  t.assert.strictEqual(limited.headers['retry-after'], '890');
  t.assert.strictEqual((await attempt('another@example.invalid')).status, 401);
  t.assert.strictEqual((await attempt('missing@example.invalid', '127.0.0.2')).status, 401);
  now = 900000;
  t.assert.strictEqual((await attempt()).status, 401);
  t.assert.strictEqual((await attempt()).status, 429);
  limiter.reset(); t.assert.strictEqual((await attempt()).status, 401);
});

test('site isolation covers lists, details, diary, creation and idempotency replay', async t => {
  const { db, site, task, as, users } = await fixture(t);
  const other = await createSite(db, { code: 'OTHER', name: 'Other synthetic site' });
  const hidden = await createTask(db, { siteId: other.id, title: 'Hidden task', executor: 'A', verifier: 'B' });
  t.assert.deepStrictEqual((await as('viewer', '/api/sites')).body.map(row => row.id), [site.id]);
  t.assert.deepStrictEqual((await as('viewer', '/api/tasks')).body.map(row => row.id), [task.id]);
  for (const path of [`/api/sites/${other.id}`, `/api/tasks/${hidden.id}`, `/api/tasks?siteId=${other.id}`, `/api/diary?siteId=${other.id}`]) {
    t.assert.strictEqual((await as('owner', path)).status, 403);
  }
  const input = { siteId: site.id, title: 'New task', executor: 'A', verifier: 'B', actor: 'forged' };
  for (const [path, body] of [['/api/tasks', input], ['/api/diary', { siteId: site.id, shift: 'day' }], ['/api/sites', { code: 'NEW', name: 'New' }]]) {
    t.assert.strictEqual((await as('viewer', path, body)).status, 403);
  }
  const headers = { 'idempotency-key': 'shared-example-key' };
  t.assert.strictEqual((await as('editor', '/api/tasks', input, headers)).status, 201);
  t.assert.strictEqual((await as('verifier', '/api/tasks', input, headers)).status, 409);
  await db.run('DELETE FROM site_members WHERE site_id = ? AND user_id = ?', site.id, users.editor.id);
  t.assert.strictEqual((await as('editor', '/api/tasks', input, headers)).status, 403);
  t.assert.strictEqual((await as('owner', '/api/diary', { siteId: site.id, shift: 'day' })).status, 201);
  t.assert.deepStrictEqual((await as('editor', '/api/diary')).body, []);
});

test('session identity controls actions and self-review even with forged actors and changed names', async t => {
  const { db, task, as, users } = await fixture(t);
  const path = `/api/tasks/${task.id}/transition`;
  const move = (role, to, extra = {}) => as(role, path, { to, actor: 'forged owner', note: 'Synthetic evidence', reason: 'Synthetic reason', ...extra });
  t.assert.strictEqual((await move('viewer', 'in_progress')).status, 403);
  t.assert.strictEqual((await move('editor', 'in_progress')).body.events.at(-1).actor, users.editor.name);
  const submitted = await move('editor', 'to_verify');
  t.assert.strictEqual(submitted.body.submitted_by_id, users.editor.id);
  t.assert.strictEqual(submitted.body.submitted_by, users.editor.name);
  for (const to of ['closed', 'in_progress']) t.assert.strictEqual((await move('editor', to)).status, 403);
  await db.run("UPDATE site_members SET role = 'verifier' WHERE user_id = ?", users.editor.id);
  await db.run("UPDATE users SET name = 'Renamed synthetic user' WHERE id = ?", users.editor.id);
  for (const to of ['closed', 'in_progress']) {
    const before = await getTask(db, task.id);
    const result = await move('editor', to);
    t.assert.strictEqual(result.status, 409); t.assert.strictEqual(result.body.code, 'INVALID_TRANSITION');
    t.assert.deepStrictEqual(await getTask(db, task.id), before);
  }
  const rejected = await move('verifier', 'in_progress');
  t.assert.strictEqual(rejected.body.events.at(-1).action, 'reject');
  await move('editor', 'to_verify');
  await move('owner', 'blocked');
  t.assert.strictEqual((await move('owner', 'to_verify')).body.submitted_by_id, users.editor.id);
  t.assert.strictEqual((await move('owner', 'closed')).body.events.at(-1).action, 'verify');
  await db.run("UPDATE site_members SET role = 'editor' WHERE user_id = ?", users.editor.id);
  t.assert.strictEqual((await move('editor', 'in_progress')).body.events.at(-1).action, 'reopen');
});

test('legacy submitter fallback prevents self-review and missing identity returns explicit 400', async t => {
  const { db, task, as, users } = await fixture(t);
  await db.run("UPDATE tasks SET status = 'to_verify', submitted_by = ? WHERE id = ?", users.verifier.name, task.id);
  const path = `/api/tasks/${task.id}/transition`;
  for (const to of ['in_progress', 'closed']) {
    t.assert.strictEqual((await as('verifier', path, { to, actor: 'Other', note: 'Evidence' })).status, 409);
  }
  await db.run('UPDATE tasks SET submitted_by = NULL WHERE id = ?', task.id);
  const result = await as('verifier', path, { to: 'in_progress', note: 'Evidence' });
  t.assert.strictEqual(result.status, 400); t.assert.strictEqual(result.body.code, 'SUBMITTER_REQUIRED');
});

test('owners manage members, assignments validate site roles and constraints reject invalid references', async t => {
  const { db, site, task, as, users } = await fixture(t);
  const path = `/api/sites/${site.id}/members`;
  for (const role of ['viewer', 'editor', 'verifier']) {
    t.assert.strictEqual((await as(role, path)).status, 403);
    t.assert.strictEqual((await as(role, path, { user_id: users.viewer.id, role: 'owner' })).status, 403);
  }
  t.assert.strictEqual((await as('owner', path)).body.length, 4);
  t.assert.strictEqual((await as('owner', path, { user_id: users.viewer.id, role: 'editor' })).status, 200);
  t.assert.strictEqual((await as('viewer', '/api/auth/me')).body.roles[0].role, 'editor');
  t.assert.strictEqual((await as('owner', path, { user_id: users.viewer.id, role: null })).status, 200);
  t.assert.strictEqual((await as('viewer', `/api/tasks/${task.id}`)).status, 403);
  t.assert.strictEqual((await as('owner', path, { user_id: users.owner.id.toUpperCase(), role: null })).status, 400);
  t.assert.strictEqual((await as('owner', path, { user_id: 'invalid', role: 'viewer' })).status, 400);
  const input = { siteId: site.id, title: 'New', executor: 'A', verifier: 'B' };
  for (const extra of [{ executor_id: 'invalid' }, { verifier_id: users.editor.id }, { executor_id: users.viewer.id }, { executor_id: users.verifier.id, verifier_id: users.verifier.id.toUpperCase() }]) {
    t.assert.strictEqual((await as('owner', '/api/tasks', { ...input, ...extra })).status, 400);
  }
  const created = await as('owner', '/api/sites', { code: 'NEW', name: 'Synthetic new site' });
  t.assert.strictEqual(created.status, 201);
  t.assert.strictEqual((await as('owner', `/api/sites/${created.body.id}/members`)).body[0].role, 'owner');
  await t.assert.rejects(() => db.run('UPDATE users SET email = ? WHERE id = ?', users.owner.email.toUpperCase(), users.editor.id));
  for (const column of ['executor_id', 'verifier_id', 'submitted_by_id']) {
    await t.assert.rejects(() => db.run(`UPDATE tasks SET ${column} = ? WHERE id = ?`, randomUUID(), task.id), /foreign key/i);
  }
});

test('CORS credentials use the existing exact origin and preflight needs no session', async t => {
  const { request } = await fixture(t);
  const origin = 'https://siteassistant.asassi.cloud';
  const result = await request('/api/tasks', { method: 'OPTIONS', headers: { origin } });
  t.assert.strictEqual(result.status, 204);
  t.assert.strictEqual(result.headers['access-control-allow-credentials'], 'true');
  t.assert.strictEqual(result.headers['access-control-allow-origin'], origin);
  for (const header of ['Authorization', 'Cookie', 'Idempotency-Key']) t.assert.ok(result.headers['access-control-allow-headers'].includes(header));
  const denied = await request('/api/tasks', { headers: { origin: 'https://other.example' } });
  t.assert.strictEqual(denied.headers['access-control-allow-origin'], undefined);
  t.assert.strictEqual(denied.status, 401);
});

test('seed is guarded, repeatable and explicit reset preserves migration ledger', async t => {
  const database = await openTestDb(); t.after(database.close); const { db } = database;
  const ledger = await db.all('SELECT * FROM schema_migrations ORDER BY version');
  await t.assert.rejects(() => seed(db, { environment: 'production', reset: true }));
  t.assert.strictEqual(await seed(db), true);
  const before = await db.all('SELECT * FROM users ORDER BY id');
  t.assert.strictEqual(before.length, 4);
  t.assert.strictEqual(await seed(db), false);
  t.assert.deepStrictEqual(await db.all('SELECT * FROM users ORDER BY id'), before);
  const request = requestListener(createServer(db));
  for (const role of ['owner', 'editor', 'verifier', 'viewer']) {
    const result = await request('/api/auth/login', { method: 'POST', body: { email: `${role}@example.invalid`, password: `Local-${role}-5b!` } });
    t.assert.strictEqual(result.status, 200);
  }
  t.assert.strictEqual(await seed(db, { reset: true }), true);
  t.assert.strictEqual((await db.all('SELECT * FROM tasks')).length, 4);
  t.assert.strictEqual((await db.all('SELECT * FROM site_members')).length, 8);
  t.assert.deepStrictEqual(await db.all('SELECT * FROM sessions'), []);
  t.assert.deepStrictEqual(await db.all('SELECT * FROM schema_migrations ORDER BY version'), ledger);
});
