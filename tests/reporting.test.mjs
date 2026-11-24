import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { normalizeReportingScope, reportingOverview, REPORTING_FAMILIES } from '../server/reporting.mjs';
import { createSite, RepositoryError } from '../server/repository.mjs';
import { createServer } from '../server/http.mjs';
import { saveModuleAccess } from '../server/module-access.mjs';
import { authFixture, requestListener } from './helpers/auth.mjs';
import { wbsDatabase } from './helpers/wbs.mjs';

const databaseUrl = 'postgresql://example.invalid/synthetic_reporting';
const run = (scope = 'scope-a') => ({
  run_id: `run-${scope}`, scope_id: scope, project_reference: `Synthetic ${scope}`,
  declared_export_date: '2026-11-12', loaded_at: new Date('2026-11-13T10:15:00Z'), quality_issues: '3',
});

test('reporting normalizer exposes only aggregate contract fields and preserves zeroes and nulls', () => {
  const row = { ...run(), raw_payload: { private: 'synthetic hidden value' }, employee_name: 'Synthetic hidden name' };
  const counts = Object.fromEntries(REPORTING_FAMILIES.map((family, index) => [family, String(index)]));
  assert.deepEqual(normalizeReportingScope(row, counts), {
    scopeId: 'scope-a', projectReference: 'Synthetic scope-a', exportDate: '2026-11-12',
    loadedAt: '2026-11-13T10:15:00.000Z',
    counts: { employees: 0, work_days: 1, time_schedule: 2, site_progress_items: 3, daily_logs: 4, deviations: 5 },
    totalRows: 15, qualityIssues: 3,
  });
  const empty = normalizeReportingScope({ scope_id: 'scope-b', project_reference: null, declared_export_date: null, loaded_at: null });
  assert.equal(empty.projectReference, null);
  assert.equal(empty.exportDate, null);
  assert.equal(empty.loadedAt, null);
  assert.equal(empty.totalRows, 0);
  assert.equal(empty.qualityIssues, 0);
  assert.deepEqual(Object.keys(empty.counts), REPORTING_FAMILIES);
  assert.equal(normalizeReportingScope({ ...run(), declared_export_date: new Date('2026-11-12T00:00:00Z') }).exportDate, '2026-11-12');
});

test('reporting missing configuration never queries or imports a pool', async t => {
  const previous = process.env.REPORTING_DATABASE_URL;
  delete process.env.REPORTING_DATABASE_URL;
  t.after(() => { if (previous === undefined) delete process.env.REPORTING_DATABASE_URL; else process.env.REPORTING_DATABASE_URL = previous; });
  const query = () => assert.fail('Reporting must not query without configuration.');
  assert.deepEqual(await reportingOverview(), { configured: false, scopes: [] });
  assert.deepEqual(await reportingOverview({ query }), { configured: false, scopes: [] });
  assert.deepEqual(await reportingOverview({ databaseUrl: '  ', query }), { configured: false, scopes: [] });
});

test('reporting reads latest run metadata and all six aggregate counts, without returning source rows', async () => {
  const calls = [];
  const overview = await reportingOverview({ databaseUrl, scopeIds: null, query: async (sql, parameters) => {
    calls.push({ sql, parameters });
    if (calls.length === 1) return { rows: [run(), { ...run('scope-b'), quality_issues: '0' }] };
    return { rows: [
      ...REPORTING_FAMILIES.map((family, index) => ({ scope_id: 'scope-a', family, count: `${index + 1}` })),
      { scope_id: 'scope-b', family: 'daily_logs', count: '7' },
    ] };
  } });
  assert.equal(calls.length, 2);
  assert.match(calls[0].sql, /reporting\.latest_complete_runs/);
  assert.match(calls[0].sql, /JOIN ingest\.scopes/);
  assert.deepEqual(calls[0].parameters, [null]);
  assert.match(calls[0].sql, /JOIN ingest\.run_batches rb ON rb\.batch_id = q\.batch_id AND rb\.scope_id = q\.scope_id/);
  assert.match(calls[0].sql, /rb\.run_id = r\.run_id AND rb\.scope_id = r\.scope_id/);
  for (const family of REPORTING_FAMILIES) assert.ok(calls[1].sql.includes(`reporting.${family}_current`));
  assert.equal((calls[1].sql.match(/COUNT\(\*\)/g) || []).length, 6);
  assert.doesNotMatch(calls[1].sql, /SELECT\s+\*|scope-a|scope-b/);
  assert.deepEqual(calls[1].parameters, [['scope-a', 'scope-b']]);
  assert.equal(overview.configured, true);
  assert.equal(overview.scopes[0].totalRows, 21);
  assert.equal(overview.scopes[0].qualityIssues, 3);
  assert.equal(overview.scopes[1].totalRows, 7);
  assert.equal(overview.scopes[1].counts.employees, 0);
  assert.equal(overview.scopes[1].qualityIssues, 0);
  assert.doesNotMatch(JSON.stringify(overview), /run_id|batch_id|raw_payload/);
});

