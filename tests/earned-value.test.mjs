import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createSite } from '../server/repository.mjs';
import { earnedValue } from '../server/earned-value.mjs';
import { progressByArea } from '../server/dashboard.mjs';
import { createProgressType, assignProgressType, setStepProgress } from '../server/progress-types.mjs';
import { createServer } from '../server/http.mjs';
import { createApi } from '../app/api.mjs';
import { openTestDb } from './helpers/db.mjs';
import { authFixture, requestListener } from './helpers/auth.mjs';

test('Earned value: synthetic calculations and HTTP contract', async t => {
  const { db, close } = await openTestDb();
  t.after(close);
  const auth = await authFixture(db), api = requestListener(createServer(db));
  const at = '2026-01-01T00:00:00.000Z';
  const fixture = async () => {
    const site = await createSite(db, { code: randomUUID(), name: 'Synthetic earned value site' });
    for (const [role, user] of Object.entries(auth.users)) {
      await db.run('INSERT INTO site_members VALUES (?, ?, ?)', site.id, user.id, role);
    }
    let sourceRow = 0;
    const item = async (fields = {}) => {
      const id = randomUUID(), row = { section: 'Area A', progress_pct: 25, planned_progress_pct: 50, ...fields };
      await db.run(`INSERT INTO site_progress_items (id, site_id, source_row, created_at, ${Object.keys(row).join(', ')})
        VALUES (?, ?, ?, ?, ${Object.keys(row).map(() => '?').join(', ')})`,
      id, site.id, ++sourceRow, at, ...Object.values(row));
      return id;
    };
    const wbs = async plannedHours => {
      const id = randomUUID();
      await db.run(`INSERT INTO project_structure (id, site_id, wbs_code, level, planned_hours, created_at)
        VALUES (?, ?, ?, 0, ?, ?)`, id, site.id, id, plannedHours, at);
      return id;
    };
    const book = async (itemId, hours) => {
      const day = randomUUID();
      await db.run('INSERT INTO work_days (id, site_id, operational_date, created_at) VALUES (?, ?, ?, ?)',
        day, site.id, '2026-01-01', at);
      await db.run(`INSERT INTO time_bookings (id, site_id, work_day_id, site_progress_item_id, hours, created_at)
        VALUES (?, ?, ?, ?, ?, ?)`, randomUUID(), site.id, day, itemId, hours, at);
    };
    return { site, item, wbs, book, read: () => earnedValue(db, { siteId: site.id }) };
  };
  const patch = (id, body, role = 'owner') => api(`/api/site-progress/${id}`, {
    method: 'PATCH', body, ...(role ? { cookie: auth.cookies[role] } : {}),
  });

  await t.test('EV/PV/AC, weighted actual progress, missing hours and section CPI', async () => {
    const f = await fixture();
    const imported = await f.item({ planned_hours: 120 });
    const computed = await f.item({ section: 'Area B', planned_hours: 80, progress_pct: 99, planned_progress_pct: 80 });
    const missing = await f.item({ section: 'Area C', progress_pct: 100 });
    const type = await createProgressType(db, { site_id: f.site.id, code: 'WEIGHTED', name: 'Synthetic weighted type',
      steps: [{ code: 'S1', position: 1, weight: 60 }, { code: 'S2', position: 2, weight: 40 }] }, auth.users.owner);
    await assignProgressType(db, computed, type.id, auth.users.owner);
    await setStepProgress(db, computed, [{ step_id: type.steps[0].id, percent: 100 }], auth.users.editor);
    await f.book(imported, 17.5); await f.book(computed, 12.5); await f.book(missing, 10);
    assert.deepEqual(await f.read(), {
      available: true, bac_hours: 200, ev_hours: 78, pv_hours: 124, ac_hours: 40, cpi: 1.95, spi: 0.63,
      items_total: 3, items_without_hours: 1, by_section: [
        { section: 'Area A', ev_hours: 30, pv_hours: 60, bac_hours: 120, cpi: 1.71 },
        { section: 'Area B', ev_hours: 48, pv_hours: 64, bac_hours: 80, cpi: 3.84 },
        { section: 'Area C', ev_hours: null, pv_hours: null, bac_hours: null, cpi: null },
      ],
    });
    assert.equal((await progressByArea(db, f.site.id)).find(row => row.area === 'Area B').actual, 60);
  });

  await t.test('WBS fallback, explicit override and zero hours remain distinct from missing', async () => {
    const f = await fixture(), wbsId = await f.wbs(200);
    await f.item({ wbs_id: wbsId });
    await f.item({ wbs_id: wbsId, planned_hours: 40 });
    await f.item({ wbs_id: wbsId, planned_hours: 0 });
    const result = await f.read();
    assert.equal(result.bac_hours, 240); assert.equal(result.ev_hours, 60); assert.equal(result.pv_hours, 120);
    assert.equal(result.items_without_hours, 0); assert.equal(result.cpi, null); assert.equal(result.spi, 0.5);
  });

  await t.test('no hours yields unavailable and null planned metrics while preserving actual bookings', async () => {
    const f = await fixture(), item = await f.item();
    await f.book(item, 4.5);
    assert.deepEqual(await f.read(), {
      available: false, reason: 'NO_PLANNED_HOURS', bac_hours: null, ev_hours: null, pv_hours: null,
      ac_hours: 4.5, cpi: null, spi: null, items_total: 1, items_without_hours: 1,
      by_section: [{ section: 'Area A', ev_hours: null, pv_hours: null, bac_hours: null, cpi: null }],
    });
    const empty = await fixture(), result = await empty.read();
    assert.equal(result.available, false); assert.equal(result.reason, 'NO_PLANNED_HOURS');
    assert.equal(result.items_total, 0); assert.equal(result.items_without_hours, 0);
    assert.equal(result.ac_hours, 0); assert.deepEqual(result.by_section, []);
  });

  await t.test('round only after aggregation; ratios use unrounded totals', async () => {
    const f = await fixture();
    const item = await f.item({ planned_hours: 0.014, progress_pct: 50, planned_progress_pct: 100 });
    await f.book(item, 0.003);
    const first = await f.read();
    assert.equal(first.bac_hours, 0.01); assert.equal(first.ev_hours, 0.01); assert.equal(first.pv_hours, 0.01);
    assert.equal(first.cpi, 2.33); assert.equal(first.spi, 0.5);
    await f.item({ planned_hours: 0.014, progress_pct: 50, planned_progress_pct: 100 });
    const both = await f.read();
    assert.equal(both.ev_hours, 0.01); assert.equal(both.pv_hours, 0.03); assert.equal(both.cpi, 4.67);
  });

  await t.test('zero denominators and unknown percentages do not invent ratios or progress', async () => {
    const f = await fixture();
    const item = await f.item({ planned_hours: 40, progress_pct: null, planned_progress_pct: null });
    const unknown = await f.read();
    assert.equal(unknown.available, true); assert.equal(unknown.ev_hours, null); assert.equal(unknown.pv_hours, null);
    assert.equal(unknown.cpi, null); assert.equal(unknown.spi, null);
    await db.run('UPDATE site_progress_items SET progress_pct = 0, planned_progress_pct = 0 WHERE id = ?', item);
    const zero = await f.read();
    assert.equal(zero.ev_hours, 0); assert.equal(zero.pv_hours, 0); assert.equal(zero.cpi, null); assert.equal(zero.spi, null);
    await db.run('UPDATE site_progress_items SET planned_hours = 0 WHERE id = ?', item);
    assert.equal((await f.read()).available, true);
  });

  await t.test('site scoping, area fallback and multiple bookings do not duplicate planned values', async () => {
    const other = await fixture(), foreign = await other.item({ planned_hours: 9000 });
    await other.book(foreign, 1000);
    const f = await fixture(), item = await f.item({ section: null, plc_area: 'Area fallback', planned_hours: 100 });
    await f.book(item, 5); await f.book(item, 15);
    await f.item({ section: null, plc_area: null });
    const result = await f.read();
    assert.equal(result.bac_hours, 100); assert.equal(result.ac_hours, 20); assert.equal(result.items_total, 2);
    assert.deepEqual(result.by_section.map(row => row.section), ['Area fallback', 'Senza sezione']);
    assert.equal(result.by_section[0].cpi, 1.25);
  });

  await t.test('PATCH accepts finite hours and null; public list/detail expose numbers', async () => {
    const f = await fixture(), item = await f.item({ wbs_id: await f.wbs(80) });
    for (const [role, value] of [['owner', 45.75], ['editor', 1e6], ['editor', 0]]) {
      const response = await patch(item, { planned_hours: value }, role);
      assert.equal(response.status, 200); assert.equal(response.body.planned_hours, value);
    }
    const cleared = await patch(item, { planned_hours: null }, 'editor');
    assert.equal(cleared.status, 200); assert.equal(cleared.body.planned_hours, null);
    assert.equal((await f.read()).bac_hours, 80);
    await patch(item, { planned_hours: 12.34 });
    const detail = await api(`/api/site-progress/${item}`, { cookie: auth.cookies.viewer });
    const list = await api(`/api/site-progress?site_id=${f.site.id}`, { cookie: auth.cookies.viewer });
    assert.equal(detail.body.planned_hours, 12.34); assert.equal(list.body[0].planned_hours, 12.34);
  });

  await t.test('PATCH rejects invalid payloads atomically and enforces roles and membership', async () => {
    const f = await fixture(), item = await f.item({ planned_hours: 50 });
    for (const body of [{ planned_hours: -1 }, { planned_hours: 1000000.01 }, { planned_hours: '30' },
      { planned_hours: true }, {}, { other: 10 }, { planned_hours: 20, progress_pct: 90 }]) {
      const response = await patch(item, body);
      assert.equal(response.status, 400); assert.equal(response.body.code, 'VALIDATION_ERROR');
    }
    for (const body of [null, []]) assert.equal((await patch(item, body)).status, 400);
    for (const role of ['viewer', 'verifier']) assert.equal((await patch(item, { planned_hours: 20 }, role)).status, 403);
    assert.equal((await patch(item, { planned_hours: 20 }, null)).status, 401);
    await db.run('DELETE FROM site_members WHERE site_id = ? AND user_id = ?', f.site.id, auth.users.editor.id);
    assert.equal((await patch(item, { planned_hours: 20 }, 'editor')).status, 403);
    assert.equal((await db.get('SELECT planned_hours FROM site_progress_items WHERE id = ?', item)).planned_hours, 50);
    assert.equal((await patch(randomUUID(), { planned_hours: 20 })).status, 404);
  });

  await t.test('dashboard/report endpoints expose the exact module block for available and unavailable sites', async () => {
    const f = await fixture();
    const item = await f.item();
    for (const value of [null, 200]) {
      await patch(item, { planned_hours: value });
      const expected = await f.read();
      for (const endpoint of ['dashboard', 'report']) {
        const response = await api(`/api/${endpoint}?site_id=${f.site.id}`, { cookie: auth.cookies.viewer });
        assert.equal(response.status, 200); assert.deepEqual(response.body.earnedValue, expected);
        assert.equal(response.headers['cache-control'], 'no-store');
      }
    }
  });
});

test('Progress API client PATCH preserves null and maps planned hours on readback', async () => {
  const calls = [];
  const api = createApi({ baseUrl: '/', fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => ({ id: 'synthetic', planned_hours: JSON.parse(options.body).planned_hours }) };
  } });
  assert.equal((await api.updateProgress('synthetic', { planned_hours: 12.5 })).plannedHours, 12.5);
  assert.equal((await api.updateProgress('synthetic', { planned_hours: null })).plannedHours, null);
  assert.equal(calls[0].url, '/api/site-progress/synthetic');
  assert.equal(calls[0].options.method, 'PATCH'); assert.equal(calls[0].options.credentials, 'include');
  assert.deepEqual(JSON.parse(calls[1].options.body), { planned_hours: null });
});
