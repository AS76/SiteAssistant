import { RepositoryError, getSite, requireRole } from './repository.mjs';
import { sourceTimestamp, stableId } from './wbs.mjs';

const fail = (status, message, code) => { throw new RepositoryError(status, message, code); };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const statuses = ['open', 'approved', 'in_progress', 'work_completed', 'closed', 'rejected'];
const aliases = new Map([
  ...statuses.map(status => [status, status]),
  ['work in progress', 'in_progress'], ['in progress', 'in_progress'],
  ['work completed', 'work_completed'], ['completed', 'work_completed'], ['refused', 'rejected'],
]);
const fields = ['deviation_no', 'title', 'problem_description', 'status', 'priority', 'author',
  'assigned_to', 'plc_area', 'creation_date', 'due_date', 'approved_date', 'closed_date',
  'actual_cost', 'claim_quantity', 'labor_hours', 'completed_tasks_pct'];
const dateFields = ['creation_date', 'due_date', 'approved_date', 'closed_date'];

function validId(value) {
  if (typeof value !== 'string' || !uuid.test(value)) fail(400, 'site_id must be a UUID.', 'VALIDATION_ERROR');
  return value.toLowerCase();
}

export async function listDeviations(db, { siteId: input, status, priority } = {}) {
  const site = validId(input), clauses = ['site_id = ?'], values = [site];
  if (status != null) {
    if (!statuses.includes(status)) fail(400, 'Unknown deviation status.', 'VALIDATION_ERROR');
    clauses.push('status = ?'); values.push(status);
  }
  if (priority != null) { clauses.push('priority = ?'); values.push(priority); }
  await getSite(db, site);
  return db.all(`SELECT * FROM deviations WHERE ${clauses.join(' AND ')}
    ORDER BY creation_date DESC NULLS LAST, deviation_no ASC NULLS LAST, id`, ...values);
}

export async function getDeviation(db, id) {
  const row = typeof id === 'string' && uuid.test(id)
    ? await db.get('SELECT * FROM deviations WHERE id = ?', id.toLowerCase()) : null;
  if (!row) fail(404, 'Deviation not found.', 'DEVIATION_NOT_FOUND');
  return { ...row, links: await db.all(`SELECT entity_type, entity_id FROM deviation_links
    WHERE deviation_id = ? ORDER BY entity_type, entity_id`, row.id) };
}

export async function importDeviations(db, inputSite, user) {
  if (!user?.id) fail(401, 'Authentication required.', 'UNAUTHENTICATED');
  const site = validId(inputSite);
  return db.transaction(async tx => {
    await requireRole(tx, site, user, ['owner']);
    // Serialize promotions for the site on both storage drivers.
    await tx.run('UPDATE sites SET id = id WHERE id = ?', site);
    const config = await tx.get('SELECT * FROM deviation_import_sources WHERE site_id = ?', site);
    if (!config) fail(409, 'Configure an explicit source scope and completed import run for this site.', 'DEVIATION_SOURCE_NOT_CONFIGURED');
    let run, rows;
    try {
      run = await tx.get(`SELECT r.id, r.scope_id, r.source_timezone, rb.batch_id, b.expected_rows
        FROM ingest.import_runs r JOIN ingest.run_batches rb ON rb.run_id = r.id AND rb.scope_id = r.scope_id
        JOIN ingest.import_batches b ON b.id = rb.batch_id AND b.scope_id = rb.scope_id AND b.family = rb.family
        WHERE r.id = ? AND r.scope_id = ? AND r.status = 'ready' AND r.completeness_verified = TRUE
          AND rb.family = 'deviations' AND b.status = 'typed'`, config.run_id, config.scope_id);
      if (!run) fail(409, 'A complete ready run with a typed Deviations batch is required.', 'DEVIATION_RUN_NOT_READY');
      // Cast before decoding: source wall times must never become host-local Date objects.
      rows = await tx.all(`SELECT ${fields.map(field => dateFields.includes(field)
        ? `CAST(s.${field} AS TEXT) AS ${field}`
        : field === 'status' ? 's.source_status' : `s.${field}`).join(', ')},
        s._source_row AS source_row, e.id AS source_entity_key_id, e.identity_state
        FROM source_snapshot.deviations s LEFT JOIN ingest.entity_keys e
          ON e.scope_id = s._scope_id AND e.family = 'deviations' AND e.external_key = s._identity_key
        WHERE s._batch_id = ? AND s._scope_id = ? ORDER BY s._source_row`, run.batch_id, run.scope_id);
    } catch (error) {
      if (['42P01', '3F000'].includes(error.code) || /no such table/.test(error.message)) {
        fail(409, 'Deviations ingestion schemas are not available.', 'DEVIATION_SOURCE_UNAVAILABLE');
      }
      throw error;
    }
    if (rows.length !== Number(run.expected_rows)) fail(409, 'Snapshot row count differs from the typed batch.', 'DEVIATION_INCOMPLETE_SNAPSHOT');
    if (config.promoted_run_id === run.id && config.promoted_batch_id === run.batch_id) {
      return { imported: 0, unchanged: true, unmapped_status: 0, run_id: run.id };
    }
    for (const row of rows) {
      row.id = stableId(site, run.scope_id, Number(row.source_row));
      if (!['observed', 'manual'].includes(row.identity_state)) row.source_entity_key_id = null;
      // Unknown, blank and absent source states stay NULL and are counted, never silently opened.
      row.status = aliases.get(row.source_status?.trim().toLowerCase()) ?? null;
      for (const field of dateFields) {
        const instant = sourceTimestamp(row[field], run.source_timezone);
        // Fixed UTC fractional precision keeps SQLite TEXT ordering chronological,
        // including equal instants supplied with different source precision.
        row[field] = instant?.replace(/\.(\d+)Z$/, (_, fraction) => `.${fraction.padEnd(6, '0')}Z`) ?? null;
      }
    }
    const at = new Date().toISOString(), columns = ['site_id', ...fields, 'source_entity_key_id'];
    // Upsert only: absent rows and explicit links are retained; no automatic linking or deletion.
    for (const row of rows) await tx.run(`INSERT INTO deviations (id, ${columns.join(', ')}, created_at)
      VALUES (?, ${columns.map(() => '?').join(', ')}, ?)
      ON CONFLICT (id) DO UPDATE SET ${columns.map(column => `${column} = excluded.${column}`).join(', ')}`,
    row.id, ...columns.map(column => column === 'site_id' ? site : row[column] ?? null), at);
    await tx.run(`UPDATE deviation_import_sources SET promoted_run_id = ?, promoted_batch_id = ?,
      promoted_at = ?, updated_at = ? WHERE site_id = ?`, run.id, run.batch_id, at, at, site);
    return { imported: rows.length, unchanged: false, unmapped_status: rows.filter(row => row.status == null).length, run_id: run.id };
  });
}
