import { progressByArea, requireDashboardSite, STATUS_ORDER } from './dashboard.mjs';

export async function report(db, options = {}) {
  const siteId = await requireDashboardSite(db, options);
  const site = await db.get('SELECT code, name FROM sites WHERE id = ?', siteId);
  const progress = await progressByArea(db, siteId);
  // The application deviations schema has plc_area, but no zone or section.
  const rows = await db.all(`SELECT COALESCE(plc_area, 'Senza sezione') AS area,
      status, COUNT(*) AS count FROM deviations WHERE site_id = ?
    GROUP BY COALESCE(plc_area, 'Senza sezione'), status`, siteId);
  const areas = new Map();
  for (const row of rows) {
    if (!areas.has(row.area)) areas.set(row.area, { area: row.area, total: 0, open: 0, closed: 0,
      by_status: STATUS_ORDER.map(status => ({ status, count: 0 })) });
    const area = areas.get(row.area), count = Number(row.count);
    area.total += count;
    // Rejected is terminal too. A missing imported status is still open.
    area[['closed', 'rejected'].includes(row.status) ? 'closed' : 'open'] += count;
    const status = area.by_status.find(entry => entry.status === row.status);
    if (status) status.count += count;
    else area.by_status.push({ status: row.status, count });
  }
  const deviations = [...areas.values()].sort((a, b) => b.total - a.total
    || (a.area < b.area ? -1 : a.area > b.area ? 1 : 0));
  return { site: { code: site.code, name: site.name }, generated_at: new Date().toISOString(), progress, deviations };
}
