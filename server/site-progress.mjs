import { RepositoryError, getSite, requireRole } from './repository.mjs';
import { sourceTimestamp, stableId } from './wbs.mjs';

const fail = (status, message, code) => { throw new RepositoryError(status, message, code); };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fields = ['description', 'plc_area', 'section', 'progress_pct', 'planned_progress_pct',
  'delta_progress_source', 'assigned_to', 'planned_start', 'planned_finish', 'actual_start',
  'expected_delay', 'has_files', 'has_notes', 'has_deviations'];
const dateFields = ['planned_start', 'planned_finish', 'actual_start'];
const booleanFields = ['has_files', 'has_notes', 'has_deviations'];
// Effective progress: computed when the item has a progress type, imported otherwise (no cycle with progress-types.mjs).
const effectiveProgress = (row, aggregate) => {
  const computed = row.progress_type_id != null;
  return { progress_pct: computed ? (aggregate == null ? 0 : Number(aggregate))
    : row.progress_pct == null ? null : Number(row.progress_pct),
  progress_pct_source: computed ? 'computed' : 'imported' };
};
const publicItem = row => ({ ...row, ...Object.fromEntries(booleanFields.map(field =>
  [field, row[field] == null ? null : Boolean(row[field])])) });

function validId(value, field) {
  if (typeof value !== 'string' || !uuid.test(value)) fail(400, `${field} must be a UUID.`, 'VALIDATION_ERROR');
  return value.toLowerCase();
}

export async function listSiteProgress(db, { siteId: input, wbsId } = {}) {
  const site = validId(input, 'site_id'), clauses = ['s.site_id = ?'], values = [site];
  if (wbsId != null) { clauses.push('s.wbs_id = ?'); values.push(validId(wbsId, 'wbs_id')); }
  await getSite(db, site);
  // List and detail expose the same aggregates so the UI never needs a second request.
  return (await db.all(`SELECT s.*, ps.wbs_code AS wbs_code, ps.description AS wbs_description,
      COALESCE(b.booked_hours, 0) AS booked_hours,
      c.progress_pct_computed
    FROM site_progress_items s
    LEFT JOIN project_structure ps ON ps.id = s.wbs_id
    LEFT JOIN (
      SELECT site_progress_item_id, SUM(hours) AS booked_hours FROM time_bookings GROUP BY site_progress_item_id
    ) b ON b.site_progress_item_id = s.id LEFT JOIN (
      -- Denominator is every step of the type, so an unrecorded step counts as zero.
      SELECT i.id AS site_progress_item_id,
        (SELECT COALESCE(SUM(ps.weight * st.percent * 1.0), 0) FROM site_progress_item_steps st
          JOIN progress_type_steps ps ON ps.id = st.progress_type_step_id
          WHERE st.site_progress_item_id = i.id)
        / (SELECT SUM(ps2.weight) FROM progress_type_steps ps2 WHERE ps2.progress_type_id = i.progress_type_id)
        AS progress_pct_computed
      FROM site_progress_items i WHERE i.progress_type_id IS NOT NULL
    ) c ON c.site_progress_item_id = s.id
    WHERE ${clauses.join(' AND ')}
    ORDER BY s.section, s.plc_area, s.source_row, s.id`, ...values))
    .map(row => ({ ...publicItem(row), ...effectiveProgress(row, row.progress_pct_computed),
      booked_hours: Number(row.booked_hours) }))
    .map(({ progress_pct_computed, ...row }) => row);
}

