import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createContext, runInContext } from 'node:vm';
import { deviationReconciliation, reconcileDeviationRows } from '../server/deviation-reconciliation.mjs';
import { createSite } from '../server/repository.mjs';
import { report } from '../server/report.mjs';
import { createServer } from '../server/http.mjs';
import { createApi } from '../app/api.mjs';
import { messages } from '../app/i18n.mjs';
import { authFixture, requestListener } from './helpers/auth.mjs';
import { wbsDatabase } from './helpers/wbs.mjs';

const kinds = ['closed_without_date', 'close_before_approval', 'status_gap'];
const at = day => `2026-01-${String(day).padStart(2, '0')}T00:00:00.000000Z`;
const synthetic = (fields = {}) => ({ id: randomUUID(), deviation_no: 'SYN-001', title: 'Synthetic deviation',
  status: 'open', creation_date: at(1), approved_date: null, closed_date: null, ...fields });
function consistent(result) {
  assert.equal(Object.values(result.counts).reduce((sum, count) => sum + count, 0), result.items.length);
  for (const kind of kinds) assert.equal(result.counts[kind], result.items.filter(row => row.kind === kind).length);
}

test('reconciliation calculates all three cases without mutation; a deviation can have multiple findings', () => {
  const rows = [synthetic({ status: 'closed' }), synthetic({ closed_date: at(2), approved_date: at(3) }),
    synthetic({ status: 'closed', closed_date: at(4), approved_date: at(5), internal_status: 'open', internal_updated_at: at(1) })];
  const before = structuredClone(rows), result = reconcileDeviationRows(rows);
  assert.deepEqual(result.counts, { closed_without_date: 1, close_before_approval: 2, status_gap: 1 });
  assert.deepEqual(rows, before); consistent(result);
  const gap = result.items.find(row => row.kind === 'status_gap');
  assert.deepEqual(gap, { kind: 'status_gap', id: rows[2].id, deviation_no: 'SYN-001', title: 'Synthetic deviation',
    official_status: 'closed', internal_status: 'open', internal_updated_at: at(1), disagreement_days: 3 });
  assert.equal(result.items[0].disagreement_days, null);
});

test('equal dates are valid; comparisons preserve microseconds and equivalent offsets', () => {
  const result = reconcileDeviationRows([
    synthetic({ closed_date: at(3), approved_date: at(3) }),
    synthetic({ closed_date: '2026-01-03T01:00:00+01:00', approved_date: at(3) }),
    synthetic({ closed_date: '2026-01-03T00:00:00.000001Z', approved_date: '2026-01-03T00:00:00.000002Z' }),
  ]);
  assert.equal(result.counts.close_before_approval, 1);
  assert.ok(result.items[0].disagreement_days > 0); consistent(result);
});

test('status gap includes exactly 3 days, excludes 2 days and just below 3, uses absolute elapsed days', () => {
  for (const [official, internal, expected] of [[at(4), at(1), 1], [at(3), at(1), 0],
    [at(1), at(4), 1], ['2026-01-03T23:59:59.999999Z', at(1), 0]]) {
    const result = reconcileDeviationRows([synthetic({ status: 'approved', approved_date: official,
      internal_status: 'open', internal_updated_at: internal })]);
    assert.equal(result.counts.status_gap, expected); consistent(result);
  }
});

test('imported-only, matching statuses, unknown statuses and missing/ambiguous dates do not imply status gaps', () => {
  for (const fields of [
    { created_at: at(1) },
    { internal_status: 'approved', internal_updated_at: at(1) },
    { status: null, internal_status: 'open', internal_updated_at: at(1) },
    { internal_status: 'open' },
    { internal_status: 'open', internal_updated_at: '2026-01-01 00:00:00' },
    { internal_status: 'open', internal_updated_at: 'invalid' },
    { approved_date: null, internal_status: 'open', internal_updated_at: at(1) },
    { status: 'in_progress', internal_status: 'open', internal_updated_at: at(1) },
  ]) assert.equal(reconcileDeviationRows([synthetic({ status: 'approved', approved_date: at(8), ...fields })]).counts.status_gap, 0);
  assert.deepEqual(reconcileDeviationRows([]), { counts: { closed_without_date: 0, close_before_approval: 0, status_gap: 0 }, items: [] });
});

