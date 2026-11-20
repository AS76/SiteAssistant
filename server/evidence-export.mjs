import { createHash } from 'node:crypto';
import { csvCell } from '../app/domain.mjs';
import { listDeviations } from './deviations.mjs';
import { requireModule } from './module-access.mjs';
import { RepositoryError, getSite, listAttachments, requireRole } from './repository.mjs';

const columns = ['record', 'id', 'reference', 'title', 'status', 'key', 'value', 'count',
  'declared_at', 'verified_at', 'waiver_reason', 'verification_document_id', 'acceptance_state',
  'acceptance_document_id', 'acceptance_date', 'source_system', 'source_id', 'source_status',
  'source_export_date', 'last_seen_in_export_date', 'traceability', 'absence', 'absence_reason',
  'absence_export_date', 'absence_scope', 'provenance', 'internal_owner_id', 'attribution_state',
  'causing_company', 'resolving_company', 'entity_type', 'entity_id', 'mime', 'size', 'content_sha256', 'created_at'];

function statusCounts(record, rows) {
  const counts = new Map();
  for (const row of rows) {
    const status = row.status ?? 'unknown';
    counts.set(status, (counts.get(status) ?? 0) + 1);
  }
  return [...counts.keys()].sort().map(status => ({ record, key: 'status_count', status, count: counts.get(status) }));
}

export async function evidenceExport(db, id, user, { generatedAt = new Date().toISOString(), expected } = {}) {
  if (!user?.id) throw new RepositoryError(401, 'Authentication required.', 'UNAUTHENTICATED');
  const time = new Date(generatedAt);
  if (!Number.isFinite(time.getTime()) || time.toISOString() !== generatedAt || (expected != null && !/^[0-9a-f]{64}$/.test(expected))) {
    throw new RepositoryError(400, 'Invalid evidence export checksum reference.', 'VALIDATION_ERROR');
  }
  const csv = await db.transaction(async tx => {
    const site = await getSite(tx, id);
    await requireRole(tx, site.id, user);
    await requireModule(tx, site.id, user, 'tasks');
    await requireModule(tx, site.id, user, 'deviations');
    const tasks = await tx.all(`SELECT t.*,
      CASE WHEN t.status = 'closed' AND e.waiver = TRUE THEN e.reason END AS waiver_reason,
      CASE WHEN t.status = 'closed' THEN e.evidence_attachment_id END AS verification_document_id
      FROM tasks t LEFT JOIN task_events e ON e.id = (SELECT h.id FROM task_events h
        WHERE h.task_id = t.id AND h.to_status = 'closed' AND h.from_status <> 'closed' ORDER BY h.at DESC, h.id DESC LIMIT 1)
      WHERE t.site_id = ? ORDER BY t.id`, site.id);
    const deviations = await listDeviations(tx, { siteId: site.id, limit: 2147483647 });
    const attachments = await listAttachments(tx, { site_id: site.id }, user);
    const rows = [
      { record: 'metadata', key: 'generated_at', value: generatedAt },
      { record: 'metadata', key: 'site_code', value: site.code },
      ...statusCounts('tasks', tasks), ...statusCounts('deviations', deviations),
      { record: 'attachments', key: 'total', count: attachments.length },
      ...tasks.map(row => ({ ...row, record: 'task' })),
      ...deviations.map(row => ({ ...row, record: 'deviation', reference: row.deviation_no })),
      ...attachments.map(row => ({ ...row, record: 'attachment', title: row.filename })),
    ];
    return [columns, ...rows.map(row => columns.map(key => row[key]))]
      .map(row => row.map(value => csvCell(value instanceof Date ? value.toISOString() : value)).join(',')).join('\r\n') + '\r\n';
  });
  const sha256 = createHash('sha256').update(csv, 'utf8').digest('hex');
  if (expected != null && sha256 !== expected) {
    throw new RepositoryError(409, 'The evidence export has changed. Download a new CSV and checksum.', 'EVIDENCE_EXPORT_CHANGED');
  }
  return { csv, sha256, generatedAt };
}