test('configured reporting with no complete runs returns an empty overview after one query', async () => {
  let calls = 0;
  assert.deepEqual(await reportingOverview({ databaseUrl, scopeIds: null, query: async () => { calls++; return { rows: [] }; } }),
    { configured: true, scopes: [] });
  assert.equal(calls, 1);
});

test('reporting failures are sanitized 503 repository errors at either query stage', async () => {
  for (const failAt of [1, 2]) {
    let calls = 0;
    await assert.rejects(reportingOverview({ databaseUrl, scopeIds: null, query: async () => {
      if (++calls === failAt) throw new Error(`Synthetic connection failure ${databaseUrl}`);
      return { rows: [run()] };
    } }), error => {
      assert.ok(error instanceof RepositoryError);
      assert.equal(error.status, 503);
      assert.equal(error.code, 'REPORTING_UNAVAILABLE');
      assert.equal(error.message, 'Reporting is temporarily unavailable.');
      assert.doesNotMatch(String(error.stack), /postgresql:|example\.invalid/);
      assert.equal(error.cause, undefined);
      return true;
    });
  }
  for (const count of ['bad', '-1', '9007199254740992']) {
    await assert.rejects(reportingOverview({ databaseUrl, scopeIds: null, query: async () => ({ rows: [{ ...run(), quality_issues: count }] }) }),
      { code: 'REPORTING_UNAVAILABLE', status: 503 });
  }
});

test('reporting refuses to query without an explicit scope selection', async () => {
  const query = () => assert.fail('Reporting must not query without authorized scopes.');
  assert.deepEqual(await reportingOverview({ databaseUrl, query }), { configured: true, scopes: [] });
  assert.deepEqual(await reportingOverview({ databaseUrl, scopeIds: [], query }), { configured: true, scopes: [] });
});

