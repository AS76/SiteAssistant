import { requireModule } from './module-access.mjs';
// Dashboard figures for the overview. Everything is computed from the application tables,
// scoped to one site: no caching layer, no rollup tables until the volumes justify them.
import { RepositoryError, requireRole } from './repository.mjs';
import { effectiveProgressSql } from './site-progress.mjs';
import { earnedValue } from './earned-value.mjs';

const fail = (code, message, status = 400) => { throw new RepositoryError(status, message, code); };

export const STATUS_ORDER = ['open', 'approved', 'in_progress', 'work_completed', 'closed', 'rejected'];

export async function requireDashboardSite(db, { siteId, user } = {}) {
  if (!user?.id) fail('UNAUTHENTICATED', 'Authentication required.', 401);
  const site = typeof siteId === 'string' ? siteId.toLowerCase() : '';
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(site)) {
    fail('VALIDATION_ERROR', 'site_id must be a UUID.');
  }
  await requireRole(db, site, user);
  return site;
}

// Shared by the cockpit and the printable report. Choose each item's effective
// value before averaging; unrecorded steps count as zero against all type weights.
export async function progressByArea(db, site) {
  const rows = await db.all(`SELECT COALESCE(s.section, s.plc_area, 'Senza sezione') AS area,
      COUNT(*) AS items,
      SUM(CASE WHEN s.progress_type_id IS NOT NULL THEN 1 ELSE 0 END) AS computed_items,
      AVG(${effectiveProgressSql}) AS actual,
      AVG(s.planned_progress_pct) AS planned
    FROM site_progress_items s WHERE s.site_id = ?
    GROUP BY COALESCE(s.section, s.plc_area, 'Senza sezione') ORDER BY items DESC, area ASC`, site);
  return rows.map(row => ({ area: row.area, items: Number(row.items),
    actual: round(row.actual), planned: round(row.planned),
    source: Number(row.computed_items) === 0 ? 'imported'
      : Number(row.computed_items) === Number(row.items) ? 'computed' : 'mixed',
  }));
}

export async function dashboard(db, options = {}) {
  const site = await requireDashboardSite(db, options);
  for (const module of ['overview', 'deviations', 'progress', 'bookings', 'wbs', 'impacts']) await requireModule(db, site, options.user, module);

  const deviations = await db.all(`SELECT status, COUNT(*) AS count FROM deviations
    WHERE site_id = ? GROUP BY status`, site);
  const deviationsByStatus = STATUS_ORDER.map(status => ({
    status, count: Number(deviations.find(row => row.status === status)?.count || 0),
  }));

  const progress = (await progressByArea(db, site)).slice(0, 8)
    .map(({ area, items, actual, planned }) => ({ section: area, items, actual, planned }));

  // Hours per operational week, last six weeks present in the data.
  const weeks = await db.all(`SELECT w.operational_date AS day, COALESCE(SUM(b.hours), 0) AS hours
    FROM time_bookings b JOIN work_days w ON w.id = b.work_day_id AND w.site_id = b.site_id
    WHERE b.site_id = ? GROUP BY w.operational_date ORDER BY w.operational_date DESC LIMIT 90`, site);
  const byWeek = new Map();
  for (const row of weeks) {
    // PostgreSQL returns DATE columns as Date objects, SQLite as text.
    const day = row.day instanceof Date ? row.day.toISOString().slice(0, 10) : String(row.day).slice(0, 10);
    const monday = weekStart(day);
    byWeek.set(monday, (byWeek.get(monday) || 0) + Number(row.hours));
  }
  const hours = [...byWeek.entries()].sort(([a], [b]) => a.localeCompare(b)).slice(-6)
    .map(([week, value]) => ({ week, hours: round(value) }));

  const claims = await db.all(`SELECT status, COALESCE(SUM(claim_amount), 0) AS claimed,
      COALESCE(SUM(settlement_amount), 0) AS settled FROM cost_impacts WHERE site_id = ? GROUP BY status`, site);
  const totals = claims.reduce((sum, row) => ({
    claimed: sum.claimed + Number(row.claimed), settled: sum.settled + Number(row.settled),
  }), { claimed: 0, settled: 0 });

  return {
    earnedValue: await earnedValue(db, { siteId: site }),
    deviations: deviationsByStatus,
    progress,
    hours,
    claims: { claimed: round(totals.claimed), settled: round(totals.settled),
      open: Number(claims.filter(row => row.status !== 'closed').reduce((sum, row) => sum + Number(row.claimed), 0).toFixed(2)) },
  };
}

const round = value => value == null ? null : Number(Number(value).toFixed(1));

function weekStart(day) {
  const date = new Date(`${day}T00:00:00Z`);
  const offset = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - offset);
  return date.toISOString().slice(0, 10);
}
