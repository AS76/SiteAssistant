import { appendAuditEvent } from './audit.mjs';
import { requireModule } from './module-access.mjs';
import { EDIT_ROLES, RepositoryError, getSite, requireRole } from './repository.mjs';
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

const sourceSystems = ['internal', 'other'];
const attributionStates = ['not_determined', 'agreed', 'disputed'];

export function deviationImportMeta(input) {
  const invalid = () => fail(422, 'Invalid deviation export metadata.', 'DEVIATION_EXPORT_META_INVALID');
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid();
  const { sourceSystem, exportDate, fileSha256, complete, scope } = input;
  const day = typeof exportDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(exportDate)
    ? new Date(exportDate + 'T00:00:00Z') : null;
  if (!sourceSystems.includes(sourceSystem) || !day || !Number.isFinite(day.getTime())
      || day.toISOString().slice(0, 10) !== exportDate
      || typeof fileSha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(fileSha256)
      || typeof complete !== 'boolean' || typeof scope !== 'string' || !scope.trim() || scope.length > 240
      || /[\x00-\x1f\x7f]/.test(scope)) invalid();
  return { sourceSystem, exportDate, fileSha256: fileSha256.toLowerCase(), complete, scope: scope.trim() };
}

// The latest export is the observation under evaluation. An incomplete export interrupts
// comparison. The baseline is the preceding complete export and must cover the same scope.
const absenceProjection = `WITH ranked_exports AS (
  SELECT e.*, ROW_NUMBER() OVER (PARTITION BY source_system ORDER BY export_date DESC, id DESC) AS position
  FROM deviation_exports e WHERE site_id = ?
), baseline AS (
  SELECT latest.*, (SELECT previous.id FROM ranked_exports previous
    WHERE previous.source_system = latest.source_system AND previous.position > 1 AND previous.complete = TRUE
    ORDER BY previous.position LIMIT 1) AS previous_id
  FROM ranked_exports latest WHERE latest.position = 1
), projected AS (
  SELECT d.*, u.name AS internal_owner_name,
    CASE WHEN d.source_system IS NOT NULL AND d.source_id IS NOT NULL AND d.source_export_date IS NOT NULL THEN 'full'
      WHEN d.source_id IS NOT NULL OR d.source_export_date IS NOT NULL
        OR (d.source_system IS NOT NULL AND d.source_system <> 'internal') THEN 'partial' ELSE 'none' END AS traceability,
    CASE WHEN d.source_id IS NULL THEN 'untracked'
      WHEN latest.id IS NULL THEN 'no_export'
      WHEN latest.complete = FALSE THEN 'incomplete_export'
      WHEN previous.id IS NULL THEN 'single_export'
      WHEN previous.scope <> latest.scope THEN 'different_scope'
      WHEN previous.export_date = latest.export_date THEN 'same_export_date'
      WHEN current_row.deviation_id IS NOT NULL THEN 'present'
      WHEN previous_row.deviation_id IS NOT NULL THEN 'absent'
      ELSE 'outside_comparison' END AS absence_reason,
    CASE WHEN latest.complete = TRUE THEN latest.export_date END AS absence_export_date,
    CASE WHEN latest.complete = TRUE THEN latest.scope END AS absence_scope,
    (SELECT COUNT(*) FROM deviation_events h WHERE h.deviation_id = d.id
      AND h.from_status = 'closed' AND h.to_status <> 'closed') AS reopen_count
  FROM deviations d LEFT JOIN users u ON u.id = d.internal_owner_id
  LEFT JOIN baseline latest ON latest.source_system = d.source_system
  LEFT JOIN ranked_exports previous ON previous.id = latest.previous_id
  LEFT JOIN deviation_export_rows current_row ON current_row.export_id = latest.id AND current_row.deviation_id = d.id
  LEFT JOIN deviation_export_rows previous_row ON previous_row.export_id = previous.id AND previous_row.deviation_id = d.id
  WHERE d.site_id = ?
)`;

const publicDeviation = row => ({ ...row, reopen_count: Number(row.reopen_count),
  absence: row.absence_reason === 'absent' ? true : row.absence_reason === 'present' ? false : 'unknown' });

async function deviationFilters(db, { siteId: input, status, priority, withoutOwner, absent }) {
  const site = validId(input), clauses = ['1 = 1'], values = [site, site];
  if (status != null) {
    if (!statuses.includes(status)) fail(400, 'Unknown deviation status.', 'VALIDATION_ERROR');
    clauses.push('status = ?'); values.push(status);
  }
  if (priority != null) { clauses.push('priority = ?'); values.push(priority); }
  if (withoutOwner) clauses.push('internal_owner_id IS NULL');
  if (absent) clauses.push("absence_reason = 'absent'");
  await getSite(db, site);
  return { where: clauses.join(' AND '), values };
}

