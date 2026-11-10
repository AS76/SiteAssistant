import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createSite, RepositoryError } from '../server/repository.mjs';
import { progressCurve } from '../server/progress-curve.mjs';
import { createProgressType, assignProgressType } from '../server/progress-types.mjs';
import { createServer } from '../server/http.mjs';
import { authFixture, requestListener } from './helpers/auth.mjs';
import { isPg, openTestDb, openSqliteTestDb } from './helpers/db.mjs';
import { siteProgressDatabase } from './helpers/site-progress.mjs';

for (const driver of ['sqlite', 'pg']) test(`Progress curve ${driver}`, async t => {
  let db;
  if (driver === 'pg' && !isPg) db = await siteProgressDatabase(t, driver);
  else {
    const database = await (driver === 'sqlite' ? openSqliteTestDb() : openTestDb());
    db = database.db; t.after(database.close);
  }
  const auth = await authFixture(db);
  const api = requestListener(createServer(db));
  const fixture = async () => {
    const site = await createSite(db, { code: randomUUID(), name: 'Synthetic curve site' });
    for (const role of ['owner', 'editor', 'viewer']) {
      await db.run('INSERT INTO site_members VALUES (?, ?, ?)', site.id, auth.users[role].id, role);
    }
    let sourceRow = 0;
    const item = async (fields = {}) => {
      const id = randomUUID();
      const row = { section: 'Linea A', progress_pct: 99, ...fields };
      const keys = Object.keys(row);
      await db.run(`INSERT INTO site_progress_items (id, site_id, source_row, created_at, ${keys.join(', ')})
        VALUES (?, ?, ?, ?, ${keys.map(() => '?').join(', ')})`,
      id, site.id, ++sourceRow, '2026-01-01T00:00:00.000Z', ...Object.values(row));
      return id;
    };
    const type = () => createProgressType(db, { site_id: site.id, code: randomUUID(), name: 'Synthetic type',
      steps: [{ position: 1, code: 'S1', weight: 25 }, { position: 2, code: 'S2', weight: 75 }] }, auth.users.owner);
    const entry = (itemId, stepId, percent, at, { id = randomUUID(), siteId = site.id } = {}) => db.run(
      `INSERT INTO progress_entries (id, site_id, site_progress_item_id, progress_type_step_id, percent, recorded_at)
        VALUES (?, ?, ?, ?, ?, ?)`, id, siteId, itemId, stepId, percent, at);
    const curve = (options = {}) => progressCurve(db, { siteId: site.id, user: auth.users.viewer,
      from: '2026-01-01', to: '2026-01-05', ...options });
    return { site, item, type, entry, curve };
  };

  await t.test('planned ramp includes before/start/interior/finish/after and rounds once', async t => {
    const f = await fixture();
    await f.item({ planned_start: '2026-01-02T00:00:00Z', planned_finish: '2026-01-05T00:00:00Z', planned_progress_pct: 80 });
    t.assert.deepStrictEqual(await f.curve({ to: '2026-01-06' }), {
      from: '2026-01-01', to: '2026-01-06', series: [{ section: 'Linea A', points: [
        { date: '2026-01-01', planned: 0 }, { date: '2026-01-02', planned: 0 },
        { date: '2026-01-03', planned: 26.7 }, { date: '2026-01-04', planned: 53.3 },
        { date: '2026-01-05', planned: 80 }, { date: '2026-01-06', planned: 80 },
      ] }],
    });
  });

  await t.test('section means, null target, zero target, null dates and COALESCE fallbacks', async t => {
    const f = await fixture();
    await f.item({ planned_start: '2026-01-01', planned_finish: '2026-01-03', planned_progress_pct: null });
    await f.item({ planned_start: '2026-01-01', planned_finish: '2026-01-03', planned_progress_pct: 40 });
    await f.item({ planned_start: '2026-01-01', planned_finish: '2026-01-03', planned_progress_pct: 0 });
    await f.item({ planned_start: null, planned_finish: '2026-01-03' });
    await f.item({ planned_start: '2026-01-01', planned_finish: null });
    await f.item({ section: null, plc_area: 'Area B' });
    await f.item({ section: null, plc_area: null });
    await f.item({ section: '', plc_area: 'Must not replace an empty section' });
    const result = await f.curve({ from: '2026-01-02', to: '2026-01-02' });
    t.assert.deepStrictEqual(result.series, [
      { section: '', points: [{ date: '2026-01-02' }] },
      { section: 'Area B', points: [{ date: '2026-01-02' }] },
      { section: 'Linea A', points: [{ date: '2026-01-02', planned: 23.3 }] },
      { section: 'Senza sezione', points: [{ date: '2026-01-02' }] },
    ]);
  });

  await t.test('UTC planned calendar days, same-day milestone and reversed dates', async t => {
    const f = await fixture();
    await f.item({ planned_start: '2026-01-01T23:00:00-02:00', planned_finish: '2026-01-03T01:00:00+02:00' });
    await f.item({ section: 'Reversed', planned_start: '2026-01-03', planned_finish: '2026-01-01' });
    const result = await f.curve({ to: '2026-01-03' });
    t.assert.deepStrictEqual(result.series, [
      { section: 'Linea A', points: [{ date: '2026-01-01', planned: 0 },
        { date: '2026-01-02', planned: 100 }, { date: '2026-01-03', planned: 100 }] },
      { section: 'Reversed', points: [{ date: '2026-01-01' }, { date: '2026-01-02' }, { date: '2026-01-03' }] },
    ]);
  });

  await t.test('last recorded step values win, unequal weights, missing data and UTC end of day', async t => {
    const f = await fixture(), type = await f.type();
    const item = await f.item({ progress_type_id: type.id });
    const empty = await f.item({ progress_type_id: type.id });
    await f.item(); // Imported 99 with no type must not contribute.
    await f.item({ section: 'Empty', progress_type_id: type.id });
    // The mutable step snapshot is deliberately inconsistent with history.
    await db.run(`INSERT INTO site_progress_item_steps
      (id, site_progress_item_id, progress_type_step_id, percent, updated_at) VALUES (?, ?, ?, 100, ?)`,
    randomUUID(), empty, type.steps[0].id, '2026-01-01T00:00:00Z');
    await f.entry(item, type.steps[0].id, 40, '2026-01-02T00:00:00Z');
    await f.entry(item, type.steps[1].id, 20, '2026-01-03T10:00:00Z');
    await f.entry(item, type.steps[0].id, 80, '2026-01-03T23:59:59.999Z');
    await f.entry(item, type.steps[0].id, 100, '2026-01-03T22:00:00-02:00');
    await f.entry(item, type.steps[1].id, 100, '2026-01-06T00:00:00Z');
    const result = await f.curve();
    t.assert.deepStrictEqual(result.series.find(row => row.section === 'Linea A').points, [
      { date: '2026-01-01' }, { date: '2026-01-02', actual: 40 },
      { date: '2026-01-03', actual: 35 }, { date: '2026-01-04', actual: 40 },
      { date: '2026-01-05', actual: 40 },
    ]);
    t.assert.ok(result.series.find(row => row.section === 'Empty').points.every(point => !('actual' in point)));
    t.assert.deepStrictEqual((await f.curve({ from: '2026-01-04' })).series.find(row => row.section === 'Linea A').points,
      [{ date: '2026-01-04', actual: 40 }, { date: '2026-01-05', actual: 40 }]);
  });

  await t.test('section actual is an item mean, preserves recorded zero, and carries old history', async t => {
    const f = await fixture(), type = await f.type();
    const first = await f.item({ progress_type_id: type.id });
    const second = await f.item({ progress_type_id: type.id });
    await f.item({ progress_type_id: type.id });
    await f.entry(first, type.steps[0].id, 80, '2025-12-01T00:00:00Z');
    await f.entry(first, type.steps[1].id, 20, '2025-12-01T00:00:00Z');
    await f.entry(second, type.steps[0].id, 0, '2026-01-02T12:00:00Z');
    await f.entry(second, type.steps[0].id, 80, '2026-01-03T12:00:00Z');
    t.assert.deepStrictEqual((await f.curve({ to: '2026-01-03' })).series[0].points, [
      { date: '2026-01-01', actual: 35 }, { date: '2026-01-02', actual: 17.5 },
      { date: '2026-01-03', actual: 57.5 },
    ]);
  });

  await t.test('uses current assigned type only and isolates sites, including mismatched history', async t => {
    const f = await fixture(), other = await fixture();
    const oldType = await f.type(), currentType = await f.type(), foreignType = await other.type();
    const item = await f.item({ progress_type_id: oldType.id });
    await f.entry(item, oldType.steps[0].id, 100, '2025-12-01T00:00:00Z');
    await assignProgressType(db, item, currentType.id, auth.users.owner);
    await f.entry(item, currentType.steps[0].id, 20, '2026-01-01T00:00:00Z');
    await f.entry(item, currentType.steps[0].id, 90, '2026-01-02T00:00:00Z', { siteId: other.site.id });
    const foreignItem = await other.item({ progress_type_id: foreignType.id });
    await other.entry(foreignItem, foreignType.steps[0].id, 100, '2026-01-01T00:00:00Z');
    t.assert.ok((await f.curve()).series[0].points.every(point => point.actual === 20));
    await assignProgressType(db, item, null, auth.users.owner);
    t.assert.ok((await f.curve()).series[0].points.every(point => !('actual' in point)));
  });

  await t.test('identical recording timestamps resolve deterministically by UUID', async t => {
    const f = await fixture(), type = await f.type();
    const item = await f.item({ progress_type_id: type.id });
    await f.entry(item, type.steps[0].id, 70, '2026-01-01T00:00:00Z', { id: 'ffffffff-ffff-4fff-8fff-ffffffffffff' });
    await f.entry(item, type.steps[0].id, 30, '2026-01-01T00:00:00Z', { id: '00000000-0000-4000-8000-000000000000' });
    t.assert.strictEqual((await f.curve()).series[0].points[0].actual, 70);
  });

  await t.test('400 inclusive days accepted, 401 rejected, strict dates and reversed range rejected', async t => {
    const f = await fixture();
    await f.item();
    const start = '2026-01-01', end = days => new Date(Date.parse(start) + days * 86_400_000).toISOString().slice(0, 10);
    t.assert.strictEqual((await f.curve({ from: start, to: end(399) })).series[0].points.length, 400);
    for (const options of [
      { from: start, to: end(400) }, { from: '2026-02-30' }, { from: '2026-01-06' },
      { from: '' }, { to: '' }, { from: '2026-1-01' }, { to: 'invalid' },
      { from: '2026-01-01T00:00:00Z' }, { to: '2026-13-01' }, { from: '0000-01-01' },
    ]) await t.assert.rejects(f.curve(options), error => error instanceof RepositoryError && error.status === 400);
    t.assert.strictEqual((await f.curve({ from: '2028-02-28', to: '2028-03-01' })).series[0].points.length, 3);
  });

  await t.test('default is 90 inclusive days ending today UTC; partial bounds and empty site', async t => {
    const f = await fixture();
    t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2028-03-01T23:59:00Z') });
    t.assert.deepStrictEqual(await f.curve({ from: undefined, to: undefined }),
      { from: '2027-12-03', to: '2028-03-01', series: [] });
    await f.item();
    const defaulted = await f.curve({ from: undefined, to: undefined });
    t.assert.strictEqual(defaulted.series[0].points.length, 90);
    t.assert.strictEqual((await f.curve({ from: undefined, to: '2026-03-31' })).from, '2026-01-01');
    t.assert.strictEqual((await f.curve({ from: '2028-03-01', to: undefined })).series[0].points.length, 1);
  });

  await t.test('HTTP route allows viewers, requires authentication and membership, validates UUID and range', async t => {
    const f = await fixture();
    await f.item({ planned_start: '2026-01-01', planned_finish: '2026-01-05' });
    const path = `/api/progress/curve?site_id=${f.site.id.toUpperCase()}&from=2026-01-01&to=2026-01-05`;
    const read = await api(path, { cookie: auth.cookies.viewer });
    t.assert.strictEqual(read.status, 200);
    t.assert.deepStrictEqual(read.body, await f.curve());
    t.assert.strictEqual((await api(path)).status, 401);
    t.assert.strictEqual((await api(path, { cookie: auth.cookies.verifier })).status, 403);
    for (const query of ['site_id=wrong', 'site_id=', '', `site_id=${f.site.id}&from=bad`,
      `site_id=${f.site.id}&from=2026-01-01&to=2027-02-05`]) {
      const result = await api(`/api/progress/curve?${query}`, { cookie: auth.cookies.viewer });
      t.assert.strictEqual(result.status, 400);
      t.assert.strictEqual(result.body.code, 'VALIDATION_ERROR');
    }
    await t.assert.rejects(f.curve({ user: auth.users.verifier }), { status: 403 });
    await t.assert.rejects(f.curve({ siteId: 'wrong' }), { status: 400 });
    await t.assert.rejects(f.curve({ user: null }), { status: 401 });
  });
});
