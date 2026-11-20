import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createSite } from '../server/repository.mjs';
import { createServer } from '../server/http.mjs';
import { openTestDb } from './helpers/db.mjs';
import { authFixture, requestListener } from './helpers/auth.mjs';

// Synthetic app records only: no import setup or external data is required.
test('dashboard HTTP contract keeps six-week calculations and exposes full-period/source coverage', async t => {
  const { db, close } = await openTestDb(); t.after(close);
  const auth = await authFixture(db), request = requestListener(createServer(db));
  const site = await createSite(db, { code: 'SYN-COVERAGE', name: 'Synthetic coverage site' });
  const other = await createSite(db, { code: 'SYN-EMPTY', name: 'Synthetic empty site' });
  for (const selected of [site, other]) await db.run('INSERT INTO site_members VALUES (?, ?, ?)', selected.id, auth.users.owner.id, 'owner');
  const at = '2026-01-01T00:00:00.000Z', item = randomUUID();
  await db.run(`INSERT INTO site_progress_items (id, site_id, source_row, description, planned_hours, progress_pct, created_at)
    VALUES (?, ?, 1, 'Synthetic progress', 1000, 50, ?)`, item, site.id, at);
  const dates = ['2026-09-21', '2026-09-28', '2026-10-05', '2026-10-12', '2026-10-19', '2026-10-26', '2026-11-02', '2026-11-13'];
  for (const date of dates) {
    const day = randomUUID();
    await db.run('INSERT INTO work_days (id, site_id, operational_date, work_time, created_at) VALUES (?, ?, ?, NULL, ?)', day, site.id, date, at);
    await db.run(`INSERT INTO time_bookings (id, site_id, work_day_id, site_progress_item_id, hours, created_at)
      VALUES (?, ?, ?, ?, 46, ?)`, randomUUID(), site.id, day, item, at);
  }
  const read = async (selected = site.id, cookie = auth.cookies.owner) => {
    const result = await request(`/api/dashboard?site_id=${selected}`, { cookie });
    assert.equal(result.status, 200); return result.body;
  };
  const before = await read();
  assert.equal(before.hours.reduce((sum, week) => sum + week.hours, 0), 276);
  assert.equal(before.earnedValue.ac_hours, 368);
  assert.equal(before.earnedValue.cpi, 1.36);
  assert.deepEqual(before.hoursCoverage, { appBookedHours: 368, bookedFrom: dates[0], bookedTo: dates.at(-1),
    workDays: 8, sourceWorkDays: 0, sourceWorkTime: null, knownSourceWorkTime: null });
  assert.equal(before.hoursCoverage.appBookedHours - 276, 92);
  assert.equal(before.workDays.length, 8);
  assert.ok(before.workDays.every(day => day.workTime === null));
  await db.run('UPDATE work_days SET work_time = 50 WHERE site_id = ?', site.id);
  const present = await read();
  assert.equal(present.hoursCoverage.sourceWorkTime, 400); assert.equal(present.hoursCoverage.sourceWorkDays, 8);
  assert.deepEqual(present.hours, before.hours); assert.deepEqual(present.earnedValue, before.earnedValue);
  await db.run('UPDATE work_days SET work_time = NULL WHERE site_id = ? AND operational_date = ?', site.id, dates[0]);
  const partial = await read();
  assert.equal(partial.hoursCoverage.sourceWorkTime, null); assert.equal(partial.hoursCoverage.sourceWorkDays, 7);
  assert.equal(partial.hoursCoverage.knownSourceWorkTime, 350);
  await db.run('UPDATE work_days SET work_time = 0 WHERE site_id = ?', site.id);
  assert.equal((await read()).hoursCoverage.sourceWorkTime, 0);
  const empty = await read(other.id);
  assert.deepEqual(empty.workDays, []);
  assert.deepEqual(empty.hoursCoverage, { appBookedHours: 0, bookedFrom: null, bookedTo: null,
    workDays: 0, sourceWorkDays: 0, sourceWorkTime: null, knownSourceWorkTime: null });
  assert.equal((await request(`/api/dashboard?site_id=${site.id}`, { cookie: auth.cookies.viewer })).status, 403);
});

