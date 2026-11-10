import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createSite } from '../server/repository.mjs';
import { getSiteProgressItem } from '../server/site-progress.mjs';
import { createTimeBooking, listTimeBookings, deleteTimeBooking, bookedHoursForItem } from '../server/time_bookings.mjs';
import { createServer } from '../server/http.mjs';
import { authFixture, requestListener } from './helpers/auth.mjs';
import { isPg, openTestDb, openSqliteTestDb } from './helpers/db.mjs';
import { siteProgressDatabase } from './helpers/site-progress.mjs';

for (const driver of ['sqlite', 'pg']) test(`Time bookings ${driver}: writes, aggregation and access`, async t => {
  let db;
  if (driver === 'pg' && !isPg) db = await siteProgressDatabase(t, driver);
  else {
    const database = await (driver === 'sqlite' ? openSqliteTestDb() : openTestDb());
    db = database.db; t.after(database.close);
  }
  const auth = await authFixture(db), api = requestListener(createServer(db));
  const fixture = async () => {
    const site = await createSite(db, { code: randomUUID(), name: 'Synthetic booking site' });
    for (const role of ['owner', 'editor', 'viewer']) await db.run('INSERT INTO site_members VALUES (?, ?, ?)', site.id, auth.users[role].id, role);
    // The verifier deliberately has no membership in these sites.
    const employeeId = randomUUID(), workDays = [randomUUID(), randomUUID()], items = [randomUUID(), randomUUID()];
    const at = '2026-01-15T08:00:00.000Z';
    await db.run('INSERT INTO employees (id, site_id, employee_no, created_at) VALUES (?, ?, ?, ?)', employeeId, site.id, 'SYN-001', at);
    for (const [index, id] of workDays.entries()) await db.run(`INSERT INTO work_days
      (id, site_id, employee_id, operational_date, created_at) VALUES (?, ?, ?, ?, ?)`,
    id, site.id, employeeId, `2026-01-${15 + index}`, at);
    for (const [index, id] of items.entries()) await db.run(`INSERT INTO site_progress_items
      (id, site_id, source_row, created_at) VALUES (?, ?, ?, ?)`, id, site.id, index + 2, at);
    return { site, workDays, items, input: { work_day_id: workDays[0], site_progress_item_id: items[0], hours: 1.25 } };
  };
  const post = (body, role = 'editor') => api('/api/time-bookings', { method: 'POST', body, cookie: auth.cookies[role] });
  const remove = (id, role = 'editor') => api(`/api/time-bookings/${id}`, { method: 'DELETE', cookie: auth.cookies[role] });
  const list = (siteId, query = '', role = 'viewer') => api(`/api/time-bookings?site_id=${siteId}${query}`, { cookie: auth.cookies[role] });
  const error = (response, status, code) => {
    t.assert.strictEqual(response.status, status);
    t.assert.strictEqual(response.body.code, code);
  };

  await t.test('editor creates, lists and deletes; IDs are lowercase and site comes from the work day', async t => {
    const f = await fixture(), other = await fixture();
    const response = await post({ ...f.input, work_day_id: f.workDays[0].toUpperCase(),
      site_progress_item_id: f.items[0].toUpperCase(), site_id: other.site.id });
    t.assert.strictEqual(response.status, 201);
    const row = response.body;
    t.assert.strictEqual(row.site_id, f.site.id);
    t.assert.strictEqual(row.work_day_id, f.workDays[0]);
    t.assert.strictEqual(row.site_progress_item_id, f.items[0]);
    t.assert.strictEqual(row.created_by, auth.users.editor.id);
    t.assert.strictEqual(row.hours, 1.25);
    t.assert.match(row.id, /^[0-9a-f-]{36}$/);
    t.assert.strictEqual(new Date(row.created_at).toISOString(), row.created_at);
    const listed = await list(f.site.id.toUpperCase());
    t.assert.strictEqual(listed.status, 200); t.assert.deepStrictEqual(listed.body, [row]);
    const deleted = await remove(row.id.toUpperCase());
    t.assert.strictEqual(deleted.status, 200); t.assert.deepStrictEqual(deleted.body, { deleted: true });
    t.assert.deepStrictEqual((await list(f.site.id)).body, []);
    t.assert.strictEqual((await post(f.input, 'owner')).status, 201);
  });

  await t.test('authentication and membership protect HTTP and direct module access', async t => {
    const f = await fixture(), row = (await post(f.input)).body;
    error(await post({ ...f.input, work_day_id: f.workDays[1] }, 'viewer'), 403, 'FORBIDDEN');
    error(await remove(row.id, 'viewer'), 403, 'FORBIDDEN');
    error(await list(f.site.id, '', 'verifier'), 403, 'FORBIDDEN');
    error(await post({ ...f.input, work_day_id: f.workDays[1] }, 'verifier'), 403, 'FORBIDDEN');
    error(await remove(row.id, 'verifier'), 403, 'FORBIDDEN');
    for (const [path, options] of [
      [`/api/time-bookings?site_id=${f.site.id}`, {}],
      ['/api/time-bookings', { method: 'POST', body: f.input }],
      [`/api/time-bookings/${row.id}`, { method: 'DELETE' }],
    ]) error(await api(path, options), 401, 'AUTH_REQUIRED');
    for (const call of [() => createTimeBooking(db, f.input),
      () => listTimeBookings(db, { siteId: f.site.id }), () => deleteTimeBooking(db, row.id)]) {
      await t.assert.rejects(call, { status: 401, code: 'UNAUTHENTICATED' });
    }
    t.assert.strictEqual((await list(f.site.id)).body.length, 1);
  });

  await t.test('hours require finite JSON numbers; zero is valid', async t => {
    const f = await fixture();
    for (const hours of [-1, 'invalid', '1.5', '', null, true, [], {}, undefined]) {
      error(await post({ ...f.input, hours }), 400, 'VALIDATION_ERROR');
    }
    for (const hours of [NaN, Infinity, -Infinity]) await t.assert.rejects(
      () => createTimeBooking(db, { ...f.input, hours }, auth.users.editor), { status: 400, code: 'VALIDATION_ERROR' });
    const response = await post({ ...f.input, hours: 0 });
    t.assert.strictEqual(response.status, 201); t.assert.strictEqual(response.body.hours, 0);
  });

  await t.test('UUID validation and missing references have explicit errors', async t => {
    const f = await fixture();
    for (const field of ['work_day_id', 'site_progress_item_id']) {
      for (const value of ['invalid', null, undefined]) error(await post({ ...f.input, [field]: value }), 400, 'VALIDATION_ERROR');
    }
    error(await post({ ...f.input, work_day_id: randomUUID() }), 404, 'WORK_DAY_NOT_FOUND');
    error(await post({ ...f.input, site_progress_item_id: randomUUID() }), 404, 'SITE_PROGRESS_ITEM_NOT_FOUND');
    for (const query of ['', '?site_id=', '?site_id=invalid',
      `?site_id=${f.site.id}&work_day_id=invalid`, `?site_id=${f.site.id}&site_progress_item_id=invalid`,
      `?site_id=${f.site.id}&work_day_id=`, `?site_id=${f.site.id}&site_progress_item_id=`]) {
      error(await api(`/api/time-bookings${query}`, { cookie: auth.cookies.viewer }), 400, 'VALIDATION_ERROR');
    }
    error(await remove(randomUUID()), 404, 'TIME_BOOKING_NOT_FOUND');
    error(await remove('invalid'), 400, 'VALIDATION_ERROR');
  });

  await t.test('the unique constraint arbitrates repeated and concurrent creates', async t => {
    const f = await fixture();
    const results = await Promise.all([post(f.input), post(f.input)]);
    t.assert.deepStrictEqual(results.map(row => row.status).sort(), [201, 409]);
    error(results.find(row => row.status === 409), 409, 'TIME_BOOKING_DUPLICATE');
    error(await post(f.input), 409, 'TIME_BOOKING_DUPLICATE');
    t.assert.strictEqual((await list(f.site.id)).body.length, 1);
    t.assert.strictEqual(await bookedHoursForItem(db, f.items[0]), 1.25);
  });

  await t.test('cross-site pairs are rejected and lists always enforce site scope and filters', async t => {
    const f = await fixture(), other = await fixture();
    error(await post({ ...f.input, site_progress_item_id: other.items[0] }), 409, 'TIME_BOOKING_SITE_MISMATCH');
    const first = (await post(f.input)).body;
    const second = (await post({ ...f.input, work_day_id: f.workDays[1] })).body;
    const third = (await post({ ...f.input, site_progress_item_id: f.items[1] })).body;
    await post(other.input);
    // Equal timestamps exercise the deterministic ID tie-breaker.
    await db.run('UPDATE time_bookings SET created_at = ? WHERE site_id = ?', '2026-01-15T08:00:00.000Z', f.site.id);
    const rows = (await list(f.site.id)).body;
    t.assert.deepStrictEqual(rows.map(row => row.id), [first.id, second.id, third.id].sort());
    t.assert.ok(rows.every(row => row.site_id === f.site.id && typeof row.hours === 'number'));
    t.assert.strictEqual((await list(f.site.id, `&site_progress_item_id=${f.items[0].toUpperCase()}`)).body.length, 2);
    t.assert.strictEqual((await list(f.site.id, `&work_day_id=${f.workDays[0].toUpperCase()}`)).body.length, 2);
    const both = await list(f.site.id, `&site_progress_item_id=${f.items[0]}&work_day_id=${f.workDays[0]}`);
    t.assert.deepStrictEqual(both.body.map(row => row.id), [first.id]);
    t.assert.deepStrictEqual((await list(f.site.id, `&site_progress_item_id=${other.items[0]}`)).body, []);
    t.assert.deepStrictEqual((await list(f.site.id, `&work_day_id=${other.workDays[0]}`)).body, []);
    t.assert.strictEqual((await list(other.site.id)).body.length, 1);
  });

  await t.test('progress detail adds only booked_hours and recomputes it after deletion', async t => {
    const f = await fixture(), other = await fixture();
    const before = JSON.parse(JSON.stringify(await getSiteProgressItem(db, f.items[0])));
    const detail = () => api(`/api/site-progress/${f.items[0]}`, { cookie: auth.cookies.viewer });
    const empty = await detail();
    t.assert.strictEqual(empty.status, 200);
    t.assert.deepStrictEqual(empty.body, { ...before, booked_hours: 0 });
    const first = (await post(f.input)).body;
    const second = (await post({ ...f.input, work_day_id: f.workDays[1], hours: 2.5 })).body;
    await post({ ...other.input, hours: 10 });
    await post({ ...f.input, site_progress_item_id: f.items[1], hours: 20 });
    t.assert.deepStrictEqual((await detail()).body, { ...before, booked_hours: 3.75 });
    await remove(first.id);
    t.assert.strictEqual((await detail()).body.booked_hours, 2.5);
    await remove(second.id);
    t.assert.strictEqual((await detail()).body.booked_hours, 0);
    error(await api(`/api/site-progress/${f.items[0]}`, { cookie: auth.cookies.verifier }), 403, 'FORBIDDEN');
  });

  await t.test('progress list carries booked_hours for each item, matching the detail view', async t => {
    const f = await fixture(), other = await fixture();
    const listProgress = async (role = 'viewer') => api(`/api/site-progress?site_id=${f.site.id}`, { cookie: auth.cookies[role] });
    const initial = await listProgress();
    t.assert.strictEqual(initial.status, 200);
    t.assert.deepStrictEqual(initial.body.map(row => row.booked_hours), [0, 0]);
    await post(f.input);
    await post({ ...f.input, work_day_id: f.workDays[1], hours: 2.5 });
    await post({ ...f.input, site_progress_item_id: f.items[1], hours: 20 });
    await post({ ...other.input, hours: 10 });
    const rows = (await listProgress()).body;
    const first = rows.find(row => row.id === f.items[0]), second = rows.find(row => row.id === f.items[1]);
    t.assert.strictEqual(first.booked_hours, 3.75);
    t.assert.strictEqual(second.booked_hours, 20);
    const detail = await api(`/api/site-progress/${f.items[0]}`, { cookie: auth.cookies.viewer });
    t.assert.deepStrictEqual(detail.body, first);
    t.assert.strictEqual((await listProgress('verifier')).status, 403);
  });
});