export async function getSiteProgressItem(db, id) {
  const row = typeof id === 'string' && uuid.test(id)
    ? await db.get(`SELECT s.*, ps.wbs_code AS wbs_code, ps.description AS wbs_description
        FROM site_progress_items s LEFT JOIN project_structure ps ON ps.id = s.wbs_id
        WHERE s.id = ?`, id.toLowerCase()) : null;
  if (!row) fail(404, 'Site progress item not found.', 'SITE_PROGRESS_ITEM_NOT_FOUND');
  const aggregate = row.progress_type_id == null ? null
    : (await db.get(`SELECT (SELECT COALESCE(SUM(ps.weight * st.percent * 1.0), 0) FROM site_progress_item_steps st
        JOIN progress_type_steps ps ON ps.id = st.progress_type_step_id WHERE st.site_progress_item_id = ?)
        / (SELECT SUM(ps2.weight) FROM progress_type_steps ps2 WHERE ps2.progress_type_id = ?) AS progress_pct_computed`,
      row.id, row.progress_type_id))?.progress_pct_computed ?? null;
  const steps = row.progress_type_id == null ? [] : (await db.all(`SELECT ps.id, ps.code, ps.description, ps.position,
      ps.weight, st.percent FROM progress_type_steps ps
      LEFT JOIN site_progress_item_steps st ON st.progress_type_step_id = ps.id AND st.site_progress_item_id = ?
      WHERE ps.progress_type_id = ? ORDER BY ps.position`, row.id, row.progress_type_id)).map(step => ({
    ...step, weight: Number(step.weight), percent: step.percent == null ? null : Number(step.percent) }));
  return { ...publicItem(row), ...effectiveProgress(row, aggregate), steps };
}

