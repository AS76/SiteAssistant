import { randomUUID } from 'node:crypto';
import { RepositoryError } from './repository.mjs';
import { requireDashboardSite } from './dashboard.mjs';
import { defaultDashboardLayout, validDashboardWidgets } from '../app/dashboard-layout.mjs';

function requireWidgets(widgets) {
  if (!validDashboardWidgets(widgets)) {
    throw new RepositoryError(400, 'widgets must contain 1 to 11 unique catalog IDs.', 'LAYOUT_INVALID');
  }
  return widgets;
}

export async function getDashboardLayout(db, options = {}) {
  const site = await requireDashboardSite(db, options);
  const row = await db.get('SELECT widgets_json FROM dashboard_layouts WHERE site_id = ? AND owner_id = ?',
    site, options.user.id);
  return row ? { widgets: requireWidgets(JSON.parse(row.widgets_json)), custom: true } : defaultDashboardLayout();
}

export async function saveDashboardLayout(db, { widgets, ...options } = {}) {
  const site = await requireDashboardSite(db, options);
  const serialized = JSON.stringify(requireWidgets(widgets));
  const now = new Date().toISOString();
  await db.run(`INSERT INTO dashboard_layouts (id, site_id, owner_id, widgets_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (site_id, owner_id)
    DO UPDATE SET widgets_json = excluded.widgets_json, updated_at = excluded.updated_at`,
  randomUUID(), site, options.user.id, serialized, now, now);
  return { widgets: JSON.parse(serialized), custom: true };
}

export async function deleteDashboardLayout(db, options = {}) {
  const site = await requireDashboardSite(db, options);
  await db.run('DELETE FROM dashboard_layouts WHERE site_id = ? AND owner_id = ?', site, options.user.id);
  return defaultDashboardLayout();
}
