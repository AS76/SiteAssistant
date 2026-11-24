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
  const weeks = await db.all(`SELECT w.operational_date AS day, SUM(b.hours) AS hours
    FROM time_bookings b JOIN work_days w ON w.id = b.work_day_id AND w.site_id = b.site_id
    WHERE b.site_id = ? GROUP BY w.operational_date ORDER BY w.operational_date DESC LIMIT 90`, site);
  // The displayed window is the last six weeks present in bookings OR workdays.
  // The client uses the same union, so an empty recent workday week is visible
  // and cannot silently hide a week that actually contains booked hours.
  const workDays = (await db.all(`SELECT operational_date, work_time FROM work_days
    WHERE site_id = ? ORDER BY operational_date, id`, site)).map(row => ({
    operationalDate: row.operational_date instanceof Date ? row.operational_date.toISOString().slice(0, 10) : String(row.operational_date).slice(0, 10),
    workTime: row.work_time == null ? null : Number(row.work_time),
  }));
  const byWeek = new Map();
  for (const row of weeks) {
    // PostgreSQL returns DATE columns as Date objects, SQLite as text.
    const day = row.day instanceof Date ? row.day.toISOString().slice(0, 10) : String(row.day).slice(0, 10);
    const monday = weekStart(day);
    byWeek.set(monday, (byWeek.get(monday) || 0) + Number(row.hours));
  }
  for (const day of workDays) {
    if (!/^\d{4}-\d\d-\d\d$/.test(day.operationalDate)) continue;
    const monday = weekStart(day.operationalDate);
    if (!byWeek.has(monday)) byWeek.set(monday, 0);
  }
  const weekTotals = [...byWeek.entries()].sort(([a], [b]) => a.localeCompare(b)).slice(-6);
  const hours = weekTotals.map(([week, value]) => ({ week, hours: round(value), hoursExact: value }));

  // Workday facts stay separate from bookings: a missing source value is never zero.
  const bookingPeriod = await db.get(`SELECT MIN(w.operational_date) AS first_day,
    MAX(w.operational_date) AS last_day FROM time_bookings b
    JOIN work_days w ON w.id = b.work_day_id AND w.site_id = b.site_id WHERE b.site_id = ?`, site);
  const date = value => value == null ? null : value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
  const sourceDays = workDays.filter(day => day.workTime != null);
  const earned = await earnedValue(db, { siteId: site });
  const hoursCoverage = {
    appBookedHours: earned.ac_hours,
    bookedFrom: date(bookingPeriod.first_day), bookedTo: date(bookingPeriod.last_day),
    workDays: workDays.length, sourceWorkDays: sourceDays.length,
    sourceWorkTime: sourceDays.length && sourceDays.length === workDays.length
      ? round(sourceDays.reduce((sum, day) => sum + day.workTime, 0)) : null,
    knownSourceWorkTime: sourceDays.length ? round(sourceDays.reduce((sum, day) => sum + day.workTime, 0)) : null,
  };

  const claims = await db.get(`SELECT SUM(claim_amount) AS claimed, SUM(settlement_amount) AS settled,
      SUM(CASE WHEN status <> 'closed' THEN claim_amount END) AS open,
      COUNT(*) AS total, COUNT(claim_amount) AS claimed_known, COUNT(settlement_amount) AS settled_known,
      COUNT(CASE WHEN status <> 'closed' THEN 1 END) AS open_total,
      COUNT(CASE WHEN status <> 'closed' THEN claim_amount END) AS open_known
    FROM cost_impacts WHERE site_id = ?`, site);

  return {
    earnedValue: earned,
    workDays,
    hoursCoverage,
    deviations: deviationsByStatus,
    progress,
    hours,
    claims: {
      claimed: moneyTotal(claims.claimed), settled: moneyTotal(claims.settled), open: moneyTotal(claims.open),
      coverage: {
        claimed: { known: Number(claims.claimed_known), total: Number(claims.total) },
        settled: { known: Number(claims.settled_known), total: Number(claims.total) },
        open: { known: Number(claims.open_known), total: Number(claims.open_total) },
      },
    },
  };
}

const round = value => value == null ? null : Number(Number(value).toFixed(1));
const moneyTotal = value => value == null ? null : Number(Number(value).toFixed(2));

function weekStart(day) {
  const date = new Date(`${day}T00:00:00Z`);
  const offset = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - offset);
  return date.toISOString().slice(0, 10);
}
