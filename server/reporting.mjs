import { RepositoryError } from './repository.mjs';
import { memberships } from './auth.mjs';
import { moduleAllowed } from './module-access.mjs';

export const REPORTING_FAMILIES = Object.freeze([
  'employees', 'work_days', 'time_schedule', 'site_progress_items', 'daily_logs', 'deviations',
]);

export async function reportingScopeIds(db, user, globalOwnerIds) {
  const roles = await memberships(db, user.id);
  if (globalOwnerIds.has(user.id) && roles.some(member => member.role === 'owner')) return null;

  const allowedSites = new Set();
  for (const member of roles) {
    if (await moduleAllowed(db, member.site_id, user, 'reporting')) allowedSites.add(member.site_id);
  }
  if (!allowedSites.size) throw new RepositoryError(403, 'Module is not available.', 'MODULE_FORBIDDEN');

  const bindings = await db.all(`SELECT site_id, scope_id FROM wbs_import_sources
    UNION SELECT site_id, scope_id FROM hr_import_sources
    UNION SELECT site_id, scope_id FROM site_progress_import_sources
    UNION SELECT site_id, scope_id FROM deviation_import_sources`);
  const allowedScopes = new Set(), excludedScopes = new Set();
  for (const { site_id, scope_id } of bindings) {
    (allowedSites.has(site_id) ? allowedScopes : excludedScopes).add(scope_id.toLowerCase());
  }
  // Aggregates cover the whole scope, including any other sites linked to it.
  return [...allowedScopes].filter(id => !excludedScopes.has(id));
}

let pool;
async function reportingPool(databaseUrl) {
  if (!pool) {
    const { Pool } = await import('pg');
    pool ??= new Pool({
      connectionString: databaseUrl, application_name: 'siteassistant-reporting',
      connectionTimeoutMillis: 3000, query_timeout: 5000, statement_timeout: 5000,
      max: 2, idleTimeoutMillis: 10000, allowExitOnIdle: true,
    });
    // Idle connection errors must not become uncaught events or expose credentials.
    pool.on('error', () => {});
  }
  return pool;
}

function count(value) {
  const number = Number(value ?? 0);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error('Invalid reporting count.');
  return number;
}

// Explicit allowlist: source payloads and run/batch identifiers never leave this module.
export function normalizeReportingScope(row, familyCounts = {}) {
  const counts = Object.fromEntries(REPORTING_FAMILIES.map(family => [family, count(familyCounts[family])]));
  const totalRows = count(Object.values(counts).reduce((sum, value) => sum + value, 0));
  return {
    scopeId: row.scope_id,
    projectReference: row.project_reference ?? null,
    exportDate: row.declared_export_date instanceof Date
      ? row.declared_export_date.toISOString().slice(0, 10) : row.declared_export_date ?? null,
    loadedAt: row.loaded_at instanceof Date ? row.loaded_at.toISOString() : row.loaded_at ?? null,
    counts, totalRows, qualityIssues: count(row.quality_issues),
  };
}

async function readOverview(query, scopeIds) {
  const { rows: runs } = await query(`SELECT r.run_id, r.scope_id, s.project_reference,
    r.declared_export_date::text AS declared_export_date, r.loaded_at,
    (SELECT COUNT(*) FROM ingest.quality_issues q
      JOIN ingest.run_batches rb ON rb.batch_id = q.batch_id AND rb.scope_id = q.scope_id
      WHERE rb.run_id = r.run_id AND rb.scope_id = r.scope_id) AS quality_issues
    FROM reporting.latest_complete_runs r JOIN ingest.scopes s ON s.id = r.scope_id
    WHERE ($1::uuid[] IS NULL OR r.scope_id = ANY($1::uuid[]))
    ORDER BY s.project_reference, r.scope_id`, [scopeIds]);
  if (!runs.length) return { configured: true, scopes: [] };
  // Identifiers come only from the fixed family allowlist; scope IDs are parameters.
  const { rows } = await query(REPORTING_FAMILIES.map(family =>
    `SELECT _scope_id AS scope_id, '${family}' AS family, COUNT(*) AS count
      FROM reporting.${family}_current WHERE _scope_id = ANY($1::uuid[]) GROUP BY _scope_id`
  ).join('\nUNION ALL\n'), [runs.map(run => run.scope_id)]);
  const counts = new Map(runs.map(run => [run.scope_id, {}]));
  for (const row of rows) {
    if (REPORTING_FAMILIES.includes(row.family) && counts.has(row.scope_id)) counts.get(row.scope_id)[row.family] = row.count;
  }
  return { configured: true, scopes: runs.map(run => normalizeReportingScope(run, counts.get(run.scope_id))) };
}

// Query injection keeps unit tests independent of a real reporting database.
export async function reportingOverview({ databaseUrl = process.env.REPORTING_DATABASE_URL, scopeIds = [], query } = {}) {
  if (!databaseUrl?.trim()) return { configured: false, scopes: [] };
  if (scopeIds?.length === 0) return { configured: true, scopes: [] };
  try {
    if (query) return await readOverview(query, scopeIds);
    const client = await (await reportingPool(databaseUrl)).connect();
    try {
      // The run metadata and all six current views must describe the same snapshot.
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const overview = await readOverview(client.query.bind(client), scopeIds);
      await client.query('COMMIT');
      return overview;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* connection may already be closed */ }
      throw error;
    } finally { client.release(); }
  } catch {
    throw new RepositoryError(503, 'Reporting is temporarily unavailable.', 'REPORTING_UNAVAILABLE');
  }
}