export async function listDeviations(db, { limit = 50, offset = 0, ...filters } = {}) {
  const { where, values } = await deviationFilters(db, filters);
  return (await db.all(`${absenceProjection} SELECT * FROM projected WHERE ${where}
    ORDER BY creation_date DESC NULLS LAST, deviation_no ASC NULLS LAST, id LIMIT ? OFFSET ?`, ...values, limit, offset)).map(publicDeviation);
}

export async function countDeviations(db, filters = {}) {
  const { where, values } = await deviationFilters(db, filters);
  return Number((await db.get(`${absenceProjection} SELECT COUNT(*) AS total FROM projected WHERE ${where}`, ...values)).total);
}

async function deviationRow(db, id) {
  const row = typeof id === 'string' && uuid.test(id)
    ? await db.get('SELECT * FROM deviations WHERE id = ?', id.toLowerCase()) : null;
  if (!row) fail(404, 'Deviation not found.', 'DEVIATION_NOT_FOUND');
  return row;
}

export async function getDeviation(db, id) {
  const { site_id: site, id: deviation } = await deviationRow(db, id);
  const row = await db.get(`${absenceProjection} SELECT * FROM projected WHERE id = ?`, site, site, deviation);
  return { ...publicDeviation(row), links: await db.all(`SELECT entity_type, entity_id FROM deviation_links
    WHERE deviation_id = ? ORDER BY entity_type, entity_id`, deviation) };
}

export async function latestDeviationImports(db, inputSite, user) {
  const site = validId(inputSite);
  await requireRole(db, site, user);
  await requireModule(db, site, user, 'deviations');
  return db.all(`SELECT source_system, export_date, file_sha256, scope FROM (
    SELECT e.*, ROW_NUMBER() OVER (PARTITION BY source_system ORDER BY export_date DESC, id DESC) AS position
    FROM deviation_exports e WHERE site_id = ? AND complete = TRUE
  ) ranked WHERE position = 1 ORDER BY source_system`, site);
}

export async function listDeviationEvents(db, id, user) {
  const row = await deviationRow(db, id);
  await requireRole(db, row.site_id, user);
  await requireModule(db, row.site_id, user, 'deviations');
  return (await db.all('SELECT * FROM deviation_events WHERE deviation_id = ? ORDER BY at, id', row.id))
    .map(event => ({ ...event, id: String(event.id) }));
}

