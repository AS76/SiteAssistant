import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DASHBOARD_WIDGETS, DEFAULT_DASHBOARD_WIDGETS, defaultDashboardLayout, validDashboardWidgets } from '../app/dashboard-layout.mjs';
import { messages } from '../app/i18n.mjs';
import { createApi, ApiError } from '../app/api.mjs';
import { createSite } from '../server/repository.mjs';
import { createServer } from '../server/http.mjs';
import { applyMigration } from '../server/migrations/index.mjs';
import { openTestDb, isPg } from './helpers/db.mjs';
import { authFixture, requestListener } from './helpers/auth.mjs';

const expectedIds = ['kpi_open_deviations', 'kpi_booked_hours', 'kpi_open_claims', 'kpi_settled_claims',
  'deviations_by_status', 'progress_by_section', 'hours_by_week', 'earned_value', 'priority_work', 'daily_pulse', 'journal_today'];

test('dashboard catalog is fixed, unique, bilingual and defaults contain every widget in catalog order', () => {
  assert.deepEqual(DASHBOARD_WIDGETS.map(widget => widget.id), expectedIds);
  assert.equal(new Set(expectedIds).size, 11);
  assert.deepEqual(DEFAULT_DASHBOARD_WIDGETS, expectedIds);
  assert.deepEqual(defaultDashboardLayout(), { widgets: expectedIds, custom: false });
  const changed = defaultDashboardLayout(); changed.widgets.pop();
  assert.equal(defaultDashboardLayout().widgets.length, 11);
  assert.equal(validDashboardWidgets([...expectedIds].reverse()), true);
  assert.equal(validDashboardWidgets(['journal_today']), true);
  for (const value of [null, undefined, {}, 'journal_today', [], ['unknown'], ['journal_today', 'journal_today'],
    [null], [42], Array(2), [...expectedIds, 'extra']]) assert.equal(validDashboardWidgets(value), false);
  assert.ok(Object.isFrozen(DASHBOARD_WIDGETS));
  for (const widget of DASHBOARD_WIDGETS) assert.ok(Object.isFrozen(widget));
  for (const language of ['it', 'en']) {
    for (const key of [...DASHBOARD_WIDGETS.map(widget => widget.label), 'layoutCustomize', 'layoutReset', 'layoutHint',
      'layoutMoveUp', 'layoutMoveDown', 'layoutInvalid', 'layoutSaved', 'layoutResetDone', 'layoutFallback']) {
      assert.equal(typeof messages[language][key], 'string', `${language}: ${key}`);
    }
  }
});

