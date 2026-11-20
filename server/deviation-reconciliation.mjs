import { requireModule } from './module-access.mjs';
import { RepositoryError, requireRole } from './repository.mjs';

const DAY = 86_400_000_000n;

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

// Pure calculation over official dates in the imported projection.
export function reconcileDeviationRows(rows) {
  const counts = { closed_without_date: 0, close_before_approval: 0 }, items = [];
  for (const row of rows) {
    const closed = instant(row.closed_date), approved = instant(row.approved_date);
    const add = (kind, days) => {
      counts[kind]++;
      items.push({ kind, id: row.id, deviation_no: row.deviation_no ?? null, title: row.title ?? null,
        official_status: row.status ?? null, disagreement_days: days });
    };
    if (row.status === 'closed' && row.closed_date == null) add('closed_without_date', null);
    if (closed != null && approved != null && closed < approved) add('close_before_approval', distance(closed, approved));
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
  const rows = await db.all(`SELECT id, deviation_no, title, status, approved_date, closed_date
    FROM deviations WHERE site_id = ?
    ORDER BY deviation_no ASC NULLS LAST, id`, site);
  return reconcileDeviationRows(rows);
}
