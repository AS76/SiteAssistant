import { effectiveProgressSql } from './site-progress.mjs';

const round = value => value == null ? null : Number(Number(value).toFixed(2));
const ratio = (value, denominator) => value == null || denominator == null || Number(denominator) === 0
  ? null : round(Number(value) / Number(denominator));
const sum = (rows, key) => {
  const values = rows.filter(row => row[key] != null);
  return values.length ? values.reduce((total, row) => total + Number(row[key]), 0) : null;
};

export async function earnedValue(db, { siteId }) {
  const sections = await db.all(`WITH items AS (
    SELECT COALESCE(s.section, s.plc_area, 'Senza sezione') AS section,
      COALESCE(s.planned_hours, w.planned_hours) AS hours,
      ${effectiveProgressSql} AS actual, s.planned_progress_pct AS planned
    FROM site_progress_items s LEFT JOIN project_structure w ON w.id = s.wbs_id AND w.site_id = s.site_id
    WHERE s.site_id = ?
  ) SELECT section, COUNT(*) AS items_total,
    SUM(CASE WHEN hours IS NULL THEN 1 ELSE 0 END) AS items_without_hours,
    SUM(hours) AS bac_hours, SUM(hours * actual / 100.0) AS ev_hours,
    SUM(hours * planned / 100.0) AS pv_hours
    FROM items GROUP BY section ORDER BY section`, siteId);
  // Aggregate bookings separately so neither joins nor missing planned hours shrink AC.
  const bookings = await db.all(`SELECT COALESCE(s.section, s.plc_area, 'Senza sezione') AS section,
    SUM(b.hours) AS hours FROM time_bookings b
    LEFT JOIN site_progress_items s ON s.id = b.site_progress_item_id AND s.site_id = b.site_id
    WHERE b.site_id = ? GROUP BY COALESCE(s.section, s.plc_area, 'Senza sezione')`, siteId);
  const ac = bookings.reduce((total, row) => total + Number(row.hours), 0);
  const bac = sum(sections, 'bac_hours'), ev = sum(sections, 'ev_hours'), pv = sum(sections, 'pv_hours');
  return {
    available: bac != null, ...(bac == null ? { reason: 'NO_PLANNED_HOURS' } : {}),
    bac_hours: round(bac), ev_hours: round(ev), pv_hours: round(pv), ac_hours: round(ac),
    cpi: ratio(ev, ac), spi: ratio(ev, pv),
    items_total: sections.reduce((total, row) => total + Number(row.items_total), 0),
    items_without_hours: sections.reduce((total, row) => total + Number(row.items_without_hours), 0),
    by_section: sections.map(row => ({ section: row.section, ev_hours: round(row.ev_hours),
      pv_hours: round(row.pv_hours), bac_hours: round(row.bac_hours),
      cpi: ratio(row.ev_hours, bookings.find(booking => booking.section === row.section)?.hours) })),
  };
}
