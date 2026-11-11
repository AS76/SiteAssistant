import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createRateLimiter } from '../server/limits.mjs';
import { readPagination } from '../server/pagination.mjs';
import { createServer } from '../server/http.mjs';
import { createSite, listTasks, listDiary } from '../server/repository.mjs';
import { listDeviations } from '../server/deviations.mjs';
import { listSiteProgress } from '../server/site-progress.mjs';
import { listTimeBookings } from '../server/time_bookings.mjs';
import { login, createLoginLimiter } from '../server/auth.mjs';
import { authFixture, requestListener } from './helpers/auth.mjs';
import { isPg, openTestDb, openSqliteTestDb } from './helpers/db.mjs';
import { wbsDatabase } from './helpers/wbs.mjs';

test('sliding limiter: remaining, per-key isolation, retry seconds, expiry and reset', t => {
  let at = 0;
  const limiter = createRateLimiter({ windowMs: 60000, max: 2, now: () => at });
  t.assert.deepStrictEqual(limiter.attempt('a'), { allowed: true, retryAfter: 0, remaining: 1 });
  at = 1500;
  t.assert.deepStrictEqual(limiter.attempt('a'), { allowed: true, retryAfter: 0, remaining: 0 });
  t.assert.deepStrictEqual(limiter.attempt('a'), { allowed: false, retryAfter: 59, remaining: 0 });
  t.assert.strictEqual(limiter.attempt('b').remaining, 1);
  at = 59999;
  t.assert.deepStrictEqual(limiter.attempt('a'), { allowed: false, retryAfter: 1, remaining: 0 });
  at = 60000;
  t.assert.deepStrictEqual(limiter.attempt('a'), { allowed: true, retryAfter: 0, remaining: 0 });
  // Refusals do not extend the window; the second accepted hit expires next.
  t.assert.deepStrictEqual(limiter.attempt('a'), { allowed: false, retryAfter: 2, remaining: 0 });
  at = 61500;
  t.assert.strictEqual(limiter.attempt('a').allowed, true);
  limiter.reset();
  t.assert.strictEqual(limiter.attempt('a').remaining, 1);
  at = 200000;
  t.assert.strictEqual(limiter.attempt('a').remaining, 1);
  t.assert.strictEqual(limiter.attempt('b').remaining, 1);
});

test('limiter rejects invalid configuration', t => {
  for (const max of [undefined, 0, -1, 1.5, NaN, Infinity, '2']) {
    t.assert.throws(() => createRateLimiter({ max }), TypeError);
  }
  for (const windowMs of [0, -1, 1.5, Infinity]) {
    t.assert.throws(() => createRateLimiter({ max: 1, windowMs }), TypeError);
  }
});

test('pagination parser: defaults, boundaries and invalid integer representations', t => {
  const read = query => readPagination(new URL(`http://example.invalid/${query}`));
  t.assert.deepStrictEqual(read(''), { limit: 50, offset: 0 });
  t.assert.deepStrictEqual(read('?limit=200&offset=12'), { limit: 200, offset: 12 });
  t.assert.deepStrictEqual(read('?limit=1&offset=0'), { limit: 1, offset: 0 });
  for (const query of ['limit=0', 'limit=201', 'offset=-1', 'limit=abc', 'limit=', 'offset=',
    'limit=1.5', 'offset=1.5', 'limit=1e2', 'limit=0x10', 'limit=%20', 'offset=Infinity',
    'offset=9007199254740992']) {
    t.assert.throws(() => read(`?${query}`), { status: 400, code: 'VALIDATION_ERROR' });
  }
});

