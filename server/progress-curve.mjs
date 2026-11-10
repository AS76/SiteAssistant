import { RepositoryError, requireRole } from './repository.mjs';

const DAY = 86_400_000;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail = message => { throw new RepositoryError(400, message, 'VALIDATION_ERROR'); };
const dateString = time => new Date(time).toISOString().slice(0, 10);
const round = value => Number(value.toFixed(1));

function validDate(value, field) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail(`${field} must be YYYY-MM-DD.`);
  const time = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(time) || dateString(time) !== value || value.startsWith('0000-')) {
    fail(`${field} must be a valid calendar date.`);
  }
  return time;
}

function plannedDay(value) {
  // Stored app timestamps carry a zone; Date objects are also returned by PGlite.
  if (value == null) return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? Math.floor(time / DAY) * DAY : null;
}

function plannedValue(item, day) {
  if (item.start == null || item.finish == null || item.finish < item.start) return null;
  if (day < item.start) return 0;
  // A zero-duration plan reaches its target on that day.
  if (day >= item.finish) return item.target;
  return item.target * (day - item.start) / (item.finish - item.start);
}

export async function progressCurve(db, { siteId, user, from, to } = {}) {
  if (!user?.id) throw new RepositoryError(401, 'Authentication required.', 'UNAUTHENTICATED');
  if (typeof siteId !== 'string' || !uuid.test(siteId)) fail('site_id must be a UUID.');
  const site = siteId.toLowerCase();
  await requireRole(db, site, user);

  const end = validDate(to ?? dateString(Date.now()), 'to');
  const start = validDate(from ?? dateString(end - 89 * DAY), 'from');
  if (start > end) fail('from must be on or before to.');
  if ((end - start) / DAY + 1 > 400) fail('The range must contain at most 400 calendar days (inclusive).');

  // One statement gives items, current type weights and history from the same snapshot.
  // Neither imported progress_pct nor the mutable item-step snapshot is consulted.
  const rows = await db.all(`SELECT i.id, COALESCE(i.section, i.plc_area, 'Senza sezione') AS section,
      i.planned_start, i.planned_finish, i.planned_progress_pct,
      h.entry_id, h.progress_type_step_id, h.percent, h.recorded_at, h.weight
    FROM site_progress_items i LEFT JOIN (
      SELECT e.id AS entry_id, e.site_id, e.site_progress_item_id, e.progress_type_step_id,
        e.percent, e.recorded_at, s.progress_type_id, s.weight
      FROM progress_entries e JOIN progress_type_steps s ON s.id = e.progress_type_step_id
      WHERE e.site_id = ?
    ) h ON h.site_progress_item_id = i.id AND h.site_id = i.site_id
      AND h.progress_type_id = i.progress_type_id
    WHERE i.site_id = ?`, site, site);

  const items = new Map(), sections = new Map(), history = [];
  for (const row of rows) {
    if (!items.has(row.id)) {
      const item = { start: plannedDay(row.planned_start), finish: plannedDay(row.planned_finish),
        target: Number(row.planned_progress_pct ?? 100), steps: new Map(), weighted: 0, weight: 0 };
      items.set(row.id, item);
      if (!sections.has(row.section)) sections.set(row.section, []);
      sections.get(row.section).push(item);
    }
    if (row.entry_id != null) {
      const at = new Date(row.recorded_at).getTime();
      if (Number.isFinite(at) && at < end + DAY) history.push({ id: row.entry_id, at,
        item: items.get(row.id), step: row.progress_type_step_id,
        percent: Number(row.percent), weight: Number(row.weight) });
    }
  }
  // Normalize timestamps before ordering, including SQLite strings with explicit offsets.
  // Equal timestamps have no insertion sequence in 016: the larger UUID wins deterministically.
  history.sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const series = [...sections.keys()].sort().map(section => ({ section, points: [] }));
  let cursor = 0;
  for (let day = start; day <= end; day += DAY) {
    // Replay pre-range history too, carrying each last value forward through empty days.
    while (cursor < history.length && history[cursor].at < day + DAY) {
      const entry = history[cursor++], item = entry.item;
      const previous = item.steps.get(entry.step);
      if (previous === undefined) item.weight += entry.weight;
      item.weighted += ((entry.percent - (previous ?? 0)) * entry.weight);
      item.steps.set(entry.step, entry.percent);
    }
    for (const section of series) {
      let planned = 0, plannedCount = 0, actual = 0, actualCount = 0;
      for (const item of sections.get(section.section)) {
        const value = plannedValue(item, day);
        if (value != null) { planned += value; plannedCount++; }
        // Average only steps with a recorded value; missing history is not a recorded zero.
        if (item.weight > 0) { actual += item.weighted / item.weight; actualCount++; }
      }
      section.points.push({ date: dateString(day),
        ...(plannedCount ? { planned: round(planned / plannedCount) } : {}),
        ...(actualCount ? { actual: round(actual / actualCount) } : {}) });
    }
  }
  return { from: dateString(start), to: dateString(end), series };
}