test('six-week window totals use unrounded hours so display rounding cannot invent out-of-window time', async t => {
  const { db, close } = await openTestDb(); t.after(close);
  const auth = await authFixture(db), request = requestListener(createServer(db));
  const site = await createSite(db, { code: 'SYN-COVERAGE-ROUND', name: 'Synthetic rounded coverage site' });
  await db.run('INSERT INTO site_members VALUES (?, ?, ?)', site.id, auth.users.owner.id, 'owner');
  const at = '2026-01-01T00:00:00.000Z', item = randomUUID();
  await db.run(`INSERT INTO site_progress_items (id, site_id, source_row, description, planned_hours, progress_pct, created_at)
    VALUES (?, ?, 1, 'Synthetic rounded progress', 100, 50, ?)`, item, site.id, at);
  const dates = ['2026-09-21', '2026-09-28', '2026-10-05', '2026-10-12', '2026-10-19', '2026-10-26'];
  for (const date of dates) {
    const day = randomUUID();
    await db.run('INSERT INTO work_days (id, site_id, operational_date, created_at) VALUES (?, ?, ?, ?)', day, site.id, date, at);
    await db.run(`INSERT INTO time_bookings (id, site_id, work_day_id, site_progress_item_id, hours, created_at)
      VALUES (?, ?, ?, ?, 1.06, ?)`, randomUUID(), site.id, day, item, at);
  }
  const result = await request(`/api/dashboard?site_id=${site.id}`, { cookie: auth.cookies.owner });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.hours.map(week => [week.hours, week.hoursExact]), Array.from({ length: 6 }, () => [1.1, 1.06]));
  assert.equal(result.body.hoursCoverage.appBookedHours, 6.36);
  assert.equal(Number(result.body.hours.reduce((sum, week) => sum + week.hoursExact, 0).toFixed(2)), 6.36);
});

test('dashboard window includes empty recent workday weeks and matches the client union', async t => {
  const { db, close } = await openTestDb(); t.after(close);
  const auth = await authFixture(db), request = requestListener(createServer(db));
  const site = await createSite(db, { code: 'SYN-COVERAGE-EMPTY-WEEKS', name: 'Synthetic empty recent weeks' });
  await db.run('INSERT INTO site_members VALUES (?, ?, ?)', site.id, auth.users.owner.id, 'owner');
  const at = '2026-01-01T00:00:00.000Z', item = randomUUID();
  await db.run(`INSERT INTO site_progress_items (id, site_id, source_row, description, planned_hours, progress_pct, created_at)
    VALUES (?, ?, 1, 'Synthetic January progress', 100, 50, ?)`, item, site.id, at);
  const january = randomUUID();
  await db.run('INSERT INTO work_days (id, site_id, operational_date, created_at) VALUES (?, ?, ?, ?)', january, site.id, '2026-01-05', at);
  await db.run(`INSERT INTO time_bookings (id, site_id, work_day_id, site_progress_item_id, hours, created_at)
    VALUES (?, ?, ?, ?, 8, ?)`, randomUUID(), site.id, january, item, at);
  const recent = ['2026-02-02', '2026-02-09', '2026-02-16', '2026-02-23', '2026-03-02', '2026-03-09'];
  for (const date of recent) {
    await db.run('INSERT INTO work_days (id, site_id, operational_date, created_at) VALUES (?, ?, ?, ?)', randomUUID(), site.id, date, at);
  }
  const result = await request(`/api/dashboard?site_id=${site.id}`, { cookie: auth.cookies.owner });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.hours.map(week => [week.week, week.hours, week.hoursExact]), recent.map(week => [week, 0, 0]));
  assert.equal(result.body.hoursCoverage.appBookedHours, 8);
});