test('HTTP limiter: anonymous bursts, authenticated user buckets, expiry and auth exemptions', async t => {
  const database = await openSqliteTestDb(); t.after(database.close);
  const { db } = database;
  const site = await createSite(db, { code: 'LIMIT', name: 'Synthetic limit site' });
  const auth = await authFixture(db, site);
  let at = 0;
  const keys = [];
  const tracked = max => {
    const limiter = createRateLimiter({ max, now: () => at });
    return { attempt(key) { keys.push(key); return limiter.attempt(key); } };
  };
  const api = requestListener(createServer(db, { anonLimiter: tracked(2), userLimiter: tracked(2) }));
  const request = (path = '/api/health', options) => api(path, options);
  t.assert.strictEqual((await request()).headers['x-ratelimit-remaining'], '1');
  // A rejected protected request also consumes the anonymous bucket.
  t.assert.strictEqual((await request('/api/tasks')).status, 401);
  at = 1001;
  const refused = await request();
  t.assert.strictEqual(refused.status, 429);
  t.assert.deepStrictEqual(refused.body, { error: 'Too many requests.', code: 'RATE_LIMITED' });
  t.assert.strictEqual(refused.headers['retry-after'], '59');
  t.assert.strictEqual(refused.headers['x-ratelimit-remaining'], '0');
  t.assert.strictEqual((await request('/api/tasks', { headers: { 'x-forwarded-for': '192.0.2.1' } })).status, 429);
  t.assert.strictEqual((await request('/api/tasks', { cookie: 'sa_session=invalid' })).status, 429);
  t.assert.strictEqual((await request('/api/health', { ip: '192.0.2.2' })).status, 200);
  t.assert.strictEqual((await request('/outside-api')).status, 404);

  const as = (role, path = '/api/auth/me', options = {}) => request(path, { cookie: auth.cookies[role], ...options });
  t.assert.strictEqual((await as('owner')).headers['x-ratelimit-remaining'], '1');
  const secondSession = await login(db, { email: auth.users.owner.email, password: 'Synthetic-test-password!' },
    { limiter: createLoginLimiter() });
  t.assert.strictEqual((await request('/api/auth/me', { cookie: `sa_session=${secondSession.token}`, ip: '192.0.2.3' })).status, 200);
  t.assert.strictEqual((await as('owner')).status, 429);
  t.assert.strictEqual((await as('viewer')).status, 200);
  t.assert.ok(keys.includes(`user:${auth.users.owner.id}`));
  t.assert.ok(keys.includes('ip:127.0.0.1'));

  // All four routes reach their own validation/limiter even when general buckets are full.
  for (const path of ['/api/auth/login', '/api/auth/forgot', '/api/auth/request', '/api/auth/password']) {
    const before = keys.length;
    const result = await as('owner', path, { method: 'POST', body: {} });
    t.assert.strictEqual(result.status, 400, path);
    t.assert.strictEqual(result.headers['x-ratelimit-remaining'], undefined);
    t.assert.strictEqual(keys.length, before);
  }
  const loggedIn = await request('/api/auth/login', { method: 'POST', body: {
    email: auth.users.editor.email, password: 'Synthetic-test-password!',
  } });
  t.assert.strictEqual(loggedIn.status, 200);
  t.assert.ok(loggedIn.headers['set-cookie']);
  // The exemption is exact: the public signup decision route still has the general limiter.
  t.assert.strictEqual((await request('/api/auth/request/decide?token=invalid')).status, 429);
  at = 61001;
  t.assert.strictEqual((await request()).status, 200);
  t.assert.strictEqual((await as('owner')).status, 200);
});

test('HTTP limiter reads environment limits once when creating the server', async t => {
  const names = ['RATE_LIMIT_USER_PER_MIN', 'RATE_LIMIT_ANON_PER_MIN'];
  const previous = names.map(name => process.env[name]);
  let api;
  try {
    for (const name of names) process.env[name] = '1';
    api = requestListener(createServer({ get: async () => ({ id: 'synthetic-user' }) }));
  } finally {
    for (const [index, name] of names.entries()) {
      if (previous[index] === undefined) delete process.env[name];
      else process.env[name] = previous[index];
    }
  }
  t.assert.strictEqual((await api('/api/health')).status, 200);
  t.assert.strictEqual((await api('/api/health')).status, 429);
  const cookie = `sa_session=${'a'.repeat(43)}`;
  t.assert.strictEqual((await api('/api/health', { cookie })).status, 200);
  t.assert.strictEqual((await api('/api/health', { cookie })).status, 429);
});

