import { requireModule } from './module-access.mjs';
import { RepositoryError, requireRole } from './repository.mjs';

const DAY = 86_400_000_000n;
const officialDates = { open: 'creation_date', approved: 'approved_date', closed: 'closed_date' };

// Imported timestamps are instants. Never interpret a source wall time in the host timezone.
function instant(value) {
  if (value instanceof Date) value = value.toISOString();
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|[+-]\d\d:\d\d)$/.test(value)) return null;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return null;
  const fraction = /\.(\d+)/.exec(value)?.[1] || '';
  return BigInt(milliseconds) * 1000n + BigInt(fraction.padEnd(6, '0').slice(3));
}
const distance = (a, b) => a == null || b == null ? null : Number(a > b ? a - b : b - a) / Number(DAY);

// Pure calculation over an explicit projection. Internal fields must come from
// deviation history, never linked task events or import timestamps.
export function reconcileDeviationRows(rows) {
  const counts = { closed_without_date: 0, close_before_approval: 0, status_gap: 0 }, items = [];
  for (const row of rows) {
    const closed = instant(row.closed_date), approved = instant(row.approved_date);
    const internalAt = instant(row.internal_updated_at);
    const officialAt = instant(row[officialDates[row.status]]);
    const gap = distance(internalAt, officialAt);
    const add = (kind, days) => {
      counts[kind]++;
      items.push({ kind, id: row.id, deviation_no: row.deviation_no ?? null, title: row.title ?? null,
        official_status: row.status ?? null, internal_status: row.internal_status ?? null,
        internal_updated_at: row.internal_updated_at ?? null, disagreement_days: days });
    };
    if (row.status === 'closed' && row.closed_date == null) add('closed_without_date', null);
    if (closed != null && approved != null && closed < approved) add('close_before_approval', distance(closed, approved));
    if (row.status != null && row.internal_status != null && row.status !== row.internal_status
      && gap != null && gap >= 3) add('status_gap', gap);
  }
  return { counts, items };
}

export async function deviationReconciliation(db, { siteId } = {}, user) {
  if (!user?.id) throw new RepositoryError(401, 'Authentication required.', 'UNAUTHENTICATED');
  if (typeof siteId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(siteId)) {
    throw new RepositoryError(400, 'site_id must be a UUID.', 'VALIDATION_ERROR');
  }
  const site = siteId.toLowerCase();
  await requireRole(db, site, user, ['owner', 'editor', 'verifier', 'viewer']);
  await requireModule(db, site, user, 'deviations');
  // The current projection has no internal state, updated_at or deviation events.
  // created_at records import creation; it is not evidence of an internal transition.
  const rows = await db.all(`SELECT id, deviation_no, title, status, creation_date, approved_date, closed_date,
    NULL AS internal_status, NULL AS internal_updated_at FROM deviations WHERE site_id = ?
    ORDER BY deviation_no ASC NULLS LAST, id`, site);
  return { ...reconcileDeviationRows(rows), history_source: 'unavailable' };
}
