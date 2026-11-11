import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createSite } from '../server/repository.mjs';
import { report } from '../server/report.mjs';
import { dashboard, STATUS_ORDER } from '../server/dashboard.mjs';
import { listSiteProgress } from '../server/site-progress.mjs';
import { createProgressType } from '../server/progress-types.mjs';
import { createServer } from '../server/http.mjs';
import { authFixture, requestListener } from './helpers/auth.mjs';
import { isPg, openTestDb, openSqliteTestDb } from './helpers/db.mjs';
import { siteProgressDatabase } from './helpers/site-progress.mjs';
import { createApi } from '../app/api.mjs';
import { messages } from '../app/i18n.mjs';

for (const driver of ['sqlite', 'pg']) test(`Report ${driver}`, async t => {
  let db;
  if (driver === 'pg' && !isPg) db = await siteProgressDatabase(t, driver);
  else {
    const database = await (driver === 'sqlite' ? openSqliteTestDb() : openTestDb());
    db = database.db; t.after(database.close);
  }
  const auth = await authFixture(db), api = requestListener(createServer(db));
  const fixture = async () => {
    const site = await createSite(db, { code: randomUUID(), name: 'Synthetic report site' });
    for (const role of ['owner', 'viewer']) await db.run('INSERT INTO site_members VALUES (?, ?, ?)', site.id, auth.users[role].id, role);
    let sourceRow = 0;
    const item = async (fields = {}) => {
      const id = randomUUID(), row = { section: 'Area Z', progress_pct: 99, ...fields };
      await db.run(`INSERT INTO site_progress_items (id, site_id, source_row, created_at, ${Object.keys(row).join(', ')})
        VALUES (?, ?, ?, ?, ${Object.keys(row).map(() => '?').join(', ')})`,
      id, site.id, ++sourceRow, '2026-01-01T00:00:00.000Z', ...Object.values(row));
      return id;
    };
    const deviation = async (area, status) => db.run(`INSERT INTO deviations (id, site_id, plc_area, status, created_at)
      VALUES (?, ?, ?, ?, ?)`, randomUUID(), site.id, area, status, '2026-01-01T00:00:00.000Z');
    const options = { siteId: site.id, user: auth.users.viewer };
    return { site, item, deviation, options, read: () => report(db, options) };
  };

  await t.test('shape, effective averages, planned values, source, status completeness and dashboard parity', async t => {
    const f = await fixture();
    const type = await createProgressType(db, { site_id: f.site.id, code: 'TYPE-A', name: 'Synthetic type',
      steps: [{ position: 1, code: 'S1', weight: 25 }, { position: 2, code: 'S2', weight: 75 }] }, auth.users.owner);
    const computed = await f.item({ progress_type_id: type.id, planned_progress_pct: 40 });
    await db.run(`INSERT INTO site_progress_item_steps (id, site_progress_item_id, progress_type_step_id, percent, updated_at)
      VALUES (?, ?, ?, 100, ?)`, randomUUID(), computed, type.steps[0].id, '2026-01-01T00:00:00.000Z');
    // Unrecorded S2 contributes zero: computed is 25, not 100 or the imported 99.
    await f.item({ progress_pct: 70, planned_progress_pct: 80 });
    await f.item({ section: null, plc_area: 'Area A', progress_type_id: type.id });
    for (const status of STATUS_ORDER) await f.deviation('Area Z', status);
    await f.deviation('Area A', 'closed');
    await f.deviation('Area A', null);
    const before = Date.now(), result = await f.read();
    t.assert.deepStrictEqual(Object.keys(result), ['site', 'generated_at', 'progress', 'deviations']);
    t.assert.deepStrictEqual(result.site, { code: f.site.code, name: f.site.name });
    t.assert.strictEqual(new Date(result.generated_at).toISOString(), result.generated_at);
    t.assert.ok(Date.parse(result.generated_at) >= before && Date.parse(result.generated_at) <= Date.now());
    t.assert.deepStrictEqual(result.progress, [
      { area: 'Area Z', items: 2, actual: 47.5, planned: 60, source: 'mixed' },
      { area: 'Area A', items: 1, actual: 0, planned: null, source: 'computed' },
    ]);
    t.assert.deepStrictEqual(result.deviations, [
      { area: 'Area Z', total: 6, open: 4, closed: 2, by_status: STATUS_ORDER.map(status => ({ status, count: 1 })) },
      { area: 'Area A', total: 2, open: 1, closed: 1, by_status: [
        ...STATUS_ORDER.map(status => ({ status, count: status === 'closed' ? 1 : 0 })), { status: null, count: 1 },
      ] },
    ]);
    for (const row of result.deviations) {
      t.assert.strictEqual(row.open + row.closed, row.total);
      t.assert.strictEqual(row.by_status.reduce((sum, entry) => sum + entry.count, 0), row.total);
    }
    const dash = await dashboard(db, f.options);
    t.assert.deepStrictEqual(Object.keys(dash), ['deviations', 'progress', 'hours', 'claims']);
    t.assert.deepStrictEqual(dash.progress, result.progress.map(({ area, items, actual, planned }) => ({ section: area, items, actual, planned })));
    t.assert.deepStrictEqual(dash.deviations, STATUS_ORDER.map(status => ({ status,
      count: result.deviations.reduce((sum, row) => sum + row.by_status.find(entry => entry.status === status).count, 0),
    })));
    const items = await listSiteProgress(db, { siteId: f.site.id });
    t.assert.strictEqual(items.find(row => row.id === computed).progress_pct, 25);
    t.assert.strictEqual(result.progress[0].actual,
      items.filter(row => row.section === 'Area Z').reduce((sum, row) => sum + row.progress_pct, 0) / 2);
    const http = await api(`/api/report?site_id=${f.site.id.toUpperCase()}`, { cookie: auth.cookies.viewer });
    t.assert.strictEqual(http.status, 200);
    t.assert.deepStrictEqual(http.body.progress, result.progress);
    t.assert.deepStrictEqual(http.body.deviations, result.deviations);
    t.assert.strictEqual(http.headers['cache-control'], 'no-store');
  });

  await t.test('nulls, rounding, fallback areas, alphabetical ties and all areas beyond dashboard limit', async t => {
    const f = await fixture();
    await f.item({ section: null, plc_area: null, progress_pct: null });
    await f.item({ section: '', plc_area: 'Must not replace empty section', progress_pct: null });
    for (const area of ['Area C', 'Area B', 'Area A', 'Area D', 'Area E', 'Area F', 'Area G']) {
      await f.item({ section: area, plc_area: 'Ignored area', progress_pct: 12.345, planned_progress_pct: 67.891 });
    }
    const result = await f.read();
    t.assert.deepStrictEqual(result.progress.map(row => row.area), ['', 'Area A', 'Area B', 'Area C', 'Area D', 'Area E', 'Area F', 'Area G', 'Senza sezione']);
    t.assert.deepStrictEqual(result.progress[0], { area: '', items: 1, actual: null, planned: null, source: 'imported' });
    t.assert.deepStrictEqual(result.progress[1], { area: 'Area A', items: 1, actual: 12.3, planned: 67.9, source: 'imported' });
    t.assert.deepStrictEqual(result.progress.at(-1), { area: 'Senza sezione', items: 1, actual: null, planned: null, source: 'imported' });
    const dash = await dashboard(db, f.options);
    t.assert.deepStrictEqual(dash.progress, result.progress.slice(0, 8).map(({ area, items, actual, planned }) => ({ section: area, items, actual, planned })));
    await f.deviation('Area B', 'open'); await f.deviation(null, null); await f.deviation('Area A', 'rejected');
    t.assert.deepStrictEqual((await f.read()).deviations.map(row => row.area), ['Area A', 'Area B', 'Senza sezione']);
  });

  await t.test('empty site and cross-site isolation', async t => {
    const other = await fixture();
    await other.item(); await other.deviation('Other area', 'open');
    const f = await fixture(), result = await f.read();
    t.assert.deepStrictEqual(result.progress, []);
    t.assert.deepStrictEqual(result.deviations, []);
    t.assert.deepStrictEqual(result.site, { code: f.site.code, name: f.site.name });
  });

  await t.test('401 unauthenticated, 400 invalid/missing site and 403 non-member, matching dashboard', async t => {
    const f = await fixture();
    for (const endpoint of ['report', 'dashboard']) {
      for (const [query, cookie, status, code] of [
        [`?site_id=${f.site.id}`, undefined, 401, 'AUTH_REQUIRED'],
        ['', auth.cookies.viewer, 400, 'VALIDATION_ERROR'],
        ['?site_id=invalid', auth.cookies.viewer, 400, 'VALIDATION_ERROR'],
        [`?site_id=${f.site.id}`, auth.cookies.verifier, 403, 'FORBIDDEN'],
      ]) {
        const response = await api(`/api/${endpoint}${query}`, { cookie });
        t.assert.strictEqual(response.status, status);
        t.assert.strictEqual(response.body.code, code);
      }
    }
    for (const read of [report, dashboard]) {
      await t.assert.rejects(() => read(db), { status: 401, code: 'UNAUTHENTICATED' });
      await t.assert.rejects(() => read(db, { user: auth.users.viewer }), { status: 400, code: 'VALIDATION_ERROR' });
      await t.assert.rejects(() => read(db, { ...f.options, siteId: 123 }), { status: 400, code: 'VALIDATION_ERROR' });
      await t.assert.rejects(() => read(db, { ...f.options, user: auth.users.verifier }), { status: 403, code: 'FORBIDDEN' });
    }
  });
});