async function appendDeviationEvent(tx, { id, at, actor, source, from, to, action, note = null }) {
  await tx.run(`INSERT INTO deviation_events (deviation_id, at, actor, actor_id, source, from_status, to_status, action, note)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, id, at, actor?.name ?? 'import', actor?.id ?? null, source, from, to ?? 'unknown', action, note);
}

export async function recordDeviationImportEvent(tx, before, after, at) {
  if (!before || (before.status === after.status && before.source_status === after.source_status)) return;
  await appendDeviationEvent(tx, { id: after.id, at, source: 'import', from: before.status, to: after.status,
    action: before.status === 'closed' && after.status !== 'closed' ? 'reopen' : 'import',
    note: before.source_status !== after.source_status ? JSON.stringify({ from: before.source_status, to: after.source_status }) : null });
}

function company(value) {
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > 200 || /[\x00-\x1f\x7f]/.test(value)) {
    fail(422, 'Invalid company name.', 'DEVIATION_ATTRIBUTION_INVALID');
  }
  return value.trim() || null;
}

async function governDeviation(db, id, user, action, change) {
  if (!user?.id) fail(401, 'Authentication required.', 'UNAUTHENTICATED');
  return db.transaction(async tx => {
    const { site_id: site, id: deviation } = await deviationRow(tx, id);
    await requireRole(tx, site, user, EDIT_ROLES);
    await requireModule(tx, site, user, 'deviations');
    await tx.run('UPDATE sites SET id = id WHERE id = ?', site);
    await requireRole(tx, site, user, EDIT_ROLES);
    await requireModule(tx, site, user, 'deviations');
    const before = await deviationRow(tx, deviation), at = new Date().toISOString();
    const note = await change(tx, before, at);
    if (note !== undefined) {
      const after = await deviationRow(tx, deviation);
      await appendAuditEvent(tx, { entityType: 'deviation', action: 'update', before, after, actor: user.id, at });
      await appendDeviationEvent(tx, { id: deviation, at, actor: user, source: 'internal', from: before.status,
        to: after.status, action, note: JSON.stringify(note) });
    }
    return getDeviation(tx, deviation);
  });
}

export function updateDeviationOwner(db, id, input, user) {
  return governDeviation(db, id, user, 'owner', async (tx, before, at) => {
    if (input?.userId !== null && (typeof input?.userId !== 'string' || !uuid.test(input.userId))) {
      fail(422, 'A site member UUID or null is required.', 'DEVIATION_OWNER_INVALID');
    }
    const owner = input.userId?.toLowerCase() ?? null;
    const member = owner && await tx.get(`SELECT u.name FROM accessible_site_members m JOIN users u ON u.id = m.user_id
      WHERE m.site_id = ? AND m.user_id = ? AND u.disabled_at IS NULL`, before.site_id, owner);
    if (owner && !member) {
      fail(422, 'The owner must be an active member of this site.', 'DEVIATION_OWNER_INVALID');
    }
    if (owner === before.internal_owner_id) return;
    await tx.run('UPDATE deviations SET internal_owner_id = ?, internal_owner_since = ? WHERE id = ?',
      owner, owner ? at : null, before.id);
    const former = before.internal_owner_id && await tx.get('SELECT name FROM users WHERE id = ?', before.internal_owner_id);
    return { from: before.internal_owner_id, to: owner, fromName: former?.name ?? null, toName: member?.name ?? null };
  });
}

export function updateDeviationAttribution(db, id, input, user) {
  return governDeviation(db, id, user, 'attribution', async (tx, before) => {
    if (!attributionStates.includes(input?.attributionState)) fail(422, 'Invalid attribution state.', 'DEVIATION_ATTRIBUTION_INVALID');
    const causing = company(input.causingCompany), resolving = company(input.resolvingCompany), state = input.attributionState;
    if (causing === before.causing_company && resolving === before.resolving_company && state === before.attribution_state) return;
    await tx.run('UPDATE deviations SET causing_company = ?, resolving_company = ?, attribution_state = ? WHERE id = ?',
      causing, resolving, state, before.id);
    return { causingCompany: causing, resolvingCompany: resolving, attributionState: state };
  });
}

export async function registeredDeviationExport(tx, site, meta) {
  return tx.get(`SELECT id FROM deviation_exports WHERE site_id = ? AND source_system = ? AND export_date = ?
    AND file_sha256 = ? AND complete = (CASE ? WHEN 'true' THEN TRUE ELSE FALSE END) AND scope = ?`,
  site, meta.sourceSystem, meta.exportDate, meta.fileSha256, String(meta.complete), meta.scope);
}

export async function storeDeviationExport(tx, site, meta, rows, at, { beforeExistingWrite } = {}) {
  const seen = new Set();
  for (const row of rows) {
    if (typeof row.source_id !== 'string' || !row.source_id.trim() || row.source_id.length > 500
        || /[\x00-\x1f\x7f]/.test(row.source_id) || seen.has(row.source_id)) {
      fail(422, 'The export requires distinct, stable source IDs. Reconcile unresolved rows before importing.', 'DEVIATION_IDENTITY_UNRESOLVED');
    }
    seen.add(row.source_id);
  }
  const batch = await tx.get(`INSERT INTO deviation_exports (site_id, source_system, export_date, file_sha256, complete, scope)
    VALUES (?, ?, ?, ?, CASE ? WHEN 'true' THEN TRUE ELSE FALSE END, ?) RETURNING id`,
  site, meta.sourceSystem, meta.exportDate, meta.fileSha256, String(meta.complete), meta.scope);
  for (const row of rows) {
    let before = await tx.get('SELECT * FROM deviations WHERE site_id = ? AND source_system = ? AND source_id = ?',
      site, meta.sourceSystem, row.source_id);
    if (!before && row.source_entity_key_id) {
      // Adopt only a previously trusted identity, never a display label or a row number.
      const legacy = await tx.all('SELECT * FROM deviations WHERE site_id = ? AND source_system IS NULL AND source_entity_key_id = ?',
        site, row.source_entity_key_id);
      if (legacy.length > 1) fail(409, 'More than one legacy row matches the source identity.', 'DEVIATION_IDENTITY_UNRESOLVED');
      [before] = legacy;
    }
    const id = before?.id ?? stableId('deviation', site, meta.sourceSystem, row.source_id);
    if (before) await beforeExistingWrite?.(before);
    if (!before?.source_export_date || meta.exportDate >= before.source_export_date) {
      const values = { ...Object.fromEntries(fields.map(field => [field, row[field] ?? null])),
        source_entity_key_id: row.source_entity_key_id ?? before?.source_entity_key_id ?? null,
        source_system: meta.sourceSystem, source_id: row.source_id, source_status: row.source_status ?? null, source_export_date: meta.exportDate };
      const columns = Object.keys(values), args = Object.values(values);
      if (before) await tx.run(`UPDATE deviations SET ${columns.map(column => `${column} = ?`).join(', ')} WHERE id = ?`, ...args, id);
      else await tx.run(`INSERT INTO deviations (id, site_id, created_at, ${columns.join(', ')})
        VALUES (?, ?, ?, ${columns.map(() => '?').join(', ')})`, id, site, at, ...args);
      await recordDeviationImportEvent(tx, before, { ...values, id }, at);
    }
    if (meta.complete) {
      await tx.run('INSERT INTO deviation_export_rows (export_id, deviation_id) VALUES (?, ?)', batch.id, id);
      await tx.run(`UPDATE deviations SET last_seen_in_export_date = ? WHERE id = ?
        AND (last_seen_in_export_date IS NULL OR last_seen_in_export_date < ?)`, meta.exportDate, id, meta.exportDate);
    }
  }
  return batch;
}

export async function importDeviations(db, inputSite, user, metadata) {
  if (!user?.id) fail(401, 'Authentication required.', 'UNAUTHENTICATED');
  const site = validId(inputSite);
  const meta = metadata === undefined ? null : deviationImportMeta(metadata);
  return db.transaction(async tx => {
    await requireRole(tx, site, user, ['owner']);
    await requireModule(tx, site, user, 'deviations');
    // Serialize promotions for the site on both storage drivers.
    await tx.run('UPDATE sites SET id = id WHERE id = ?', site);
    const config = await tx.get('SELECT * FROM deviation_import_sources WHERE site_id = ?', site);
    if (!config) fail(409, 'Configure an explicit source scope and completed import run for this site.', 'DEVIATION_SOURCE_NOT_CONFIGURED');
    let run, rows;
    try {
      run = await tx.get(`SELECT r.id, r.scope_id, r.source_timezone, rb.batch_id, b.expected_rows, b.content_sha256
        FROM ingest.import_runs r JOIN ingest.run_batches rb ON rb.run_id = r.id AND rb.scope_id = r.scope_id
        JOIN ingest.import_batches b ON b.id = rb.batch_id AND b.scope_id = rb.scope_id AND b.family = rb.family
        WHERE r.id = ? AND r.scope_id = ? AND r.status = 'ready' AND r.completeness_verified = TRUE
          AND rb.family = 'deviations' AND b.status = 'typed'`, config.run_id, config.scope_id);
      if (!run) fail(409, 'A complete ready run with a typed Deviations batch is required.', 'DEVIATION_RUN_NOT_READY');
      // Cast before decoding: source wall times must never become host-local Date objects.
      rows = await tx.all(`SELECT ${fields.map(field => dateFields.includes(field)
        ? `CAST(s.${field} AS TEXT) AS ${field}`
        : field === 'status' ? 's.source_status' : `s.${field}`).join(', ')},
        s._source_row AS source_row, s.source_uuid, e.id AS source_entity_key_id, e.identity_state
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
    if (meta && run.content_sha256.toLowerCase() !== meta.fileSha256) fail(422, 'The export checksum does not match the imported file.', 'DEVIATION_EXPORT_CHECKSUM_MISMATCH');
    if (meta ? await registeredDeviationExport(tx, site, meta) : config.promoted_run_id === run.id && config.promoted_batch_id === run.batch_id) {
      return { imported: 0, unchanged: true, unmapped_status: 0, run_id: run.id };
    }
    for (const row of rows) {
      row.id = stableId(site, run.scope_id, Number(row.source_row));
      if (!['observed', 'manual'].includes(row.identity_state)) row.source_entity_key_id = null;
      row.source_id = row.source_entity_key_id ? row.source_uuid : null;
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
    if (meta) await storeDeviationExport(tx, site, meta, rows, at);
    else {
      // Legacy projection keeps its established row identity and source scope binding.
      for (const row of rows) {
        const before = await tx.get('SELECT * FROM deviations WHERE id = ?', row.id);
        if (before?.source_system != null) fail(409, 'Use export metadata for this tracked deviation.', 'DEVIATION_IDENTITY_UNRESOLVED');
        await tx.run(`INSERT INTO deviations (id, ${columns.join(', ')}, created_at)
          VALUES (?, ${columns.map(() => '?').join(', ')}, ?)
          ON CONFLICT (id) DO UPDATE SET ${columns.map(column => `${column} = excluded.${column}`).join(', ')}`,
        row.id, ...columns.map(column => column === 'site_id' ? site : row[column] ?? null), at);
        await recordDeviationImportEvent(tx, before, { ...row, source_status: null }, at);
      }
    }
    await tx.run(`UPDATE deviation_import_sources SET promoted_run_id = ?, promoted_batch_id = ?,
      promoted_at = ?, updated_at = ? WHERE site_id = ?`, run.id, run.batch_id, at, at, site);
    return { imported: rows.length, unchanged: false, unmapped_status: rows.filter(row => row.status == null).length, run_id: run.id };
  });
}
