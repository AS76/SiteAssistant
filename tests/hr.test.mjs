import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createSite } from '../server/repository.mjs';
import { listEmployees, getEmployee, listWorkDays, importEmployees } from '../server/hr.mjs';
import { createServer } from '../server/http.mjs';
import { applyMigration } from '../server/migrations/index.mjs';
import { authFixture, requestListener } from './helpers/auth.mjs';
import { hrDatabase, hrSource } from './helpers/hr.mjs';

for (const driver of ['sqlite', 'pg']) test(`HR ${driver}: Employees and Work Days`, async t => {
  const db = await hrDatabase(t, driver), auth = await authFixture(db);
  const fixture = async options => {
    const site = await createSite(db, { code: randomUUID(), name: 'Synthetic HR site' });
    for (const [role, user] of Object.entries(auth.users)) await db.run('INSERT INTO site_members VALUES (?, ?, ?)', site.id, user.id, role);
    return { site, ...await hrSource(db, site, options) };
  };
  const promote = site => importEmployees(db, site.id, auth.users.owner);
  const state = async site => ({ employees: await listEmployees(db, { siteId: site.id }),
    workDays: await listWorkDays(db, { siteId: site.id }) });

  await t.test('source fields, time pairs, null/zero and operational dates survive promotion with correct shifts', async t => {
    const f = await fixture();
    const before = {};
    for (const family of ['employees', 'work_days']) before[family] = await db.all(`SELECT * FROM source_snapshot.${family} WHERE _batch_id = ?`, f.batches[family]);
    const usersBefore = await db.all('SELECT * FROM users ORDER BY id');
    t.assert.deepStrictEqual(await promote(f.site), { employees: 2, work_days: 6, unchanged: false, run_id: f.runId });
    const { employees, workDays } = await state(f.site);
    for (const [field, value] of Object.entries(f.employees[0])) t.assert.strictEqual(employees[0][field], value, field);
    t.assert.strictEqual(employees[1].first_name, null);
    t.assert.strictEqual(employees[1].hire_date, null);
    const bySource = new Map((await db.all("SELECT id, external_key FROM ingest.entity_keys WHERE scope_id = ? AND family = 'work_days'", f.scopeId)).map(row => [row.external_key, row.id]));
    const shifts = ['day', 'night', 'night', 'day', null, 'night'];
    for (const [index, source] of f.workDays.entries()) {
      const day = workDays.find(row => row.source_entity_key_id === bySource.get(source.source_uuid));
      t.assert.strictEqual(day.operational_date, source.operational_date);
      t.assert.strictEqual(day.start_time, source.start_time);
      t.assert.strictEqual(day.finish_time, source.finish_time);
      t.assert.strictEqual(day.shift, shifts[index]);
      t.assert.strictEqual(day.employee_id, employees.find(row => row.employee_no === source.employee_no)?.id ?? null);
      t.assert.strictEqual(day.source_status, source.source_status ?? null);
      for (const field of ['work_time', 'open_hours', 'booked_hours']) {
        if (source[`${field}_source`] == null) t.assert.strictEqual(day[field], null);
        else t.assert.strictEqual(Number(day[field]), source[`${field}_source`]);
      }
    }
    for (const family of ['employees', 'work_days']) t.assert.deepStrictEqual(await db.all(`SELECT * FROM source_snapshot.${family} WHERE _batch_id = ?`, f.batches[family]), before[family]);
    t.assert.deepStrictEqual(await db.all('SELECT * FROM users ORDER BY id'), usersBefore);
  });

  await t.test('repeated and concurrent imports are no-ops with unchanged IDs and timestamps', async t => {
    const { site } = await fixture(); await promote(site);
    const before = await state(site), config = await db.get('SELECT * FROM hr_import_sources WHERE site_id = ?', site.id);
    for (const result of await Promise.all([promote(site), promote(site)])) {
      t.assert.strictEqual(result.unchanged, true);
      t.assert.strictEqual(result.employees, 0); t.assert.strictEqual(result.work_days, 0);
    }
    t.assert.deepStrictEqual(await state(site), before);
    t.assert.deepStrictEqual(await db.get('SELECT * FROM hr_import_sources WHERE site_id = ?', site.id), config);
  });

  await t.test('employee numbers are unique per site, with isolated identities and lists across sites', async t => {
    const a = await fixture(), b = await fixture(); await promote(a.site); await promote(b.site);
    const first = await state(a.site), second = await state(b.site);
    t.assert.strictEqual(first.employees[0].employee_no, second.employees[0].employee_no);
    t.assert.notStrictEqual(first.employees[0].id, second.employees[0].id);
    await t.assert.rejects(() => db.run('UPDATE employees SET employee_no = ? WHERE id = ?', first.employees[0].employee_no, first.employees[1].id), /unique/i);
    t.assert.deepStrictEqual(await listWorkDays(db, { siteId: a.site.id, employee_id: second.employees[0].id }), []);
  });

  await t.test('employee detail and inclusive date/employee filters return only matching work days', async t => {
    const { site } = await fixture(); await promote(site);
    const employee = (await listEmployees(db, { siteId: site.id }))[0];
    const detail = await getEmployee(db, employee.id);
    t.assert.strictEqual(detail.work_days.length, 3);
    const rows = await listWorkDays(db, { siteId: site.id, employee_id: employee.id, from: '2026-01-16', to: '2026-01-17' });
    t.assert.deepStrictEqual(rows.map(row => row.operational_date), ['2026-01-16', '2026-01-17']);
    t.assert.strictEqual((await listWorkDays(db, { siteId: site.id, from: '2026-01-16', to: '2026-01-16' })).length, 2);
    t.assert.strictEqual((await listWorkDays(db, { siteId: site.id, to: '2026-01-15' })).length, 1);
    t.assert.strictEqual((await listWorkDays(db, { siteId: site.id, from: '2026-01-19' })).length, 1);
    await t.assert.rejects(() => getEmployee(db, 'invalid'), { status: 404 });
    await t.assert.rejects(() => getEmployee(db, randomUUID()), { status: 404 });
    for (const filters of [{ from: '2026-02-30' }, { to: '' }, { employee_id: 'invalid' }, { from: '2026-02-01', to: '2026-01-01' }]) {
      await t.assert.rejects(() => listWorkDays(db, { siteId: site.id, ...filters }), { status: 400 });
    }
  });

  await t.test('later runs update the current projection and retain surviving IDs, creation times and historical snapshots', async t => {
    const f = await fixture(); await promote(f.site);
    const before = await state(f.site);
    await hrSource(db, f.site, { scopeId: f.scopeId, employees: [{ ...f.employees[0], team: 'Synthetic revised team' }],
      workDays: [{ ...f.workDays[0], start_time: '18:00:00', work_time_source: 1.25 },
        { ...f.workDays[1], employee_no: 'SYN-001' }] });
    await promote(f.site);
    const after = await state(f.site);
    t.assert.strictEqual(after.employees.length, 1); t.assert.strictEqual(after.workDays.length, 2);
    t.assert.strictEqual(after.employees[0].id, before.employees[0].id);
    t.assert.deepStrictEqual(after.employees[0].created_at, before.employees[0].created_at);
    t.assert.strictEqual(after.employees[0].team, 'Synthetic revised team');
    for (const row of after.workDays) {
      t.assert.deepStrictEqual(row.created_at, before.workDays.find(old => old.id === row.id).created_at);
      t.assert.strictEqual(row.employee_id, after.employees[0].id);
      t.assert.strictEqual(row.shift, 'night');
    }
    t.assert.strictEqual((await db.all('SELECT * FROM source_snapshot.work_days WHERE _batch_id = ?', f.batches.work_days)).length, 6);
  });

  await t.test('missing mappings, incomplete runs, untyped or missing batches and count mismatches fail atomically', async t => {
    const f = await fixture();
    await db.run("UPDATE ingest.import_runs SET status = 'loading', completeness_verified = FALSE WHERE id = ?", f.runId);
    await t.assert.rejects(() => promote(f.site), { code: 'HR_RUN_NOT_READY' });
    await db.run("UPDATE ingest.import_runs SET status = 'ready', completeness_verified = TRUE WHERE id = ?", f.runId);
    await db.run("UPDATE ingest.import_batches SET status = 'staging' WHERE id = ?", f.batches.work_days);
    await t.assert.rejects(() => promote(f.site), { code: 'HR_RUN_NOT_READY' });
    await db.run("UPDATE ingest.import_batches SET status = 'typed', expected_rows = 99 WHERE id = ?", f.batches.work_days);
    await t.assert.rejects(() => promote(f.site), { code: 'HR_INCOMPLETE_SNAPSHOT' });
    await db.run("DELETE FROM ingest.run_batches WHERE run_id = ? AND family = 'employees'", f.runId);
    await t.assert.rejects(() => promote(f.site), { code: 'HR_RUN_NOT_READY' });
    await db.run('DELETE FROM hr_import_sources WHERE site_id = ?', f.site.id);
    await t.assert.rejects(() => promote(f.site), { code: 'HR_SOURCE_NOT_CONFIGURED' });
    t.assert.deepStrictEqual(await state(f.site), { employees: [], workDays: [] });
  });

  await t.test('scope/run mismatch and unresolved source identities cannot promote', async t => {
    const a = await fixture(), b = await fixture();
    await db.run('UPDATE hr_import_sources SET run_id = ? WHERE site_id = ?', b.runId, a.site.id);
    await t.assert.rejects(() => promote(a.site), { code: 'HR_RUN_NOT_READY' });
    for (const family of ['employees', 'work_days']) {
      await db.run("UPDATE ingest.entity_keys SET identity_state = 'unresolved' WHERE scope_id = ? AND family = ?", b.scopeId, family);
      await t.assert.rejects(() => promote(b.site), { code: 'HR_RECONCILIATION_REQUIRED' });
      await db.run("UPDATE ingest.entity_keys SET identity_state = 'observed' WHERE scope_id = ? AND family = ?", b.scopeId, family);
    }
    t.assert.deepStrictEqual(await state(b.site), { employees: [], workDays: [] });
  });

  await t.test('missing operational date or employee reference requires reconciliation without partial writes', async t => {
    const f = await fixture();
    await db.run('UPDATE source_snapshot.work_days SET operational_date = NULL WHERE _batch_id = ?', f.batches.work_days);
    await t.assert.rejects(() => promote(f.site), { code: 'HR_RECONCILIATION_REQUIRED' });
    const g = await fixture();
    await db.run("DELETE FROM source_snapshot.employees WHERE _batch_id = ? AND employee_no = 'SYN-002'", g.batches.employees);
    await db.run('UPDATE ingest.import_batches SET expected_rows = 1 WHERE id = ?', g.batches.employees);
    await t.assert.rejects(() => promote(g.site), { code: 'HR_RECONCILIATION_REQUIRED' });
    for (const site of [f.site, g.site]) t.assert.deepStrictEqual(await state(site), { employees: [], workDays: [] });
  });

  await t.test('late SQL failure rolls back both projections and promotion markers', async t => {
    const f = await fixture(); await promote(f.site);
    await hrSource(db, f.site, { scopeId: f.scopeId, employees: [{ ...f.employees[0], team: 'Synthetic updated team' }], workDays: [f.workDays[0]] });
    const before = await state(f.site), config = await db.get('SELECT * FROM hr_import_sources WHERE site_id = ?', f.site.id);
    const failing = { transaction: fn => db.transaction(tx => fn({ ...tx, run: async (sql, ...args) => {
      const result = await tx.run(sql, ...args);
      if (sql.startsWith('INSERT INTO work_days')) throw new Error('Synthetic write failure');
      return result;
    } })) };
    await t.assert.rejects(() => importEmployees(failing, f.site.id, auth.users.owner), /Synthetic write failure/);
    t.assert.deepStrictEqual(await state(f.site), before);
    t.assert.deepStrictEqual(await db.get('SELECT * FROM hr_import_sources WHERE site_id = ?', f.site.id), config);
  });

  await t.test('HTTP requires sessions/membership: viewer reads, only the site owner imports', async t => {
    const { site } = await fixture(), request = requestListener(createServer(db));
    const listPath = `/api/employees?site_id=${site.id}`, daysPath = `/api/work-days?site_id=${site.id}`;
    for (const path of [listPath, daysPath, '/api/employees/invalid']) t.assert.strictEqual((await request(path)).status, 401);
    t.assert.strictEqual((await request('/api/employees/import', { method: 'POST', body: { site_id: site.id } })).status, 401);
    await t.assert.rejects(() => importEmployees(db, site.id), { status: 401 });
    for (const role of ['viewer', 'editor', 'verifier']) {
      t.assert.strictEqual((await request('/api/employees/import', { method: 'POST', cookie: auth.cookies[role], body: { site_id: site.id } })).status, 403);
      await t.assert.rejects(() => importEmployees(db, site.id, auth.users[role]), { status: 403 });
    }
    const imported = await request('/api/employees/import', { method: 'POST', cookie: auth.cookies.owner, body: { site_id: site.id } });
    t.assert.strictEqual(imported.status, 200); t.assert.strictEqual(imported.body.work_days, 6);
    const listed = await request(listPath, { cookie: auth.cookies.viewer });
    t.assert.strictEqual(listed.status, 200); t.assert.strictEqual(listed.body.length, 2);
    const detailPath = `/api/employees/${listed.body[0].id}`;
    const detail = await request(detailPath, { cookie: auth.cookies.viewer });
    t.assert.strictEqual(detail.status, 200); t.assert.strictEqual(detail.body.work_days.length, 3);
    const filtered = await request(`${daysPath}&employee_id=${listed.body[0].id}&from=2026-01-16&to=2026-01-17`, { cookie: auth.cookies.viewer });
    t.assert.strictEqual(filtered.status, 200); t.assert.strictEqual(filtered.body.length, 2);
    for (const path of ['/api/employees', '/api/work-days', `${daysPath}&from=invalid`]) t.assert.strictEqual((await request(path, { cookie: auth.cookies.viewer })).status, 400);
    t.assert.strictEqual((await request('/api/employees/import', { method: 'POST', cookie: auth.cookies.owner, body: {} })).status, 400);
    t.assert.strictEqual((await request('/api/employees/invalid', { cookie: auth.cookies.viewer })).status, 404);
    await db.run('DELETE FROM site_members WHERE site_id = ? AND user_id = ?', site.id, auth.users.viewer.id);
    for (const path of [listPath, daysPath, detailPath]) t.assert.strictEqual((await request(path, { cookie: auth.cookies.viewer })).status, 403);
    const other = await createSite(db, { code: randomUUID(), name: 'Synthetic unrelated site' });
    t.assert.strictEqual((await request('/api/employees/import', { method: 'POST', cookie: auth.cookies.owner, body: { site_id: other.id } })).status, 403);
    for (const path of [listPath, detailPath, daysPath]) t.assert.strictEqual((await request(path, { method: 'PATCH', cookie: auth.cookies.owner, body: {} })).status, 404);
  });

  await t.test('migration replay preserves rows and enforces types, keys, shift and the query index', async t => {
    const { site } = await fixture(); await promote(site);
    const before = await state(site);
    await db.transaction(tx => applyMigration(tx, '009_employees_workdays.sql', { driver }));
    t.assert.deepStrictEqual(await state(site), before);
    for (const [column, value, pattern] of [['employee_id', randomUUID(), /foreign key/i], ['site_id', randomUUID(), /foreign key/i], ['operational_date', null, /not.null/i], ['shift', 'other', /check/i]]) {
      await t.assert.rejects(() => db.run(`UPDATE work_days SET ${column} = ? WHERE site_id = ?`, value, site.id), pattern);
    }
    if (driver === 'pg') {
      const columns = await db.all("SELECT column_name, udt_name FROM information_schema.columns WHERE table_name = 'work_days' AND table_schema = current_schema()");
      for (const [column, type] of [['id', 'uuid'], ['employee_id', 'uuid'], ['source_entity_key_id', 'uuid'], ['operational_date', 'date'], ['start_time', 'time'], ['finish_time', 'time'], ['work_time', 'numeric'], ['open_hours', 'numeric'], ['booked_hours', 'numeric'], ['created_at', 'timestamptz']]) {
        t.assert.strictEqual(columns.find(row => row.column_name === column).udt_name, type);
      }
      t.assert.match((await db.get("SELECT indexdef FROM pg_indexes WHERE indexname = 'work_days_employee_date'")).indexdef, /site_id, employee_id, operational_date/);
    } else t.assert.deepStrictEqual((await db.all('PRAGMA index_info(work_days_employee_date)')).map(row => row.name), ['site_id', 'employee_id', 'operational_date']);
  });
});