for (const driver of ['sqlite', 'pg']) test(`reconciliation ${driver}: authorized reads, HTTP, report and site isolation`, async t => {
  const db = await wbsDatabase(t, driver), auth = await authFixture(db);
  const site = await createSite(db, { code: randomUUID(), name: 'Synthetic reconciliation site' });
  const other = await createSite(db, { code: randomUUID(), name: 'Other synthetic site' });
  for (const role of ['owner', 'editor', 'viewer']) await db.run('INSERT INTO site_members VALUES (?, ?, ?)', site.id, auth.users[role].id, role);
  const insert = async (siteId, fields) => {
    const row = synthetic(fields);
    await db.run(`INSERT INTO deviations (id, site_id, deviation_no, title, status, creation_date, approved_date, closed_date, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, row.id, siteId, row.deviation_no, row.title, row.status,
    row.creation_date, row.approved_date, row.closed_date, at(1));
    return row;
  };
  const closed = await insert(site.id, { deviation_no: 'SYN-A', status: 'closed' });
  await insert(site.id, { deviation_no: 'SYN-B', closed_date: at(2), approved_date: at(4) });
  await insert(site.id, { deviation_no: 'SYN-C', closed_date: at(4), approved_date: at(4) });
  await insert(other.id, { deviation_no: 'SYN-A', status: 'closed' });
  const api = requestListener(createServer(db)), path = `/api/deviations/reconciliation?site_id=${site.id}`;
  const read = user => deviationReconciliation(db, { siteId: site.id.toUpperCase() }, user);

  await t.test('viewer reads every finding; no domain writes and no inferred internal state', async () => {
    const before = await db.all('SELECT * FROM deviations ORDER BY id');
    const readOnly = { get: db.get.bind(db), all: db.all.bind(db) };
    const result = await deviationReconciliation(readOnly, { siteId: site.id }, auth.users.viewer);
    assert.deepEqual(result.counts, { closed_without_date: 1, close_before_approval: 1, status_gap: 0 });
    assert.equal(result.history_source, 'unavailable'); consistent(result);
    assert.equal(result.items[0].id, closed.id);
    assert.ok(result.items.every(row => row.internal_status === null && row.internal_updated_at === null));
    assert.deepEqual(await db.all('SELECT * FROM deviations ORDER BY id'), before);
    for (const role of ['owner', 'editor', 'viewer']) assert.deepEqual(await read(auth.users[role]), result);
    await db.run('INSERT INTO site_members VALUES (?, ?, ?)', site.id, auth.users.verifier.id, 'verifier');
    assert.deepEqual(await read(auth.users.verifier), result);
    await db.run('DELETE FROM site_members WHERE site_id = ? AND user_id = ?', site.id, auth.users.verifier.id);
  });

  await t.test('endpoint shape and report match; existing detail and list routes still work', async () => {
    const response = await api(path, { cookie: auth.cookies.viewer });
    assert.equal(response.status, 200); consistent(response.body);
    assert.deepEqual(Object.keys(response.body), ['counts', 'items', 'history_source']);
    assert.deepEqual(response.body, await read(auth.users.viewer));
    assert.deepEqual((await report(db, { siteId: site.id, user: auth.users.viewer })).reconciliation, response.body);
    assert.equal((await api(`/api/deviations/${closed.id}`, { cookie: auth.cookies.viewer })).body.id, closed.id);
    assert.equal((await api(`/api/deviations?site_id=${site.id}`, { cookie: auth.cookies.viewer })).body.length, 3);
  });

  await t.test('non-member is 403; denied module is MODULE_FORBIDDEN for endpoint and report', async () => {
    await assert.rejects(() => read(auth.users.verifier), { status: 403, code: 'FORBIDDEN' });
    assert.equal((await api(path, { cookie: auth.cookies.verifier })).status, 403);
    await db.run(`INSERT INTO member_module_access (id, site_id, user_id, module, allowed, created_at, updated_at)
      VALUES (?, ?, ?, 'deviations', FALSE, ?, ?)`, randomUUID(), site.id, auth.users.viewer.id, at(1), at(1));
    await assert.rejects(() => read(auth.users.viewer), { status: 403, code: 'MODULE_FORBIDDEN' });
    const denied = await api(path, { cookie: auth.cookies.viewer });
    assert.equal(denied.status, 403); assert.equal(denied.body.code, 'MODULE_FORBIDDEN');
    await assert.rejects(() => report(db, { siteId: site.id, user: auth.users.viewer }), { code: 'MODULE_FORBIDDEN' });
    await db.run('DELETE FROM member_module_access WHERE site_id = ?', site.id);
  });

  await t.test('authentication and validation precede data reads', async () => {
    await assert.rejects(() => read(null), { status: 401, code: 'UNAUTHENTICATED' });
    assert.equal((await api(path)).status, 401);
    for (const siteId of [undefined, '', 'invalid', 123]) await assert.rejects(
      () => deviationReconciliation(db, { siteId }, auth.users.viewer), { status: 400, code: 'VALIDATION_ERROR' });
    for (const suffix of ['', '?site_id=invalid']) assert.equal((await api(`/api/deviations/reconciliation${suffix}`, { cookie: auth.cookies.viewer })).status, 400);
  });

  await t.test('site scope is preserved even with equal deviation numbers and more than 200 findings', async () => {
    await assert.rejects(() => deviationReconciliation(db, { siteId: other.id }, auth.users.viewer), { status: 403 });
    await db.run('INSERT INTO site_members VALUES (?, ?, ?)', other.id, auth.users.viewer.id, 'viewer');
    assert.equal((await deviationReconciliation(db, { siteId: other.id }, auth.users.viewer)).items.length, 1);
    for (let index = 0; index < 201; index++) await insert(site.id, { deviation_no: `SYN-X${index}`, status: 'closed' });
    const result = (await api(path, { cookie: auth.cookies.viewer })).body;
    assert.equal(result.counts.closed_without_date, 202); assert.equal(result.items.length, 203); consistent(result);
    assert.equal((await deviationReconciliation(db, { siteId: other.id }, auth.users.viewer)).items.length, 1);
  });
});

test('reconciliation client encodes site, preserves payload and exposes access/network errors', async () => {
  const payload = { ...reconcileDeviationRows([synthetic({ status: 'closed' })]), history_source: 'unavailable' };
  const api = createApi({ baseUrl: 'https://api.example.invalid', fresh: true, fetchImpl: async (url, options) => {
    assert.equal(url, 'https://api.example.invalid/api/deviations/reconciliation?site_id=site+%2F%26');
    assert.equal(options.credentials, 'include'); assert.equal(options.cache, 'reload');
    assert.equal(options.method, undefined); return Response.json(payload);
  } });
  assert.deepEqual(await api.deviationReconciliation('site /&'), payload);
  const denied = createApi({ fetchImpl: async () => Response.json({ error: 'Denied', code: 'MODULE_FORBIDDEN' }, { status: 403 }) });
  await assert.rejects(() => denied.deviationReconciliation('synthetic'), { status: 403, code: 'MODULE_FORBIDDEN' });
  const disconnected = createApi({ fetchImpl: async () => { throw new TypeError('Synthetic network failure'); } });
  await assert.rejects(() => disconnected.deviationReconciliation('synthetic'), { code: 'NETWORK_ERROR' });
});

test('UI renders filters, detail references, empty state, escaped text and bounded printable findings in IT/EN', async () => {
  const source = await readFile(new URL('../app/app.mjs', import.meta.url), 'utf8');
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  const data = { ...reconcileDeviationRows([synthetic({ title: '<script>synthetic</script>', status: 'closed' }),
    synthetic({ deviation_no: 'SYN-002', closed_date: at(1), approved_date: at(2) })]), history_source: 'unavailable' };
  for (const language of ['it', 'en']) {
    const t = key => { assert.ok(messages[language][key], `${language}: ${key}`); return messages[language][key]; };
    const context = createContext({ data, reconciliationFilter: '', reconciliationOpen: true, t, esc,
      coreData: () => data, coreValue: value => esc(value ?? t('coreUnknown')), coreNumber: value => value == null ? t('coreUnknown') : String(value),
      coreStatus: value => esc(t(value || 'coreUnknown')) });
    runInContext(source.slice(source.indexOf('function coreTable('), source.indexOf('function progressBar(')), context);
    runInContext(source.slice(source.indexOf('const RECONCILIATION_KINDS'), source.indexOf('function renderDeviations(')), context);
    let html = runInContext('renderReconciliation()', context);
    assert.match(html, /<details[^>]*open/); assert.equal((html.match(/data-command="reconciliation-filter"/g) || []).length, 3);
    assert.match(html, /data-command="core-detail" data-module="deviations"/);
    assert.ok(html.includes(esc(data.items[0].id))); assert.match(html, /&lt;script&gt;synthetic&lt;\/script&gt;/);
    assert.ok(html.includes(t('reconciliationReadOnly'))); assert.ok(html.includes(t('reconciliationNotEvaluable')));
    runInContext("reconciliationFilter = 'close_before_approval'; reconciliationOpen = false", context);
    html = runInContext('renderReconciliation()', context);
    assert.doesNotMatch(html, /<details[^>]*open/); assert.ok(!html.includes(esc(data.items[0].id)));
    assert.ok(html.includes(esc(data.items[1].id))); assert.match(html, /aria-pressed="true"/);
    const printable = runInContext('reconciliationReport(data)', context);
    assert.ok(printable.includes(t('reconciliationReportTitle'))); assert.doesNotMatch(printable, /<button/);
    context.data = { ...data, items: Array(15).fill(data.items[0]) };
    assert.equal((runInContext('reconciliationReport(data)', context).match(/&lt;script&gt;/g) || []).length, 10);
    context.data = data;
    data.items.length = 0;
    assert.ok(runInContext('renderReconciliation()', context).includes(t('reconciliationAligned')));
    assert.ok(runInContext('reconciliationReport(data)', context).includes(t('reconciliationAligned')));
    // Restore the shared synthetic payload for the second language.
    data.items = reconcileDeviationRows([synthetic({ title: '<script>synthetic</script>', status: 'closed' }),
      synthetic({ deviation_no: 'SYN-002', closed_date: at(1), approved_date: at(2) })]).items;
  }
});