test('dashboard layout HTTP contract, persistence, authorization and isolation', async t => {
  const { db, close } = await openTestDb();
  t.after(close);
  const site = await createSite(db, { code: randomUUID(), name: 'Synthetic overview site' });
  const other = await createSite(db, { code: randomUUID(), name: 'Synthetic second site' });
  const outsider = await createSite(db, { code: randomUUID(), name: 'Synthetic restricted site' });
  const auth = await authFixture(db, site);
  for (const [role, user] of Object.entries(auth.users)) {
    await db.run('INSERT INTO site_members (site_id, user_id, role) VALUES (?, ?, ?)', other.id, user.id, role);
  }
  const api = requestListener(createServer(db));
  const read = (siteId = site.id, role = 'owner') => api(`/api/dashboard/layout?site_id=${siteId}`, { cookie: auth.cookies[role] });
  const save = (widgets, siteId = site.id, role = 'owner', extra = {}) => api('/api/dashboard/layout', {
    method: 'PUT', body: { site_id: siteId, widgets, ...extra }, cookie: auth.cookies[role],
  });
  const reset = (siteId = site.id, role = 'owner') => api(`/api/dashboard/layout?site_id=${siteId}`, {
    method: 'DELETE', cookie: auth.cookies[role],
  });
  const defaultResult = { widgets: expectedIds, custom: false };

  await t.test('GET without a row returns defaults without inserting anything', async () => {
    const response = await read();
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, defaultResult);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.deepEqual(await db.all('SELECT * FROM dashboard_layouts'), []);
  });

  await t.test('PUT preserves selection and order, upserts one row and keeps identity and creation time', async () => {
    const first = ['journal_today', 'kpi_settled_claims', 'hours_by_week'];
    const response = await save(first);
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { widgets: first, custom: true });
    assert.deepEqual((await read()).body, response.body);
    const before = await db.get('SELECT * FROM dashboard_layouts WHERE site_id = ? AND owner_id = ?', site.id, auth.users.owner.id);
    assert.deepEqual(JSON.parse(before.widgets_json), first);
    const widgets = [...expectedIds].reverse();
    assert.deepEqual((await save(widgets)).body, { widgets, custom: true });
    assert.deepEqual((await read()).body, { widgets, custom: true });
    const rows = await db.all('SELECT * FROM dashboard_layouts WHERE site_id = ? AND owner_id = ?', site.id, auth.users.owner.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, before.id);
    assert.deepEqual(rows[0].created_at, before.created_at);
    assert.ok(Number.isFinite(Date.parse(rows[0].updated_at)));
  });

  await t.test('unknown IDs, duplicates, empty and non-array widgets return LAYOUT_INVALID without changing the row', async () => {
    const before = (await read()).body;
    for (const widgets of [['unknown'], ['journal_today', 'unknown'], ['hours_by_week', 'hours_by_week'], [],
      null, {}, 'hours_by_week', 1, true, [null], [1], Array(12).fill('hours_by_week')]) {
      const response = await save(widgets);
      assert.equal(response.status, 400, JSON.stringify(widgets));
      assert.equal(response.body.code, 'LAYOUT_INVALID');
      assert.deepEqual((await read()).body, before);
    }
    const missing = await api('/api/dashboard/layout', { method: 'PUT', body: { site_id: site.id }, cookie: auth.cookies.owner });
    assert.equal(missing.status, 400); assert.equal(missing.body.code, 'LAYOUT_INVALID');
  });

  await t.test('users on the same site and sites for the same user have distinct layouts', async () => {
    const a = ['daily_pulse', 'journal_today'], b = ['kpi_booked_hours'], c = ['earned_value', 'priority_work'];
    await save(a);
    assert.deepEqual((await read(site.id, 'editor')).body, defaultResult);
    assert.deepEqual((await read(other.id)).body, defaultResult);
    await save(b, site.id, 'editor'); await save(c, other.id);
    assert.deepEqual((await read()).body, { widgets: a, custom: true });
    assert.deepEqual((await read(site.id, 'editor')).body, { widgets: b, custom: true });
    assert.deepEqual((await read(other.id)).body, { widgets: c, custom: true });
    // Owner IDs supplied by clients never select another user's layout.
    await save(a, site.id, 'owner', { owner_id: auth.users.editor.id, shared: true });
    assert.deepEqual((await read(site.id, 'editor')).body, { widgets: b, custom: true });
  });

  await t.test('DELETE is idempotent, restores defaults and only removes the current site/user row', async () => {
    const editorBefore = (await read(site.id, 'editor')).body, otherBefore = (await read(other.id)).body;
    for (let n = 0; n < 2; n++) {
      const response = await reset();
      assert.equal(response.status, 200);
      assert.deepEqual(response.body, defaultResult);
      assert.deepEqual((await read()).body, defaultResult);
    }
    assert.equal(await db.get('SELECT id FROM dashboard_layouts WHERE site_id = ? AND owner_id = ?', site.id, auth.users.owner.id), undefined);
    assert.deepEqual((await read(site.id, 'editor')).body, editorBefore);
    assert.deepEqual((await read(other.id)).body, otherBefore);
  });

  for (const role of ['owner', 'editor', 'verifier', 'viewer']) await t.test(`${role} can read, save and reset their own layout`, async () => {
    const widgets = ['priority_work', 'hours_by_week'];
    assert.equal((await read(site.id, role)).status, 200);
    const response = await save(widgets, site.id, role);
    assert.equal(response.status, 200);
    assert.deepEqual((await read(site.id, role)).body, { widgets, custom: true });
    assert.equal((await reset(site.id, role)).status, 200);
    assert.deepEqual((await read(site.id, role)).body, defaultResult);
  });

  await t.test('every method requires a session and site membership, including after membership removal', async () => {
    for (const method of ['GET', 'PUT', 'DELETE']) {
      const body = method === 'PUT' ? { site_id: site.id, widgets: ['daily_pulse'] } : undefined;
      const response = await api(`/api/dashboard/layout${method === 'PUT' ? '' : `?site_id=${site.id}`}`, { method, body });
      assert.equal(response.status, 401);
    }
    const before = await db.all('SELECT * FROM dashboard_layouts');
    for (const role of Object.keys(auth.users)) {
      assert.equal((await read(outsider.id, role)).status, 403);
      assert.equal((await save(['daily_pulse'], outsider.id, role)).status, 403);
      assert.equal((await reset(outsider.id, role)).status, 403);
    }
    await save(['daily_pulse'], site.id, 'viewer');
    await db.run('DELETE FROM site_members WHERE site_id = ? AND user_id = ?', site.id, auth.users.viewer.id);
    assert.equal((await read(site.id, 'viewer')).status, 403);
    assert.equal((await save(['journal_today'], site.id, 'viewer')).status, 403);
    assert.equal((await reset(site.id, 'viewer')).status, 403);
    assert.equal((await db.all('SELECT * FROM dashboard_layouts')).length, before.length + 1);
  });

  await t.test('layout writes and deletes do not change dashboard aggregation', async () => {
    const path = `/api/dashboard?site_id=${site.id}`;
    const before = await api(path, { cookie: auth.cookies.owner });
    assert.equal(before.status, 200);
    await save(['journal_today']);
    assert.deepEqual((await api(path, { cookie: auth.cookies.owner })).body, before.body);
    await reset();
    assert.deepEqual((await api(path, { cookie: auth.cookies.owner })).body, before.body);
  });

  await t.test('migration replay preserves rows; unique, foreign key and required JSON constraints hold', async () => {
    await save(['journal_today']);
    const rows = await db.all('SELECT * FROM dashboard_layouts');
    await applyMigration(db, '022_dashboard_layouts.sql', { driver: isPg ? 'pg' : 'sqlite' });
    assert.deepEqual(await db.all('SELECT * FROM dashboard_layouts'), rows);
    const insert = (siteId, ownerId, widgets = '[]') => db.run(`INSERT INTO dashboard_layouts
      (id, site_id, owner_id, widgets_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
    randomUUID(), siteId, ownerId, widgets, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
    await assert.rejects(() => insert(site.id, auth.users.owner.id));
    await assert.rejects(() => insert(randomUUID(), auth.users.owner.id));
    await assert.rejects(() => insert(site.id, randomUUID()));
    await assert.rejects(() => insert(outsider.id, auth.users.owner.id, null));
    assert.deepEqual(await db.all('SELECT * FROM dashboard_layouts'), rows);
  });
});

test('dashboard layout API client sends authenticated GET, PUT and DELETE and preserves errors', async () => {
  const calls = [], widgets = ['journal_today', 'kpi_open_claims'];
  const api = createApi({ baseUrl: '/synthetic/', fresh: true, fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return Response.json({ widgets, custom: options.method === 'PUT' });
  } });
  assert.deepEqual(await api.dashboardLayout('site &/'), { widgets, custom: false });
  assert.deepEqual(await api.saveDashboardLayout('site &/', widgets), { widgets, custom: true });
  assert.deepEqual(await api.deleteDashboardLayout('site &/'), { widgets, custom: false });
  assert.equal(calls[0].url, '/synthetic/api/dashboard/layout?site_id=site+%26%2F');
  assert.equal(calls[0].options.cache, 'reload');
  assert.equal(calls[1].url, '/synthetic/api/dashboard/layout');
  assert.equal(calls[1].options.method, 'PUT');
  assert.deepEqual(JSON.parse(calls[1].options.body), { site_id: 'site &/', widgets });
  assert.equal(calls[2].options.method, 'DELETE');
  assert.equal(calls[2].url, calls[0].url);
  assert.equal(calls[2].options.body, undefined);
  for (const call of calls) assert.equal(call.options.credentials, 'include');
  const failing = createApi({ fetchImpl: async () => Response.json({ error: 'Invalid synthetic layout', code: 'LAYOUT_INVALID' }, { status: 400 }) });
  await assert.rejects(() => failing.saveDashboardLayout('synthetic', ['unknown']), error => error instanceof ApiError
    && error.status === 400 && error.code === 'LAYOUT_INVALID');
});
