import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from '../server/http.mjs';
import { createSite, createTask, createDiary } from '../server/repository.mjs';
import { MODULES, moduleAllowed, listModuleAccess } from '../server/module-access.mjs';
import { createTool } from '../server/tools.mjs';
import { createCertification } from '../server/certifications.mjs';
import { chat } from '../server/assistant.mjs';
import { migrate, applyMigration } from '../server/migrations/index.mjs';
import { navGroups, visibleModules } from '../app/domain.mjs';
import { createApi } from '../app/api.mjs';
import { messages } from '../app/i18n.mjs';
import { authFixture, requestListener } from './helpers/auth.mjs';
import { openTestDb, isPg } from './helpers/db.mjs';

test('member module access: repository and HTTP', async t => {
  const { db, close } = await openTestDb();
  t.after(close);
  const { users, cookies } = await authFixture(db);
  const api = requestListener(createServer(db));
  const fixture = async () => {
    const site = await createSite(db, { code: randomUUID(), name: 'Synthetic access site' });
    for (const role of ['owner', 'editor', 'verifier', 'viewer']) {
      await db.run('INSERT INTO site_members VALUES (?, ?, ?)', site.id, users[role].id, role);
    }
    const task = await createTask(db, { siteId: site.id, title: 'Synthetic task', executor: 'Executor', verifier: 'Reviewer' });
    await createDiary(db, { siteId: site.id, operational_date: '2026-01-15', shift: 'day', plan: 'Synthetic plan' });
    const employeeId = randomUUID(), workDayId = randomUUID(), itemId = randomUUID(), wbsId = randomUUID(), deviationId = randomUUID();
    const at = '2026-01-15T08:00:00.000Z';
    await db.run('INSERT INTO employees (id, site_id, employee_no, created_at) VALUES (?, ?, ?, ?)', employeeId, site.id, 'SYN-001', at);
    await db.run('INSERT INTO work_days (id, site_id, employee_id, operational_date, created_at) VALUES (?, ?, ?, ?, ?)', workDayId, site.id, employeeId, '2026-01-15', at);
    await db.run('INSERT INTO project_structure (id, site_id, wbs_code, level, created_at) VALUES (?, ?, ?, ?, ?)', wbsId, site.id, 'SYN.1', 0, at);
    await db.run('INSERT INTO site_progress_items (id, site_id, wbs_id, source_row, created_at) VALUES (?, ?, ?, ?, ?)', itemId, site.id, wbsId, 2, at);
    await db.run('INSERT INTO deviations (id, site_id, deviation_no, status, created_at) VALUES (?, ?, ?, ?, ?)', deviationId, site.id, 'SYN-D1', 'open', at);
    const tool = await createTool(db, { siteId: site.id, name: 'Synthetic tool' }, users.owner);
    const cert = await createCertification(db, { siteId: site.id, employeeId, name: 'Synthetic qualification' }, users.owner);
    const impact = await api('/api/cost-impacts', { method: 'POST', body: { site_id: site.id, title: 'Synthetic impact', deviation_ids: [deviationId] }, cookie: cookies.owner });
    assert.equal(impact.status, 201);
    return { site, task, employeeId, workDayId, itemId, wbsId, deviationId, tool, cert, impact: impact.body };
  };
  const get = (path, role = 'editor') => api(path, { cookie: cookies[role] });
  const save = (f, module, allowed = false, role = 'editor', actor = 'owner') => api('/api/member-access', {
    method: 'PUT', cookie: cookies[actor], body: { site_id: f.site.id, member_id: users[role].id, module, allowed },
  });
  const error = (response, status, code) => { assert.equal(response.status, status); assert.equal(response.body.code, code); };

  await t.test('no rows allows every module for editor and viewer while preserving write roles', async () => {
    const f = await fixture();
    for (const role of ['editor', 'viewer']) {
      for (const module of MODULES) assert.equal(await moduleAllowed(db, f.site.id, users[role], module), true);
      assert.equal((await get(`/api/tasks?site_id=${f.site.id}`, role)).status, 200);
    }
    const body = { siteId: f.site.id, title: 'Synthetic write', executor: 'Executor', verifier: 'Reviewer' };
    assert.equal((await api('/api/tasks', { method: 'POST', body, cookie: cookies.editor })).status, 201);
    error(await api('/api/tasks', { method: 'POST', body, cookie: cookies.viewer }), 403, 'FORBIDDEN');
    assert.equal((await db.all('SELECT * FROM member_module_access')).length, 0);
  });

  await t.test('tasks denial blocks list, detail, create, transition and idempotent replay', async () => {
    const f = await fixture();
    const options = { method: 'POST', cookie: cookies.editor, headers: { 'idempotency-key': randomUUID() },
      body: { siteId: f.site.id, title: 'Synthetic replay', executor: 'Executor', verifier: 'Reviewer' } };
    assert.equal((await api('/api/tasks', options)).status, 201);
    assert.equal((await save(f, 'tasks')).status, 200);
    for (const path of [`/api/tasks?site_id=${f.site.id}`, `/api/tasks/${f.task.id}`]) error(await get(path), 403, 'MODULE_FORBIDDEN');
    error(await api('/api/tasks', options), 403, 'MODULE_FORBIDDEN');
    error(await api(`/api/tasks/${f.task.id}/transition`, { method: 'POST', body: { to: 'in_progress' }, cookie: cookies.editor }), 403, 'MODULE_FORBIDDEN');
    for (const path of [`/api/diary?site_id=${f.site.id}`, `/api/deviations?site_id=${f.site.id}`, `/api/site-progress?site_id=${f.site.id}`]) assert.equal((await get(path)).status, 200);
    assert.equal((await get(`/api/tasks?site_id=${f.site.id}`, 'owner')).status, 200);
  });

  await t.test('verifier impacts denial leaves deviations, tasks and bookings accessible', async () => {
    const f = await fixture();
    assert.equal((await save(f, 'impacts', false, 'verifier')).status, 200);
    error(await get(`/api/cost-impacts?site_id=${f.site.id}`, 'verifier'), 403, 'MODULE_FORBIDDEN');
    error(await get(`/api/cost-impacts/${f.impact.id}`, 'verifier'), 403, 'MODULE_FORBIDDEN');
    error(await api(`/api/cost-impacts/${f.impact.id}/transition`, { method: 'POST', body: { to: 'notification_sent' }, cookie: cookies.verifier }), 403, 'MODULE_FORBIDDEN');
    error(await api('/api/cost-impacts', { method: 'POST', body: { site_id: f.site.id, title: 'Denied', deviation_ids: [f.deviationId] }, cookie: cookies.verifier }), 403, 'MODULE_FORBIDDEN');
    for (const path of ['deviations', 'tasks', 'time-bookings']) assert.equal((await get(`/api/${path}?site_id=${f.site.id}`, 'verifier')).status, 200);
  });

  await t.test('only owners save; invalid modules, flags, other-site members and all owner denials are rejected', async () => {
    const f = await fixture(), other = await fixture();
    for (const actor of ['editor', 'verifier', 'viewer']) error(await save(f, 'tasks', false, 'editor', actor), 403, 'FORBIDDEN');
    for (const module of MODULES) error(await save(f, module, false, 'owner'), 400, 'ACCESS_INVALID');
    for (const module of ['overview', 'sites', 'unknown', '__proto__']) error(await save(f, module), 400, 'ACCESS_INVALID');
    for (const allowed of [0, 1, 'false', null]) error(await save(f, 'tasks', allowed), 400, 'ACCESS_INVALID');
    await db.run('DELETE FROM site_members WHERE site_id = ? AND user_id = ?', f.site.id, users.viewer.id);
    error(await save(f, 'tasks', false, 'viewer'), 400, 'ACCESS_INVALID');
    assert.equal(await moduleAllowed(db, other.site.id, users.viewer, 'tasks'), true);
    const invalid = await api('/api/member-access', { method: 'PUT', body: { site_id: f.site.id, member_id: 'bad', module: 'tasks', allowed: false }, cookie: cookies.owner });
    error(invalid, 400, 'ACCESS_INVALID');
  });

  await t.test('upsert retains identity and creation timestamp; allow restores access; matrix includes all effective values', async () => {
    const f = await fixture();
    await save(f, 'tasks');
    const before = await db.get('SELECT * FROM member_module_access WHERE site_id = ?', f.site.id);
    assert.equal(before.allowed, isPg ? false : 0);
    const matrix = await get(`/api/member-access?site_id=${f.site.id}`, 'viewer');
    assert.equal(matrix.status, 200); assert.equal(matrix.body.members.length, 4);
    for (const role of ['owner', 'editor', 'verifier', 'viewer']) {
      const member = matrix.body.members.find(member => member.user_id === users[role].id);
      assert.equal(member.email, users[role].email); assert.equal(member.name, users[role].name); assert.equal(member.role, role);
      assert.deepEqual(Object.keys(member.modules), MODULES);
      for (const module of MODULES) assert.equal(member.modules[module], !(role === 'editor' && module === 'tasks'));
    }
    await db.run('UPDATE member_module_access SET updated_at = ? WHERE id = ?', '2020-01-01T00:00:00.000Z', before.id);
    assert.equal((await save(f, 'tasks', true)).status, 200);
    const after = await db.get('SELECT * FROM member_module_access WHERE site_id = ?', f.site.id);
    assert.equal(after.id, before.id); assert.equal(String(after.created_at), String(before.created_at));
    assert.ok(Date.parse(after.updated_at) > Date.parse('2020-01-01T00:00:00.000Z'));
    assert.equal((await get(`/api/tasks?site_id=${f.site.id}`)).status, 200);
    assert.equal((await listModuleAccess(db, { siteId: f.site.id.toUpperCase() }, users.editor)).members.find(m => m.role === 'editor').modules.tasks, true);
  });

  await t.test('denials are site-scoped, including unscoped pagination and total counts', async () => {
    const f = await fixture(), other = await fixture();
    await save(f, 'tasks'); await save(f, 'diary');
    error(await get(`/api/tasks?siteId=${f.site.id}`), 403, 'MODULE_FORBIDDEN');
    error(await get(`/api/diary?site_id=${f.site.id}`), 403, 'MODULE_FORBIDDEN');
    error(await api('/api/diary', { method: 'POST', body: { siteId: f.site.id, shift: 'night' }, cookie: cookies.editor }), 403, 'MODULE_FORBIDDEN');
    assert.equal((await get(`/api/tasks?site_id=${other.site.id}`)).body[0].id, other.task.id);
    for (const path of ['tasks', 'diary']) {
      const all = await get(`/api/${path}?limit=200`);
      assert.equal(all.status, 200); assert.ok(all.body.every(row => row.site_id !== f.site.id));
      assert.ok(all.body.some(row => row.site_id === other.site.id));
      assert.equal(Number(all.headers['x-total-count']), all.body.length);
    }
  });

  await t.test('remaining module lists, details and writes reject denied access', async () => {
    const f = await fixture();
    const booking = await api('/api/time-bookings', { method: 'POST', body: { work_day_id: f.workDayId, site_progress_item_id: f.itemId, hours: 1 }, cookie: cookies.editor });
    assert.equal(booking.status, 201);
    const cases = [
      ['deviations', [`/api/deviations?site_id=${f.site.id}`, `/api/deviations/${f.deviationId}`], []],
      ['wbs', [`/api/wbs?site_id=${f.site.id}`, `/api/wbs/${f.wbsId}`], []],
      ['progress', [`/api/site-progress?site_id=${f.site.id}`, `/api/site-progress/${f.itemId}`, `/api/progress-types?site_id=${f.site.id}`, `/api/progress/curve?site_id=${f.site.id}`], [
        ['PATCH', `/api/site-progress/${f.itemId}`, { planned_hours: 1 }], ['PUT', `/api/site-progress/${f.itemId}/steps`, { steps: [] }],
      ]],
      ['bookings', [`/api/time-bookings?site_id=${f.site.id}`], [
        ['POST', '/api/time-bookings', { work_day_id: f.workDayId, site_progress_item_id: f.itemId, hours: 2 }],
        ['DELETE', `/api/time-bookings/${booking.body.id}`],
      ]],
      ['tools', [`/api/tools?site_id=${f.site.id}`], [
        ['POST', '/api/tools', { site_id: f.site.id, name: 'Denied tool' }],
        ['PATCH', `/api/tools/${f.tool.id}`, { name: 'Denied update' }], ['DELETE', `/api/tools/${f.tool.id}`],
      ]],
      ['certifications', [`/api/certifications?site_id=${f.site.id}`, `/api/certifications?site_id=${f.site.id}&summary=1`], [
        ['POST', '/api/certifications', { site_id: f.site.id, employee_id: f.employeeId, name: 'Denied certificate' }],
        ['PATCH', `/api/certifications/${f.cert.id}`, { name: 'Denied update' }], ['DELETE', `/api/certifications/${f.cert.id}`],
      ]],
    ];
    for (const [module, reads, writes] of cases) {
      await save(f, module);
      for (const path of reads) error(await get(path), 403, 'MODULE_FORBIDDEN');
      for (const [method, path, body] of writes) error(await api(path, { method, body, cookie: cookies.editor }), 403, 'MODULE_FORBIDDEN');
      await save(f, module, true);
    }
  });

  await t.test('aggregates cannot expose denied modules; layout, members and mappings remain role-governed', async () => {
    const f = await fixture();
    for (const module of ['deviations', 'progress', 'bookings', 'wbs', 'impacts']) {
      await save(f, module);
      error(await get(`/api/dashboard?site_id=${f.site.id}`), 403, 'MODULE_FORBIDDEN');
      if (module !== 'impacts') error(await get(`/api/report?site_id=${f.site.id}`), 403, 'MODULE_FORBIDDEN');
      await save(f, module, true);
    }
    for (const module of ['tasks', 'diary', 'tools', 'certifications']) await save(f, module);
    for (const path of ['dashboard', 'report', 'dashboard/layout', 'member-access', 'import-mappings']) assert.equal((await get(`/api/${path}?site_id=${f.site.id}`)).status, 200);
    assert.equal((await get(`/api/sites/${f.site.id}/members`, 'owner')).status, 200);
    error(await get(`/api/sites/${f.site.id}/members`), 403, 'FORBIDDEN');
  });

  await t.test('import preview and apply honor the target module while mapping administration stays available', async () => {
    const f = await fixture();
    for (const [family, module] of [['time_schedule', 'wbs'], ['site_progress_items', 'progress'], ['deviations', 'deviations'], ['daily_log', 'diary']]) {
      await save(f, module);
      for (const action of ['preview', 'apply']) error(await api(`/api/import/${action}`, {
        method: 'POST', body: { site_id: f.site.id, family }, cookie: cookies.editor,
      }), 403, 'MODULE_FORBIDDEN');
    }
    assert.equal((await get(`/api/import-mappings?site_id=${f.site.id}`)).status, 200);
  });

  await t.test('an allowed impact does not embed full records from denied deviations', async () => {
    const f = await fixture(); await save(f, 'deviations');
    const detail = await get(`/api/cost-impacts/${f.impact.id}`);
    assert.equal(detail.status, 200); assert.deepEqual(detail.body.deviations, []);
    const created = await api('/api/cost-impacts', { method: 'POST', cookie: cookies.editor,
      body: { site_id: f.site.id, title: 'Synthetic impact', deviation_ids: [f.deviationId] } });
    assert.equal(created.status, 201); assert.deepEqual(created.body.deviations, []);
    await save(f, 'deviations', false, 'verifier');
    const transitioned = await api(`/api/cost-impacts/${f.impact.id}/transition`, {
      method: 'POST', cookie: cookies.verifier, body: { to: 'notification_sent' },
    });
    assert.equal(transitioned.status, 200); assert.deepEqual(transitioned.body.deviations, []);
  });

  await t.test('attachments respect the parent module, including metadata, download and delete', async () => {
    const f = await fixture(), id = randomUUID();
    await db.run(`INSERT INTO attachments (id, site_id, entity_type, entity_id, filename, mime, size, content_sha256,
      storage_locator, manifest_version, uploaded_by, created_at) VALUES (?, ?, 'task', ?, 'synthetic.pdf',
      'application/pdf', 1, ?, 'synthetic-key', 'v1', ?, ?)`, id, f.site.id, f.task.id, '0'.repeat(64), users.owner.id, '2026-01-15T00:00:00.000Z');
    await save(f, 'tasks');
    assert.deepEqual((await get(`/api/attachments?site_id=${f.site.id}`)).body, []);
    error(await get(`/api/attachments?site_id=${f.site.id}&entity_type=task`), 403, 'MODULE_FORBIDDEN');
    error(await get(`/api/attachments/${id}`), 403, 'MODULE_FORBIDDEN');
    error(await api(`/api/attachments/${id}`, { method: 'DELETE', cookie: cookies.editor }), 403, 'MODULE_FORBIDDEN');
    error(await api('/api/attachments', { method: 'POST', body: { entity_type: 'task', entity_id: f.task.id }, cookie: cookies.editor }), 403, 'MODULE_FORBIDDEN');
  });

  await t.test('assistant tools never return a denied module to the model', async () => {
    const f = await fixture(); await save(f, 'tasks');
    let calls = 0;
    await chat(db, { siteId: f.site.id, user: users.editor, messages: [{ role: 'user', content: 'Synthetic task count?' }] }, {
      apiKey: 'synthetic-key', fetchImpl: async (_url, options) => {
        calls++;
        if (calls === 1) return Response.json({ choices: [{ message: { tool_calls: [{ id: 'synthetic-call', function: { name: 'count_records', arguments: '{"family":"tasks"}' } }] } }] });
        const tool = JSON.parse(options.body).messages.find(message => message.role === 'tool');
        assert.equal(JSON.parse(tool.content).error, 'MODULE_FORBIDDEN');
        assert.equal(JSON.parse(tool.content).total, undefined);
        return Response.json({ choices: [{ message: { content: 'Module unavailable.' } }] });
      },
    });
    assert.equal(calls, 2);
  });

  await t.test('owner bypass survives existing explicit denials; nonmembers never acquire access', async () => {
    const f = await fixture(); await save(f, 'tasks');
    await db.run("UPDATE site_members SET role = 'owner' WHERE site_id = ? AND user_id = ?", f.site.id, users.editor.id);
    assert.equal(await moduleAllowed(db, f.site.id, users.editor, 'tasks'), true);
    const matrix = await listModuleAccess(db, { siteId: f.site.id }, users.owner);
    assert.ok(Object.values(matrix.members.find(m => m.user_id === users.editor.id).modules).every(Boolean));
    await db.run('DELETE FROM site_members WHERE site_id = ? AND user_id = ?', f.site.id, users.viewer.id);
    assert.equal(await moduleAllowed(db, f.site.id, users.viewer, 'overview'), false);
    error(await get(`/api/member-access?site_id=${f.site.id}`, 'viewer'), 403, 'FORBIDDEN');
    error(await api('/api/member-access', { method: 'GET' }), 401, 'AUTH_REQUIRED');
  });

  await t.test('023 has primary, foreign, unique and not-null constraints and replays without changing settings', async () => {
    const f = await fixture(); await save(f, 'tasks');
    const before = await db.all('SELECT * FROM member_module_access ORDER BY id');
    await assert.rejects(db.run('UPDATE member_module_access SET allowed = NULL WHERE site_id = ?', f.site.id));
    await assert.rejects(db.run('UPDATE member_module_access SET user_id = ? WHERE site_id = ?', randomUUID(), f.site.id));
    const row = before.find(row => row.site_id === f.site.id);
    await assert.rejects(db.run(`INSERT INTO member_module_access (id, site_id, user_id, module, allowed, created_at, updated_at)
      VALUES (?, ?, ?, ?, FALSE, ?, ?)`, randomUUID(), f.site.id, users.editor.id, 'tasks', row.created_at, row.updated_at));
    await db.transaction(tx => applyMigration(tx, '023_member_module_access.sql', { driver: isPg ? 'pg' : 'sqlite' }));
    assert.equal(await migrate(db, { driver: isPg ? 'pg' : 'sqlite' }), 0);
    assert.deepEqual(await db.all('SELECT * FROM member_module_access ORDER BY id'), before);
  });
});