test('reporting gates the entire aggregate by assigned sites and explicit global owner access', async t => {
  const db = await wbsDatabase(t, 'pg');
  const siteA = await createSite(db, { code: 'SITE-A', name: 'Synthetic site A' });
  const siteB = await createSite(db, { code: 'SITE-B', name: 'Synthetic site B' });
  const { users, cookies } = await authFixture(db, siteA);
  const scopes = {};
  for (const key of ['a', 'b', 'shared', 'unlinked']) {
    const scope = scopes[key] = { id: randomUUID(), runId: randomUUID() };
    await db.run(`INSERT INTO ingest.scopes (id, organization_id, source_system_key, project_reference)
      VALUES (?, ?, 'synthetic', ?)`, scope.id, randomUUID(), key);
    await db.run(`INSERT INTO ingest.import_runs (id, scope_id, declared_export_date, status, completeness_verified)
      VALUES (?, ?, '2026-11-12', 'ready', TRUE)`, scope.runId, scope.id);
  }
  for (const [table, site, scope] of [
    ['wbs_import_sources', siteA, scopes.a],
    ['hr_import_sources', siteB, scopes.b],
    ['site_progress_import_sources', siteA, scopes.shared],
    ['deviation_import_sources', siteB, scopes.shared],
  ]) {
    await db.run(`INSERT INTO ${table} (site_id, scope_id, run_id) VALUES (?, ?, ?)`, site.id, scope.id, scope.runId);
  }

  const calls = [];
  const reporting = options => reportingOverview({ ...options, databaseUrl, query: async (sql, params) => {
    calls.push(params[0]);
    return { rows: await db.all(sql, ...params) };
  } });
  const request = requestListener(createServer(db, { reporting, reportingGlobalOwnerIds: '' }));
  const requestWithGrant = requestListener(createServer(db, {
    reporting, reportingGlobalOwnerIds: `${users.viewer.id}, ${users.owner.id}`,
  }));
  const path = '/api/reporting/overview';
  const expectScopes = async (listen, role, expected, query = '') => {
    calls.length = 0;
    const response = await listen(path + query, { cookie: cookies[role] });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.configured, true);
    assert.equal(response.headers['cache-control'], 'no-store');
    const ids = expected.map(key => scopes[key].id);
    assert.deepEqual(response.body.scopes.map(scope => scope.scopeId), ids);
    if (!ids.length) assert.deepEqual(calls, []);
    else {
      assert.equal(calls.length, 2);
      assert.deepEqual(calls[1], ids);
    }
    return calls[0];
  };

  assert.deepEqual(await expectScopes(request, 'viewer', ['a'], `?site_id=${siteB.id}`), [scopes.a.id]);
  assert.deepEqual(await expectScopes(requestWithGrant, 'viewer', ['a']), [scopes.a.id]);
  assert.deepEqual(await expectScopes(request, 'owner', ['a']), [scopes.a.id]);
  assert.equal(await expectScopes(requestWithGrant, 'owner', ['a', 'b', 'shared', 'unlinked']), null);
  assert.equal((await request(path)).status, 401);
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    assert.equal((await request(path, { method, cookie: cookies.owner })).status, 404);
  }
  assert.equal((await request('/api/reporting/export', { cookie: cookies.owner })).status, 404);
  for (const other of [`/api/report?site_id=${siteB.id}`, `/api/sites/${siteB.id}/evidence-export`]) {
    assert.equal((await request(other, { cookie: cookies.viewer })).status, 403);
  }

  await db.run('INSERT INTO site_members (site_id, user_id, role) VALUES (?, ?, ?)', siteB.id, users.viewer.id, 'viewer');
  const assigned = await expectScopes(request, 'viewer', ['a', 'b', 'shared']);
  assert.deepEqual(new Set(assigned), new Set([scopes.a.id, scopes.b.id, scopes.shared.id]));
  await db.run('INSERT INTO site_members (site_id, user_id, role) VALUES (?, ?, ?)', siteB.id, users.owner.id, 'owner');
  await saveModuleAccess(db, { siteId: siteB.id, memberId: users.viewer.id, module: 'reporting', allowed: false }, users.owner);
  assert.deepEqual(await expectScopes(request, 'viewer', ['a']), [scopes.a.id]);

  await db.run('DELETE FROM wbs_import_sources WHERE site_id = ?', siteA.id);
  await expectScopes(request, 'viewer', []);
  await saveModuleAccess(db, { siteId: siteA.id, memberId: users.viewer.id, module: 'reporting', allowed: false }, users.owner);
  const denied = await request(path, { cookie: cookies.viewer });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.code, 'MODULE_FORBIDDEN');
  assert.deepEqual(calls, []);

  const unavailable = requestListener(createServer(db, { reportingGlobalOwnerIds: users.owner.id,
    reporting: options => reportingOverview({ ...options, databaseUrl,
      query: async () => { throw new Error(`Synthetic failure ${databaseUrl}`); } }),
  }));
  const response = await unavailable(path, { cookie: cookies.owner });
  assert.equal(response.status, 503);
  assert.deepEqual(response.body, { code: 'REPORTING_UNAVAILABLE', error: 'Reporting is temporarily unavailable.' });
});