export async function importSiteProgress(db, inputSite, user) {
  if (!user?.id) fail(401, 'Authentication required.', 'UNAUTHENTICATED');
  const site = validId(inputSite, 'site_id');
  return db.transaction(async tx => {
    await requireRole(tx, site, user, ['owner']);
    // Serialize promotions for this site on both storage drivers.
    await tx.run('UPDATE sites SET id = id WHERE id = ?', site);
    const config = await tx.get('SELECT * FROM site_progress_import_sources WHERE site_id = ?', site);
    if (!config) fail(409, 'Configure an explicit source scope and completed import run for this site.', 'SITE_PROGRESS_SOURCE_NOT_CONFIGURED');
    let run, rows;
    try {
      run = await tx.get(`SELECT r.id, r.scope_id, r.source_timezone, rb.batch_id, b.expected_rows
        FROM ingest.import_runs r JOIN ingest.run_batches rb ON rb.run_id = r.id AND rb.scope_id = r.scope_id
        JOIN ingest.import_batches b ON b.id = rb.batch_id AND b.scope_id = rb.scope_id AND b.family = rb.family
        WHERE r.id = ? AND r.scope_id = ? AND r.status = 'ready' AND r.completeness_verified = TRUE
          AND rb.family = 'site_progress_items' AND b.status = 'typed'`, config.run_id, config.scope_id);
      if (!run) fail(409, 'A complete ready run with a typed Site Progress batch is required.', 'SITE_PROGRESS_RUN_NOT_READY');
      // Cast before decoding: source wall times must never become host-local Date objects.
      rows = await tx.all(`SELECT ${fields.map(field => dateFields.includes(field)
        ? `CAST(s.${field} AS TEXT) AS ${field}`
        : field === 'expected_delay' ? 's.expected_delay_raw AS expected_delay' : `s.${field}`).join(', ')},
        s._source_row AS source_row, e.id AS source_entity_key_id, e.identity_state
        FROM source_snapshot.site_progress_items s LEFT JOIN ingest.entity_keys e
          ON e.scope_id = s._scope_id AND e.family = 'site_progress_items' AND e.external_key = s._identity_key
        WHERE s._batch_id = ? AND s._scope_id = ? ORDER BY s._source_row`, run.batch_id, run.scope_id);
    } catch (error) {
      if (['42P01', '3F000'].includes(error.code) || /no such table/.test(error.message)) {
        fail(409, 'Site Progress ingestion schemas are not available.', 'SITE_PROGRESS_SOURCE_UNAVAILABLE');
      }
      throw error;
    }
    if (rows.length !== Number(run.expected_rows)) fail(409, 'Snapshot row count differs from the typed batch.', 'SITE_PROGRESS_INCOMPLETE_SNAPSHOT');
    if (config.promoted_run_id === run.id && config.promoted_batch_id === run.batch_id) {
      return { imported: 0, unresolved: 0, unchanged: true, run_id: run.id };
    }
    const nodes = await tx.all('SELECT id, plc_area, section FROM project_structure WHERE site_id = ? AND is_synthetic = FALSE', site);
    for (const row of rows) {
      // BIGINT source rows may be decoded as strings by PostgreSQL drivers.
      row.source_row = Number(row.source_row);
      row.id = stableId(site, run.scope_id, row.source_row);
      if (!['observed', 'manual'].includes(row.identity_state)) row.source_entity_key_id = null;
      // Match every supplied dimension within this site, excluding synthetic nodes.
      // No dimensions, no match, or multiple candidates never imply a WBS link.
      const candidates = row.plc_area == null && row.section == null ? [] : nodes.filter(node =>
        (row.plc_area == null || node.plc_area === row.plc_area) &&
        (row.section == null || node.section === row.section));
      row.wbs_id = candidates.length === 1 ? candidates[0].id : null;
      for (const field of dateFields) row[field] = sourceTimestamp(row[field], run.source_timezone);
    }
    const at = new Date().toISOString();
    const existing = await tx.all('SELECT id FROM site_progress_items WHERE site_id = ?', site);
    // Rebuild the projection atomically, retaining IDs/created_at of surviving rows.
    await tx.run('UPDATE site_progress_items SET wbs_id = NULL WHERE site_id = ?', site);
    const ids = new Set(rows.map(row => row.id));
    const removals = existing.filter(row => !ids.has(row.id));
    // Fail-closed: a row with active time bookings is never deleted, silently or by cascade.
    for (let offset = 0; offset < removals.length; offset += 500) {
      const chunk = removals.slice(offset, offset + 500);
      const booked = await tx.all(`SELECT DISTINCT site_progress_item_id FROM time_bookings
        WHERE site_progress_item_id IN (${chunk.map(() => '?').join(', ')})`, ...chunk.map(row => row.id));
      if (booked.length) fail(409, `Cannot remove ${booked.length} Site Progress item(s) with active time bookings. Delete the bookings first.`, 'SITE_PROGRESS_ITEM_HAS_BOOKINGS');
    }
    for (const row of removals) {
      try {
        await tx.run('DELETE FROM site_progress_items WHERE id = ? AND site_id = ?', row.id, site);
      } catch (error) {
        // A booking created after the check still fails closed instead of surfacing a driver error.
        if (error.code === '23503' || /FOREIGN KEY constraint failed/i.test(error.message || '')) {
          fail(409, 'Cannot remove a Site Progress item with active time bookings. Delete the bookings first.', 'SITE_PROGRESS_ITEM_HAS_BOOKINGS');
        }
        throw error;
      }
    }
    const columns = ['site_id', 'wbs_id', ...fields, 'source_row', 'source_entity_key_id'];
    const placeholders = columns.map(column => booleanFields.includes(column)
      ? "CASE ? WHEN 'true' THEN TRUE WHEN 'false' THEN FALSE ELSE NULL END" : '?');
    for (const row of rows) {
      // CASE yields native SQL booleans; SQLite cannot bind JavaScript booleans directly.
      const values = columns.map(column => column === 'site_id' ? site
        : booleanFields.includes(column) && row[column] != null ? String(Boolean(row[column])) : row[column] ?? null);
      await tx.run(`INSERT INTO site_progress_items (id, ${columns.join(', ')}, created_at)
        VALUES (?, ${placeholders.join(', ')}, ?)
        ON CONFLICT (id) DO UPDATE SET ${columns.map(column => `${column} = excluded.${column}`).join(', ')}`,
      row.id, ...values, at);
    }
    await tx.run('UPDATE site_progress_import_sources SET promoted_run_id = ?, promoted_batch_id = ?, promoted_at = ? WHERE site_id = ?', run.id, run.batch_id, at, site);
    return { imported: rows.length, unresolved: rows.filter(row => row.source_entity_key_id == null).length,
      linked: rows.filter(row => row.wbs_id != null).length, unchanged: false, run_id: run.id };
  });
}
