import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createContext, runInContext } from 'node:vm';
import { chat } from '../server/assistant.mjs';
import { createServer } from '../server/http.mjs';
import { createSite } from '../server/repository.mjs';
import { getEmployee, listEmployees, listWorkDays } from '../server/hr.mjs';
import { createApi } from '../app/api.mjs';
import { initialView, navGroups, visibleModules } from '../app/domain.mjs';
import { authFixture, requestListener } from './helpers/auth.mjs';
import { wbsDatabase } from './helpers/wbs.mjs';

for (const driver of ['sqlite', 'pg']) test(`Workforce permissions (${driver})`, async t => {
  const db = await wbsDatabase(t, driver);
  const site = await createSite(db, { code: 'SYN-WF', name: 'Synthetic workforce site' });
  const other = await createSite(db, { code: 'SYN-OTHER', name: 'Synthetic unrelated site' });
  const { users, cookies } = await authFixture(db, site);
  const api = requestListener(createServer(db, { authBypassUser: '' }));
  const at = '2026-01-15T08:00:00.000Z', day = '2026-01-15', next = '2026-01-16';
  const employee = async (siteId, number, first, company) => {
    const id = randomUUID();
    await db.run(`INSERT INTO employees (id, site_id, employee_no, first_name, last_name, company, created_at)
      VALUES (?, ?, ?, ?, 'Synthetic worker', ?, ?)`, id, siteId, number, first, company, at);
    return id;
  };
  const employeeId = await employee(site.id, 'SYN-001', 'Sample A', 'Synthetic company A');
  const secondId = await employee(site.id, 'SYN-002', 'Sample B', 'Synthetic company B');
  const otherId = await employee(other.id, 'SYN-003', 'Sample C', 'Synthetic company C');
  const workDay = (siteId, person, date, shift, start, finish, work, open, booked) =>
    db.run(`INSERT INTO work_days (id, site_id, employee_id, operational_date, shift, start_time, finish_time,
      work_time, open_hours, booked_hours, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    randomUUID(), siteId, person, date, shift, start, finish, work, open, booked, at);
  await workDay(site.id, employeeId, day, 'day', '06:00:00', '14:30:00', 8.25, 1.25, 7);
  await workDay(site.id, secondId, day, 'night', '18:00:00', '01:00:00', 6, 0, 6);
  await workDay(site.id, employeeId, next, 'day', '06:00:00', null, 0, 0, 0);
  await workDay(site.id, null, next, null, null, null, null, 1, null);
  await workDay(other.id, otherId, day, 'day', '06:00:00', '07:00:00', 100, 100, 100);

  const namedPaths = [`/api/employees?site_id=${site.id}`, `/api/work-days?site_id=${site.id}`, `/api/employees/${employeeId}`];
  const bookingsPath = `/api/time-bookings?site_id=${site.id}`;
  const summary = ({ group = 'day', from = day, to = next, siteId = site.id } = {}) =>
    `/api/workforce/summary?site_id=${siteId}&group_by=${group}&from=${from}&to=${to}`;
  const presence = (date = day, siteId = site.id) => `/api/workforce/presence?site_id=${siteId}&date=${date}`;
  const read = (path, role = 'viewer') => api(path, { cookie: cookies[role] });
  const grant = async (role, module, allowed) => {
    const result = await api('/api/member-access', { method: 'PUT', cookie: cookies.owner,
      body: { site_id: site.id, member_id: users[role].id, module, allowed } });
    assert.equal(result.status, 200);
  };
  const error = async (request, status, code) => {
    const result = await request;
    assert.equal(result.status, status);
    assert.equal(result.body.code, code);
  };

  await t.test('a real viewer session sees only the authorized summaries', async () => {
    for (const path of [...namedPaths, summary(), presence()]) await error(api(path), 401, 'AUTH_REQUIRED');
    for (const path of [...namedPaths, bookingsPath, presence()]) await error(read(path), 403, 'MODULE_FORBIDDEN');
    for (const [group, expected] of [
      ['day', [[day, 14.25, 1.25, 13], [next, null, 1, null]]],
      ['company', [['Synthetic company A', 8.25, 1.25, 7], ['Synthetic company B', 6, 0, 6], [null, null, 1, null]]],
      ['period', [[`${day}/${next}`, null, 2.25, null]]],
    ]) {
      const result = await read(summary({ group }));
      assert.equal(result.status, 200);
      assert.deepEqual(result.body, expected.map(([group_key, work_time, open_hours, booked_hours]) =>
        ({ group_key, work_time, open_hours, booked_hours })));
      assert.doesNotMatch(JSON.stringify(result.body), /employee_id|first_name|last_name|employee_no|Sample [ABC]|SYN-00/);
    }
    await grant('viewer', 'bookings', false);
    await error(read(summary()), 403, 'MODULE_FORBIDDEN');
    await grant('viewer', 'bookings', true);
  });

  await t.test('the names grant is explicit, supports revocation and leaves presence separate', async () => {
    for (const path of namedPaths) await error(read(path, 'editor'), 403, 'MODULE_FORBIDDEN');
    await assert.rejects(listEmployees(db, { siteId: site.id }, users.editor), { code: 'MODULE_FORBIDDEN' });
    await assert.rejects(listWorkDays(db, { siteId: site.id }, users.editor), { code: 'MODULE_FORBIDDEN' });
    await assert.rejects(getEmployee(db, employeeId, users.editor), { code: 'MODULE_FORBIDDEN' });
    await grant('editor', 'workforce_names', true);
    for (const path of [...namedPaths, bookingsPath]) {
      assert.equal((await read(path, 'editor')).status, 200);
      assert.equal((await read(path, 'owner')).status, 200);
    }
    assert.equal((await read(namedPaths[2], 'editor')).body.work_days.length, 2);
    await error(read(presence(), 'editor'), 403, 'MODULE_FORBIDDEN');
    await grant('editor', 'workforce_names', false);
    for (const path of namedPaths) await error(read(path, 'editor'), 403, 'MODULE_FORBIDDEN');
  });

  await t.test('the presence-only grant returns schedules without IDs or worked hours', async () => {
    await grant('viewer', 'workforce_presence', true);
    await grant('viewer', 'bookings', false);
    for (const role of ['viewer', 'owner']) {
      const result = await read(presence(), role);
      assert.equal(result.status, 200);
      assert.deepEqual(result.body, [
        { first_name: 'Sample A', last_name: 'Synthetic worker', company: 'Synthetic company A', shift: 'day', start_time: '06:00:00', finish_time: '14:30:00' },
        { first_name: 'Sample B', last_name: 'Synthetic worker', company: 'Synthetic company B', shift: 'night', start_time: '18:00:00', finish_time: '01:00:00' },
      ]);
      const nextResult = await read(presence(next), role);
      assert.equal(nextResult.status, 200);
      assert.equal(nextResult.body.length, 1);
      assert.equal(nextResult.body[0].finish_time, null);
    }
    for (const path of [...namedPaths, bookingsPath, summary()]) await error(read(path), 403, 'MODULE_FORBIDDEN');
    await grant('viewer', 'bookings', true);
    await grant('viewer', 'workforce_presence', false);
    await error(read(presence()), 403, 'MODULE_FORBIDDEN');
  });

  await t.test('validation, membership and inclusive range boundaries are enforced', async () => {
    for (const path of [summary({ siteId: '' }), summary({ group: 'employee' }), summary({ from: '2026-02-30' }),
      summary({ from: next, to: day }), summary({ from: '' }), summary({ to: '' }),
      summary({ from: '2024-01-01', to: '2025-01-01' }), presence(''), presence(day, 'invalid'),
      presence('0000-01-01')]) await error(read(path, 'owner'), 400, 'VALIDATION_ERROR');
    for (const path of [summary({ siteId: other.id }), presence(day, other.id), `/api/employees/${otherId}`]) {
      await error(read(path, 'owner'), 403, 'FORBIDDEN');
    }
    const leapYear = await read(summary({ group: 'period', from: '2024-01-01', to: '2024-12-31' }));
    assert.equal(leapYear.status, 200);
    assert.deepEqual(leapYear.body, []);
    const oneDay = await read(summary({ group: 'period', to: day }));
    assert.equal(oneDay.status, 200);
    assert.deepEqual(oneDay.body, [{ group_key: `${day}/${day}`, work_time: 14.25, open_hours: 1.25, booked_hours: 13 }]);
  });

  await t.test('the assistant can sum bookings for a viewer but cannot retrieve individual rows', async () => {
    let calls = 0;
    await chat(db, { siteId: site.id, user: users.viewer, messages: [{ role: 'user', content: 'Synthetic booking query' }] }, {
      apiKey: 'synthetic-key',
      fetchImpl: async (_url, options) => {
        calls++;
        if (calls === 1) return Response.json({ choices: [{ message: { tool_calls: [
          { id: 'detail', function: { name: 'find_records', arguments: '{"family":"time_bookings"}' } },
          { id: 'aggregate', function: { name: 'sum_hours', arguments: '{}' } },
        ] } }] });
        const results = JSON.parse(options.body).messages.filter(message => message.role === 'tool');
        assert.equal(JSON.parse(results[0].content).error, 'MODULE_FORBIDDEN');
        assert.deepEqual(JSON.parse(results[1].content), { total_hours: 0 });
        return Response.json({ choices: [{ message: { content: 'Synthetic aggregate result' } }] });
      },
    });
    assert.equal(calls, 2);
  });
});

test('the presence view requires an explicit grant and the client uses the workforce API contract', async () => {
  const modules = ['bookings', 'workforce_names', 'workforce_presence'];
  assert.deepEqual(visibleModules(modules), ['bookings']);
  assert.deepEqual(visibleModules(modules, { bookings: false, workforce_presence: true }), ['workforce_presence']);
  assert.equal(initialView({ width: 390, hash: '#workforce_presence' }), 'workforce_presence');
  assert.ok(navGroups({ workforce_presence: true }).some(group => group.items.includes('workforce_presence')));
  const urls = [];
  const api = createApi({ baseUrl: '/', fetchImpl: async (url, options) => {
    assert.equal(options.credentials, 'include');
    urls.push(url);
    return Response.json(url.includes('/summary?') ? [{ group_key: 'Synthetic company', work_time: 8 }]
      : [{ first_name: 'Sample', finish_time: null }]);
  } });
  const date = '2026-01-15';
  assert.deepEqual(await api.workforceSummary({ siteId: 'site-a', groupBy: 'company', from: date, to: date }),
    [{ groupKey: 'Synthetic company', workTime: 8 }]);
  assert.deepEqual(await api.workforcePresence({ siteId: 'site-a', date }), [{ firstName: 'Sample', finishTime: null }]);
  assert.deepEqual(urls, [
    `/api/workforce/summary?site_id=site-a&group_by=company&from=${date}&to=${date}`,
    `/api/workforce/presence?site_id=site-a&date=${date}`,
  ]);
});

test('bookings renders aggregates without loading employee records, while attendance renders schedules alone', async () => {
  const source = await readFile(new URL('../app/app.mjs', import.meta.url), 'utf8');
  const fragment = (from, to) => source.slice(source.indexOf(from), source.indexOf(to, source.indexOf(from)));
  const main = { innerHTML: '', insertAdjacentHTML(_position, html) { this.innerHTML += html; } };
  const reads = [];
  const context = createContext({
    view: 'bookings', siteId: 'site-a', hseView: 'register', hseAssetDetail: { id: '' },
    columnFiltersOn: false, offline: false, navigator: { onLine: true },
    moduleVisible: module => visibleModules([module]).length > 0, coreFilters: {},
    moduleResources: { bookings: ['bookings', 'workDays', 'employees', 'progress', 'workforceSummary'],
      workforce_presence: ['workforcePresence'] },
    $: selector => selector === '#main' ? main : null,
    t: key => key, heading: () => '', button: () => '', field: () => '',
    coreCache: new Map(), coreResource: key => { reads.push(key); return {}; },
    coreData: key => ({
      workforceSummary: [{ groupKey: '2026-01-15', workTime: 8, openHours: 1, bookedHours: 7 }],
      workforcePresence: [{ firstName: 'Sample', lastName: 'Worker', company: 'Synthetic company',
        shift: 'day', startTime: '06:00:00', finishTime: '14:00:00', workTime: 8 }],
    })[key],
    workforceSummaryFilters: { groupBy: 'day', from: '2026-01-15', to: '2026-01-15' },
    operationalDay: () => ({ date: '2026-01-15' }),
    coreDate: date => date, coreNumber: String, coreValue: String,
    coreTable: (columns, rows) => [...columns, ...rows.flat()].join(' '),
    renderDeviations() {}, renderProgress() {}, renderImpacts() {}, renderTools() {}, renderCertifications() {},
    renderHse() {}, renderBookings() { assert.fail('Individual hours must not render without the grant'); },
    renderAuditPanel: () => '', enhanceCoreTables() {}, bindAuditPanel() {},
  });
  runInContext(fragment('function renderCore()', 'function auditEntityType()')
    + fragment('function summaryFilters()', 'function renderBookings()'), context);
  runInContext('renderCore()', context);
  assert.deepEqual(reads, ['workforceSummary']);
  assert.match(main.innerHTML, /coreSourceWorkTime/);
  assert.doesNotMatch(main.innerHTML, /coreEmployee|booking-form/);

  context.view = 'workforce_presence';
  context.moduleVisible = module => module === 'workforce_presence';
  runInContext('renderCore()', context);
  assert.deepEqual(reads, ['workforceSummary', 'workforcePresence']);
  assert.match(main.innerHTML, /Sample Worker.*06:00:00.*14:00:00/);
  assert.doesNotMatch(main.innerHTML, /Hours|WorkTime|booking-form/);
});
