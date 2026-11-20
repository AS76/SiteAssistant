import { RepositoryError } from './repository.mjs';

export const REPORTING_FAMILIES = Object.freeze([
  'employees', 'work_days', 'time_schedule', 'site_progress_items', 'daily_logs', 'deviations',
]);

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

async function readOverview(query) {
  const { rows: runs } = await query(`SELECT r.run_id, r.scope_id, s.project_reference,
    r.declared_export_date::text AS declared_export_date, r.loaded_at,
    (SELECT COUNT(*) FROM ingest.quality_issues q
      JOIN ingest.run_batches rb ON rb.batch_id = q.batch_id AND rb.scope_id = q.scope_id
      WHERE rb.run_id = r.run_id AND rb.scope_id = r.scope_id) AS quality_issues
    FROM reporting.latest_complete_runs r JOIN ingest.scopes s ON s.id = r.scope_id
    ORDER BY s.project_reference, r.scope_id`);
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
export async function reportingOverview({ databaseUrl = process.env.REPORTING_DATABASE_URL, query } = {}) {
  if (!databaseUrl?.trim()) return { configured: false, scopes: [] };
  try {
    if (query) return await readOverview(query);
    const client = await (await reportingPool(databaseUrl)).connect();
    try {
      // The run metadata and all six current views must describe the same snapshot.
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const overview = await readOverview(client.query.bind(client));
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