test('Report API client preserves payload, uses credentials and fresh reads, and exposes errors', async t => {
  const payload = { site: { code: 'SYN', name: 'Synthetic site' }, generated_at: '2026-01-01T00:00:00.000Z', progress: [], deviations: [] };
  const api = createApi({ baseUrl: 'https://api.example.invalid', fresh: true, fetchImpl: async (url, options) => {
    t.assert.strictEqual(url, 'https://api.example.invalid/api/report?site_id=synthetic%20id');
    t.assert.strictEqual(options.credentials, 'include'); t.assert.strictEqual(options.cache, 'reload');
    return { ok: true, json: async () => payload };
  } });
  t.assert.deepStrictEqual(await api.report('synthetic id'), payload);
  const denied = createApi({ fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({ code: 'FORBIDDEN', error: 'Denied' }) }) });
  await t.assert.rejects(() => denied.report('synthetic'), { status: 403, code: 'FORBIDDEN' });
  const disconnected = createApi({ fetchImpl: async () => { throw new TypeError('Synthetic network error'); } });
  await t.assert.rejects(() => disconnected.report('synthetic'), { code: 'NETWORK_ERROR' });
});

test('Report UI entry points, translations and print rules are present without a browser', async t => {
  const app = await readFile(new URL('../app/app.mjs', import.meta.url), 'utf8');
  const css = await readFile(new URL('../app/styles.css', import.meta.url), 'utf8');
  t.assert.match(app, /heading\('overviewTitle'[\s\S]*?button\('reportPrint', 'open-report'\)/);
  t.assert.match(app, /view === 'progress' \? button\('reportPrint', 'open-report'\)/);
  t.assert.match(app, /report: renderReport/);
  t.assert.match(app, /freshApi\.report\(selected\)/);
  t.assert.match(app, /reportPrintIntent = null;\s*window\.print\(\)/);
  t.assert.match(css, /@page\s*\{\s*size: A4 portrait/);
  t.assert.match(css, /\.report-table tr\s*\{[^}]*break-inside: avoid/);
  t.assert.match(css, /#ai-fab, #ai-panel, #offline-banner, button, nav\s*\{\s*display: none !important/);
  for (const language of ['it', 'en']) for (const key of Object.keys(messages.it).filter(key => key.startsWith('report'))) {
    t.assert.ok(messages[language][key], `${language}: ${key}`);
  }
});
