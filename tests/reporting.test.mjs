import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeReportingScope, reportingOverview, REPORTING_FAMILIES } from '../server/reporting.mjs';
import { RepositoryError } from '../server/repository.mjs';
import { createServer } from '../server/http.mjs';
import { MODULES } from '../server/module-access.mjs';

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
  const overview = await reportingOverview({ databaseUrl, query: async (sql, parameters) => {
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
  assert.deepEqual(await reportingOverview({ databaseUrl, query: async () => { calls++; return { rows: [] }; } }),
    { configured: true, scopes: [] });
  assert.equal(calls, 1);
});

test('reporting failures are sanitized 503 repository errors at either query stage', async () => {
  for (const failAt of [1, 2]) {
    let calls = 0;
    await assert.rejects(reportingOverview({ databaseUrl, query: async () => {
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
    await assert.rejects(reportingOverview({ databaseUrl, query: async () => ({ rows: [{ ...run(), quality_issues: count }] }) }),
      { code: 'REPORTING_UNAVAILABLE', status: 503 });
  }
});

// Invoke the real HTTP request listener with a synthetic repository; no TCP listener or database.
async function route({ authenticated = true, members = [{ site_id: 'site-a', role: 'viewer', allowed: true }],
  method = 'GET', reporting = async () => ({ configured: false, scopes: [] }) } = {}) {
  let reads = 0;
  const db = {
    async get(sql, ...parameters) {
      if (sql.includes('FROM sessions')) return authenticated ? { id: 'user-a' } : null;
      assert.ok(sql.includes('FROM site_members m'));
      const member = members.find(member => member.site_id === parameters[1]);
      return member ? { role: member.role, allowed: member.allowed } : undefined;
    },
    async all(sql) { assert.match(sql, /^SELECT site_id, role FROM site_members/); return members; },
  };
  const server = createServer(db, { staticDir: null, reporting: async () => { reads++; return reporting(); } });
  const response = {
    headers: {}, setHeader(name, value) { this.headers[name] = value; },
    writeHead(status, headers) { this.status = status; Object.assign(this.headers, headers); },
    end(body) { this.body = JSON.parse(body); },
  };
  await server.listeners('request')[0]({ url: '/api/reporting/overview', method,
    headers: { cookie: `sa_session=${'s'.repeat(43)}` }, socket: { remoteAddress: '127.0.0.1' } }, response);
  return { ...response, reads };
}

test('reporting route is authenticated, member/module governed, global and GET only', async () => {
  assert.ok(MODULES.includes('reporting'));
  for (const role of ['owner', 'editor', 'verifier', 'viewer']) {
    const response = await route({ members: [{ site_id: 'site-a', role, allowed: true }] });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { configured: false, scopes: [] });
    assert.equal(response.reads, 1);
    assert.equal(response.headers['Cache-Control'], 'no-store');
  }
  for (const members of [[], [{ site_id: 'site-a', role: 'viewer', allowed: false }]]) {
    const response = await route({ members });
    assert.equal(response.status, 403);
    assert.equal(response.body.code, 'MODULE_FORBIDDEN');
    assert.equal(response.reads, 0);
  }
  const anonymous = await route({ authenticated: false });
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.reads, 0);
  assert.equal((await route({ members: [{ site_id: 'site-a', role: 'owner', allowed: false }] })).status, 200);
  assert.equal((await route({ members: [
    { site_id: 'site-a', role: 'viewer', allowed: false }, { site_id: 'site-b', role: 'viewer', allowed: true },
  ] })).status, 200);
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const response = await route({ method });
    assert.equal(response.status, 404);
    assert.equal(response.reads, 0);
  }
});

test('reporting route maps an unavailable repository to a safe 503 response', async () => {
  const response = await route({ reporting: () => reportingOverview({ databaseUrl,
    query: async () => { throw new Error(`Synthetic failure ${databaseUrl}`); } }) });
  assert.equal(response.status, 503);
  assert.deepEqual(response.body, { code: 'REPORTING_UNAVAILABLE', error: 'Reporting is temporarily unavailable.' });
});