test('navigation filters only explicit denials, preserves anchors and does not mutate inputs', () => {
  const defaults = navGroups(), modules = { tasks: false, diary: false, deviations: false, sites: false, overview: false, unknown: false };
  const before = structuredClone(modules);
  assert.deepEqual(navGroups(), defaults);
  assert.deepEqual(navGroups({}), defaults);
  assert.deepEqual(navGroups(modules)[0].items, ['overview']);
  assert.deepEqual(visibleModules(['tasks', 'diary', 'sites', 'overview'], modules), ['sites', 'overview']);
  assert.deepEqual(navGroups(Object.fromEntries(MODULES.map(module => [module, false]))).flatMap(group => group.items), ['overview', 'sites']);
  assert.deepEqual(modules, before);
  const groups = navGroups(modules); groups[0].items.push('synthetic');
  assert.deepEqual(navGroups(), defaults);
});

test('member-access client uses wire fields, PUT and both-language labels', async () => {
  const calls = [], api = createApi({ baseUrl: '/', fetchImpl: async (url, options) => {
    calls.push({ url, options }); return Response.json({ members: [] });
  } });
  await api.listModuleAccess('site/a');
  assert.equal(calls[0].url, '/api/member-access?site_id=site%2Fa');
  const input = { site_id: 'site-a', member_id: 'member-a', module: 'tasks', allowed: false };
  await api.saveModuleAccess(input);
  assert.equal(calls[1].url, '/api/member-access'); assert.equal(calls[1].options.method, 'PUT');
  assert.deepEqual(JSON.parse(calls[1].options.body), input); assert.equal(calls[1].options.credentials, 'include');
  for (const key of ['moduleAccess', 'accessMember', 'accessOwner', 'moduleAccessHint', 'moduleUnavailable', 'moduleUnavailableHint', 'accessSaved', 'accessInvalid']) {
    assert.equal(typeof messages.it[key], 'string', key); assert.equal(typeof messages.en[key], 'string', key);
  }
});
