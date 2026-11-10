// Dashboard figures for the overview. Everything is computed from the application tables,
// scoped to one site: no caching layer, no rollup tables until the volumes justify them.
import { RepositoryError, requireRole } from './repository.mjs';

const fail = (code, message, status = 400) => { throw new RepositoryError(message, status, code); };

const STATUS_ORDER = ['open', 'approved', 'in_progress', 'work_completed', 'closed', 'rejected'];

export async function dashboard(db, { siteId, user } = {}) {
  if (!user?.id) fail('UNAUTHENTICATED', 'Authentication required.', 401);
  const site = typeof siteId === 'string' ? siteId.toLowerCase() : '';
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(site)) {
    fail('VALIDATION_ERROR', 'site_id must be a UUID.');
  }
  await requireRole(db, site, user);

  const deviations = await db.all(`SELECT status, COUNT(*) AS count FROM deviations
    WHERE site_id = ? GROUP BY status`, site);
  const deviationsByStatus = STATUS_ORDER.map(status => ({
    status, count: Number(deviations.find(row => row.status === status)?.count || 0),
  }));

  // Progress by section: average of the effective percentage, imported or computed.
  const sections = await db.all(`SELECT COALESCE(section, plc_area, 'Senza sezione') AS section,
      COUNT(*) AS items, AVG(s.progress_pct) AS imported,
      AVG(CASE WHEN s.progress_type_id IS NOT NULL THEN (
        SELECT COALESCE(SUM(ps.weight * st.percent), 0) / NULLIF(SUM(ps.weight), 0)
        FROM site_progress_item_steps st JOIN progress_type_steps ps ON ps.id = st.progress_type_step_id
        WHERE st.site_progress_item_id = s.id) END) AS computed,
      AVG(s.planned_progress_pct) AS planned
    FROM site_progress_items s WHERE s.site_id = ?
    GROUP BY COALESCE(section, plc_area, 'Senza sezione') ORDER BY items DESC LIMIT 8`, site);
  const progress = sections.map(row => ({
    section: row.section, items: Number(row.items),
    actual: round(row.computed ?? row.imported), planned: round(row.planned),
  }));

  // Hours per operational week, last six weeks present in the data.
  const weeks = await db.all(`SELECT w.operational_date AS day, COALESCE(SUM(b.hours), 0) AS hours
    FROM time_bookings b JOIN work_days w ON w.id = b.work_day_id AND w.site_id = b.site_id
    WHERE b.site_id = ? GROUP BY w.operational_date ORDER BY w.operational_date DESC LIMIT 90`, site);
  const byWeek = new Map();
  for (const row of weeks) {
    const day = String(row.day).slice(0, 10);
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
