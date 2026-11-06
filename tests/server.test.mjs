import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { openDb, closeDb } from '../server/db.mjs';
import { createServer } from '../server/http.mjs';
import { seed } from '../server/seed.mjs';

// Ambient HTTP proxies (HTTP_PROXY/HTTPS_PROXY) must not intercept loopback traffic:
// undici would route fetch to 127.0.0.1 through the proxy and the connection is closed.
process.env.NO_PROXY = [process.env.NO_PROXY, '127.0.0.1', 'localhost'].filter(Boolean).join(',');
process.env.no_proxy = process.env.NO_PROXY;

async function fixture(t) {
  // A unique temporary database pathname; no filesystem modules are needed.
  const path = `/tmp/siteassistant-test-${randomUUID()}.db`;
  const previous = process.env.DATA_DIR;
  process.env.DATA_DIR = path;
  let db;
  try {
    db = await openDb();
  } finally {
    if (previous === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previous;
  }
  const server = createServer(db);
  t.after(async () => {
    try {
      if (server.listening) {
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      }
    } finally {
      await closeDb(db);
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(path, body, expected = 200) {
    const response = await fetch(`${base}${path}`, body === undefined ? {} : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const result = await response.json();
    t.assert.strictEqual(response.status, expected, JSON.stringify(result));
    t.assert.match(response.headers.get('content-type'), /^application\/json/);
    if (expected >= 400) {
      t.assert.strictEqual(typeof result.error, 'string');
      t.assert.ok(result.error.length > 0);
      t.assert.deepStrictEqual(Object.keys(result).sort(), ['code', 'error']);
    }
    return result;
  }
  async function site(overrides = {}) {
    return request('/api/sites', {
      code: `FITT-${randomUUID()}`, name: 'Cantiere fittizio di Nuvolario', ...overrides,
    }, 201);
  }
  async function task(siteId, overrides = {}) {
    return request('/api/tasks', {
      siteId, title: 'Controllare il supporto dimostrativo',
      executor: 'Operatore fittizio A', verifier: 'Verificatore fittizio B', ...overrides,
    }, 201);
  }
  return { db, path, base, request, site, task };
}

test('site validation rejects missing fields, invalid dates and reversed date ranges', async t => {
  const api = await fixture(t);
  for (const input of [
    {}, { code: 'FITT', name: '   ' }, { code: 42, name: 'Cantiere fittizio' },
    { code: 'FITT', name: 'Cantiere fittizio', start_date: '2026-02-30' },
    { code: 'FITT', name: 'Cantiere fittizio', start_date: '2026-11-06', end_date: '2026-11-01' },
  ]) await api.request('/api/sites', input, 400);
  t.assert.deepStrictEqual(await api.request('/api/sites'), []);
});

test('create, list and retrieve a site; reject duplicate codes and persist in SQLite', async t => {
  const api = await fixture(t);
  const site = await api.site({
    code: ' FITT-UNICO ', location: 'Località immaginaria di Nuvolario',
    start_date: '2028-02-29', end_date: '2028-03-01',
  });
  t.assert.match(site.id, /^[0-9a-f-]{36}$/);
  t.assert.strictEqual(site.code, 'FITT-UNICO');
  t.assert.ok(Number.isFinite(Date.parse(site.created_at)));
  t.assert.deepStrictEqual(await api.request(`/api/sites/${site.id}`), site);
  t.assert.deepStrictEqual(await api.request('/api/sites'), [site]);
  const error = await api.request('/api/sites', { code: site.code, name: 'Altro cantiere fittizio' }, 409);
  t.assert.strictEqual(error.code, 'DUPLICATE_SITE_CODE');
  const reopened = await openDb(api.path);
  try {
    t.assert.strictEqual((await reopened.get('SELECT name FROM sites WHERE id = ?', site.id)).name, site.name);
    t.assert.strictEqual((await reopened.get('PRAGMA foreign_keys')).foreign_keys, 1);
  } finally {
    await closeDb(reopened);
  }
});

test('create tasks with distinct executor and verifier and filter by site and status', async t => {
  const api = await fixture(t);
  const first = await api.site();
  const second = await api.site();
  const task = await api.task(first.id, {
    area: 'Area campione A', company: 'Impresa fittizia Mattoni di Nebbia',
    priority: 'high', due_date: '2026-11-20',
  });
  await api.task(second.id);
  t.assert.strictEqual(task.site_id, first.id);
  t.assert.strictEqual(task.status, 'todo');
  t.assert.strictEqual(task.priority, 'high');
  t.assert.deepStrictEqual(task.events, []);
  t.assert.deepStrictEqual(await api.request(`/api/tasks/${task.id}`), task);
  const filtered = await api.request(`/api/tasks?siteId=${first.id}&status=todo`);
  t.assert.deepStrictEqual(filtered.map(row => row.id), [task.id]);
  t.assert.deepStrictEqual(await api.request(`/api/tasks?siteId=${first.id}&status=closed`), []);
  await api.request('/api/tasks?status=unknown', undefined, 400);
  await api.request('/api/tasks', { siteId: first.id, title: 'Prova fittizia', executor: 'Demo', verifier: ' Demo ' }, 400);
  await api.request('/api/tasks', { siteId: first.id, title: '', executor: 'Demo A', verifier: 'Demo B' }, 400);
  await api.request('/api/tasks', { siteId: first.id, title: 'Prova fittizia', executor: 'Demo A', verifier: 'Demo B', due_date: '2026-13-01' }, 400);
  await api.request('/api/tasks', { siteId: 'missing', title: 'Prova fittizia', executor: 'Demo A', verifier: 'Demo B' }, 404);
  t.assert.strictEqual((await api.request('/api/tasks')).length, 2);
});

test('completion requires a note; closure requires a note and the designated verifier', async t => {
  const api = await fixture(t);
  const task = await api.task((await api.site()).id);
  const route = `/api/tasks/${task.id}/transition`;
  await api.request(route, { to: 'in_progress', actor: task.executor });
  const before = await api.request(`/api/tasks/${task.id}`);
  for (const note of [undefined, '', '  ']) {
    const error = await api.request(route, { to: 'to_verify', actor: task.executor, note }, 400);
    t.assert.strictEqual(error.code, 'NOTE_REQUIRED');
  }
  t.assert.deepStrictEqual(await api.request(`/api/tasks/${task.id}`), before);
  const proposed = await api.request(route, { to: 'to_verify', actor: task.executor, note: 'Controllo simulato completato.' });
  await api.request(route, { to: 'closed', actor: task.verifier, note: ' ' }, 400);
  for (const actor of [task.executor, 'Coordinatore fittizio C']) {
    const error = await api.request(route, { to: 'closed', actor, note: 'Verifica simulata.' }, 409);
    t.assert.strictEqual(error.code, 'VERIFIER_REQUIRED');
  }
  t.assert.deepStrictEqual(await api.request(`/api/tasks/${task.id}`), proposed);
  const closed = await api.request(route, { to: 'closed', actor: task.verifier, note: 'Verifica simulata accettata.' });
  t.assert.strictEqual(closed.status, 'closed');
  t.assert.deepStrictEqual(closed.events.map(event => [event.from_status, event.to_status]), [
    ['todo', 'in_progress'], ['in_progress', 'to_verify'], ['to_verify', 'closed'],
  ]);
  t.assert.strictEqual(closed.events.at(-1).actor, task.verifier);
  t.assert.strictEqual(closed.events.at(-1).note, 'Verifica simulata accettata.');
  for (let index = 1; index < closed.events.length; index++) {
    t.assert.ok(closed.events[index - 1].id < closed.events[index].id);
    t.assert.ok(closed.events[index - 1].at <= closed.events[index].at);
  }
  await api.request(route, { to: 'in_progress', actor: task.executor }, 400);
  t.assert.deepStrictEqual(await api.request(`/api/tasks/${task.id}`), closed);
  const reopened = await api.request(route, { to: 'in_progress', actor: task.executor, reason: 'Nuova anomalia simulata.' });
  t.assert.strictEqual(reopened.status, 'in_progress');
  t.assert.deepStrictEqual(reopened.events.slice(0, 3), closed.events);
  t.assert.strictEqual(reopened.events.at(-1).reason, 'Nuova anomalia simulata.');
});

test('blocked requires a reason from each open workflow state', async t => {
  const api = await fixture(t);
  const site = await api.site();
  for (const state of ['todo', 'in_progress', 'to_verify']) {
    const task = await api.task(site.id);
    const route = `/api/tasks/${task.id}/transition`;
    if (state !== 'todo') await api.request(route, { to: 'in_progress', actor: task.executor });
    if (state === 'to_verify') await api.request(route, { to: 'to_verify', actor: task.executor, note: 'Evidenza simulata.' });
    const before = await api.request(`/api/tasks/${task.id}`);
    await api.request(route, { to: 'blocked', actor: task.executor, reason: '   ' }, 400);
    t.assert.deepStrictEqual(await api.request(`/api/tasks/${task.id}`), before);
    const blocked = await api.request(route, { to: 'blocked', actor: task.executor, reason: 'Materiale dimostrativo assente.' });
    t.assert.strictEqual(blocked.status, 'blocked');
    t.assert.strictEqual(blocked.events.at(-1).reason, 'Materiale dimostrativo assente.');
  }
});

test('every unspecified state-machine edge returns 409 without writing', async t => {
  const api = await fixture(t);
  const site = await api.site();
  const allowed = {
    todo: ['in_progress', 'blocked'], in_progress: ['to_verify', 'blocked'],
    to_verify: ['closed', 'blocked'], closed: ['in_progress'], blocked: [],
  };
  for (const from of Object.keys(allowed)) {
    const task = await api.task(site.id);
    const route = `/api/tasks/${task.id}/transition`;
    const advance = to => api.request(route, {
      to, actor: task.verifier, note: 'Evidenza fittizia.', reason: 'Motivo fittizio.',
    });
    if (from === 'blocked') await advance('blocked');
    if (['in_progress', 'to_verify', 'closed'].includes(from)) await advance('in_progress');
    if (['to_verify', 'closed'].includes(from)) await advance('to_verify');
    if (from === 'closed') await advance('closed');
    const before = await api.request(`/api/tasks/${task.id}`);
    for (const to of Object.keys(allowed).filter(to => !allowed[from].includes(to))) {
      const error = await api.request(route, {
        to, actor: task.verifier, note: 'Evidenza fittizia.', reason: 'Motivo fittizio.',
      }, 409);
      t.assert.strictEqual(error.code, 'INVALID_TRANSITION');
      t.assert.deepStrictEqual(await api.request(`/api/tasks/${task.id}`), before);
    }
  }
});

test('diary uniqueness uses site, operational date and shift; filters stay isolated', async t => {
  const api = await fixture(t);
  const first = await api.site();
  const second = await api.site();
  const input = {
    siteId: first.id, operational_date: '2026-11-06', shift: 'night',
    plan: 'Piano simulato.', actual: 'Consuntivo simulato.',
    impediments: 'Nessuno nella prova.', next_step: 'Controllo dimostrativo.',
  };
  const entry = await api.request('/api/diary', input, 201);
  t.assert.strictEqual(entry.site_id, first.id);
  t.assert.strictEqual(entry.operational_date, input.operational_date);
  const error = await api.request('/api/diary', input, 409);
  t.assert.strictEqual(error.code, 'DUPLICATE_DIARY');
  await api.request('/api/diary', { ...input, shift: 'day' }, 201);
  await api.request('/api/diary', { ...input, operational_date: '2026-11-07' }, 201);
  await api.request('/api/diary', { ...input, siteId: second.id }, 201);
  t.assert.strictEqual((await api.request(`/api/diary?siteId=${first.id}`)).length, 3);
  t.assert.strictEqual((await api.request('/api/diary')).length, 4);
  await api.request('/api/diary', { ...input, shift: 'evening' }, 400);
  await api.request('/api/diary', { ...input, operational_date: '2026-02-29' }, 400);
  await api.request('/api/diary', { ...input, siteId: 'missing' }, 404);
  t.assert.strictEqual((await api.request('/api/diary')).length, 4);
});

test('unknown task, site and route return JSON 404 errors', async t => {
  const api = await fixture(t);
  const error = await api.request('/api/tasks/unknown', undefined, 404);
  t.assert.strictEqual(error.code, 'TASK_NOT_FOUND');
  await api.request('/api/tasks/unknown/transition', { to: 'in_progress', actor: 'Operatore fittizio A' }, 404);
  await api.request('/api/sites/unknown', undefined, 404);
  await api.request('/api/unknown', undefined, 404);
});

test('malformed JSON, non-object bodies, oversized bodies and wrong media types return 400', async t => {
  const api = await fixture(t);
  for (const [body, type] of [
    ['{', 'application/json'], ['null', 'application/json'], ['[]', 'application/json'],
    ['"text"', 'application/json'], ['', 'application/json'], ['{}', 'text/plain'],
    [JSON.stringify({ name: 'x'.repeat(65537) }), 'application/json'],
  ]) {
    const response = await fetch(`${api.base}/api/sites`, {
      method: 'POST', headers: { 'Content-Type': type }, body,
    });
    t.assert.strictEqual(response.status, 400);
    const error = await response.json();
    t.assert.strictEqual(error.code, 'INVALID_JSON');
    t.assert.strictEqual(typeof error.error, 'string');
  }
  t.assert.deepStrictEqual(await api.request('/api/sites'), []);
});

test('seed inserts exactly 2 sites, 4 tasks and 1 diary entry and skips existing data', async t => {
  const api = await fixture(t);
  t.assert.strictEqual(await seed(api.db), true);
  const before = {
    sites: await api.request('/api/sites'), tasks: await api.request('/api/tasks'), diary: await api.request('/api/diary'),
  };
  t.assert.strictEqual(before.sites.length, 2);
  t.assert.strictEqual(before.tasks.length, 4);
  t.assert.strictEqual(before.diary.length, 1);
  t.assert.strictEqual(await seed(api.db), false);
  t.assert.deepStrictEqual(await api.request('/api/sites'), before.sites);
  t.assert.deepStrictEqual(await api.request('/api/tasks'), before.tasks);
  t.assert.deepStrictEqual(await api.request('/api/diary'), before.diary);
});