for (const driver of ['sqlite', 'pg']) test(`Pagination ${driver}: five lists, filtered totals and unchanged arrays`, async t => {
  let db;
  if (driver === 'pg' && !isPg) db = await wbsDatabase(t, driver);
  else {
    const database = await (driver === 'sqlite' ? openSqliteTestDb() : openTestDb());
    db = database.db; t.after(database.close);
  }
  const site = await createSite(db, { code: 'PAGE', name: 'Synthetic pagination site' });
  const other = await createSite(db, { code: 'OTHER', name: 'Other synthetic pagination site' });
  const hidden = await createSite(db, { code: 'HIDDEN', name: 'Hidden synthetic pagination site' });
  const auth = await authFixture(db, site);
  await db.run("INSERT INTO site_members VALUES (?, ?, 'viewer')", other.id, auth.users.viewer.id);
  const api = requestListener(createServer(db));
  const as = path => api(path, { cookie: auth.cookies.viewer });
  const at = '2026-01-01T08:00:00.000Z';
  const wbsId = randomUUID(), workDayId = randomUUID();
  await db.run(`INSERT INTO project_structure (id, site_id, wbs_code, level, created_at)
    VALUES (?, ?, 'SYN', 0, ?)`, wbsId, site.id, at);
  await db.run(`INSERT INTO work_days (id, site_id, operational_date, created_at)
    VALUES (?, ?, '2026-01-01', ?)`, workDayId, site.id, at);
  let firstItem;
  for (const [currentSite, size] of [[site, 64], [other, 3], [hidden, 2]]) {
    for (let index = 0; index < size; index++) {
      const item = randomUUID(), date = new Date(Date.UTC(2026, 0, index + 1)).toISOString().slice(0, 10);
      const selected = currentSite.id === site.id && index < 60;
      if (currentSite.id === site.id && index === 0) firstItem = item;
      await db.run(`INSERT INTO tasks (id, site_id, title, executor, verifier, status, created_at)
        VALUES (?, ?, 'Synthetic task', 'Synthetic executor', 'Synthetic verifier', ?, ?)`,
      randomUUID(), currentSite.id, selected ? 'todo' : 'closed', at);
      await db.run(`INSERT INTO diary (id, site_id, operational_date, shift, created_at)
        VALUES (?, ?, ?, 'day', ?)`, randomUUID(), currentSite.id, date, at);
      await db.run(`INSERT INTO deviations (id, site_id, deviation_no, status, priority, creation_date, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`, randomUUID(), currentSite.id, `SYN-${index}`,
      selected ? 'open' : 'closed', index < 55 ? 'high' : 'low', index % 2 ? date : null, at);
      await db.run(`INSERT INTO site_progress_items (id, site_id, wbs_id, source_row, created_at)
        VALUES (?, ?, ?, ?, ?)`, item, currentSite.id, selected ? wbsId : null, index + 2, at);
      // A cross-site work day is deliberately avoided, even in synthetic fixtures.
      let day = workDayId;
      if (!selected) {
        day = randomUUID();
        await db.run(`INSERT INTO work_days (id, site_id, operational_date, created_at)
          VALUES (?, ?, ?, ?)`, day, currentSite.id, date, at);
      }
      await db.run(`INSERT INTO time_bookings (id, site_id, work_day_id, site_progress_item_id, hours, created_at)
        VALUES (?, ?, ?, ?, 1.25, ?)`, randomUUID(), currentSite.id, day, item, at);
    }
  }

  const lists = [
    { name: 'tasks', list: listTasks, filters: { status: 'todo' }, query: '&status=todo', total: 60 },
    { name: 'deviations', list: listDeviations, filters: { status: 'open', priority: 'high' }, query: '&status=open&priority=high', total: 55 },
    { name: 'site-progress', list: listSiteProgress, filters: { wbsId }, query: `&wbs_id=${wbsId}`, total: 60 },
    { name: 'time-bookings', list: listTimeBookings, filters: { workDayId }, query: `&work_day_id=${workDayId}`, total: 60 },
    { name: 'diary', list: listDiary, filters: {}, query: '', total: 64 },
  ];
  const page = (result, expected, total, limit, offset) => {
    t.assert.strictEqual(result.status, 200, JSON.stringify(result.body));
    t.assert.ok(Array.isArray(result.body));
    t.assert.deepStrictEqual(result.body, JSON.parse(JSON.stringify(expected)));
    t.assert.strictEqual(result.headers['x-total-count'], String(total));
    t.assert.strictEqual(result.headers['x-limit'], String(limit));
    t.assert.strictEqual(result.headers['x-offset'], String(offset));
  };
  for (const spec of lists) await t.test(spec.name, async t => {
    const base = `/api/${spec.name}?site_id=${site.id}`;
    const all = await spec.list(db, { siteId: site.id, limit: 200, offset: 0 }, auth.users.viewer);
    t.assert.strictEqual(all.length, 64);
    page(await as(base), all.slice(0, 50), 64, 50, 0);
    page(await as(`${base}&limit=7&offset=49`), all.slice(49, 56), 64, 7, 49);
    page(await as(`${base}&limit=200`), all, 64, 200, 0);
    page(await as(`${base}&offset=1000`), [], 64, 50, 1000);
    const filtered = await spec.list(db, { siteId: site.id, ...spec.filters, limit: 200 }, auth.users.viewer);
    t.assert.strictEqual(filtered.length, spec.total);
    page(await as(`${base}${spec.query}&limit=3&offset=2`), filtered.slice(2, 5), spec.total, 3, 2);
    const empty = await as(`/api/${spec.name}?site_id=${other.id}&offset=10`);
    page(empty, [], 3, 50, 10);
    for (const query of ['limit=0', 'limit=201', 'offset=-1', 'limit=abc']) await t.test(query, async t => {
      const result = await as(`${base}&${query}`);
      t.assert.strictEqual(result.status, 400);
      t.assert.strictEqual(result.body.code, 'VALIDATION_ERROR');
    });
    t.assert.strictEqual((await as(`/api/${spec.name}?site_id=${hidden.id}`)).status, 403);
    t.assert.strictEqual((await api(base)).status, 401);
  });
  for (const name of ['tasks', 'diary']) {
    const result = await as(`/api/${name}?limit=200`);
    t.assert.strictEqual(result.body.length, 67);
    t.assert.strictEqual(result.headers['x-total-count'], '67');
    t.assert.ok(result.body.every(row => row.site_id !== hidden.id));
    t.assert.deepStrictEqual((await as(`/api/${name}?siteId=${site.id}&limit=1`)).body,
      (await as(`/api/${name}?site_id=${site.id}&limit=1`)).body);
  }
  const paired = await as(`/api/time-bookings?site_id=${site.id}&work_day_id=${workDayId}&site_progress_item_id=${firstItem}`);
  t.assert.strictEqual(paired.body.length, 1);
  t.assert.strictEqual(paired.headers['x-total-count'], '1');
  const sites = await as('/api/sites?limit=1&offset=1');
  t.assert.strictEqual(sites.body.length, 2);
  t.assert.strictEqual(sites.headers['x-total-count'], undefined);
  const cors = await api(`/api/tasks?site_id=${site.id}`, {
    cookie: auth.cookies.viewer, headers: { origin: 'https://siteassistant.asassi.cloud' },
  });
  for (const header of ['X-Total-Count', 'X-Limit', 'X-Offset', 'X-RateLimit-Remaining', 'Retry-After']) {
    t.assert.ok(cors.headers['access-control-expose-headers'].split(', ').includes(header));
  }
});

test('HTTP socket smoke: anonymous rate limiting returns headers and JSON over HTTP', async t => {
  const server = createServer({}, { anonLimiter: createRateLimiter({ max: 1 }) });
  t.after(() => new Promise((resolve, reject) => {
    if (!server.listening) return resolve();
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const url = `http://127.0.0.1:${server.address().port}/api/health`;
  t.assert.strictEqual((await fetch(url)).status, 200);
  const result = await fetch(url);
  t.assert.strictEqual(result.status, 429);
  t.assert.match(result.headers.get('retry-after'), /^[1-9]\d*$/);
  t.assert.strictEqual(result.headers.get('x-ratelimit-remaining'), '0');
  t.assert.deepStrictEqual(await result.json(), { error: 'Too many requests.', code: 'RATE_LIMITED' });
});
