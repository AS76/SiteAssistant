import { createHash } from 'node:crypto';
import { RepositoryError, getSite, requireRole } from './repository.mjs';

const fail = (status, message, code = 'WBS_RECONCILIATION_REQUIRED') => { throw new RepositoryError(status, message, code); };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fields = ['description', 'sort_order', 'summary_task', 'progress_pct', 'planned_start', 'planned_finish',
  'actual_start', 'actual_finish', 'planned_hours', 'section', 'plc_area', 'assigned_to'];
const dateFields = fields.filter(field => field.endsWith('_start') || field.endsWith('_finish'));
const order = 'ORDER BY level, CASE WHEN sort_order IS NULL THEN 1 ELSE 0 END, sort_order, wbs_code, id';
const publicNode = row => ({ ...row, is_synthetic: Boolean(row.is_synthetic),
  summary_task: row.summary_task === null ? null : Boolean(row.summary_task) });
function siteId(value) {
  if (typeof value !== 'string' || !uuid.test(value)) fail(400, 'site_id must be a UUID.', 'VALIDATION_ERROR');
  return value.toLowerCase();
}
function stableId(...parts) {
  const hex = createHash('sha256').update(JSON.stringify(parts)).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export async function listWbs(db, { siteId: input, flat } = {}) {
  const id = siteId(input);
  await getSite(db, id);
  const rows = (await db.all(`SELECT * FROM project_structure WHERE site_id = ? ${order}`, id)).map(publicNode);
  if (flat === 1 || flat === '1' || flat === true) return rows;
  const nodes = new Map(rows.map(row => [row.id, { ...row, children: [] }]));
  const roots = [];
  for (const node of nodes.values()) {
    const parent = nodes.get(node.parent_id);
    // Also fail safely for a manually corrupted projection.
    if (parent && parent.level < node.level) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

export async function getWbs(db, id) {
  const row = typeof id === 'string' && uuid.test(id) ? await db.get('SELECT * FROM project_structure WHERE id = ?', id.toLowerCase()) : null;
  if (!row) fail(404, 'WBS node not found.', 'WBS_NOT_FOUND');
  const children = await db.all(`SELECT * FROM project_structure WHERE parent_id = ? AND site_id = ? ${order}`, row.id, row.site_id);
  return { ...publicNode(row), children: children.map(publicNode) };
}

// Source timestamps have no offset. Resolve only with an explicitly declared zone;
// reject ambiguous/nonexistent DST wall times instead of inventing an instant.
export function sourceTimestamp(value, zone) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') fail(409, 'Invalid source timestamp.');
  const match = /^(\d{4}-\d\d-\d\d)[T ](\d\d:\d\d:\d\d)(\.\d{1,6})?(Z|[+-]\d\d:\d\d)?$/.exec(value);
  if (!match) fail(409, 'Source timestamp requires seconds and an explicit zone or source_timezone.');
  const wall = `${match[1]}T${match[2]}`;
  const ms = Date.parse(`${wall}Z`);
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 19) !== wall) fail(409, 'Invalid source timestamp.');
  if (match[4]) {
    const offset = match[4] === 'Z' ? 0 : (Number(match[4].slice(1, 3)) * 60 + Number(match[4].slice(4))) * (match[4][0] === '-' ? -1 : 1);
    if (Math.abs(offset) > 14 * 60 || (match[4] !== 'Z' && Number(match[4].slice(4)) > 59)) fail(409, 'Invalid timestamp offset.');
    return new Date(ms - offset * 60000).toISOString().slice(0, 19) + (match[3] || '.000') + 'Z';
  }
  let formatter;
  try {
    if (!zone) throw new Error();
    formatter = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  } catch { fail(409, 'An explicit valid source_timezone is required for source dates.'); }
  const asWall = instant => {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(instant)).map(part => [part.type, part.value]));
    return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
  };
  const offsets = new Set([-86400000, 0, 86400000].map(delta => Date.parse(asWall(ms + delta) + 'Z') - ms - delta));
  const candidates = [...offsets].map(offset => ms - offset).filter(instant => asWall(instant) === wall);
  if (candidates.length !== 1) fail(409, 'Ambiguous or nonexistent source local time requires reconciliation.');
  return new Date(candidates[0]).toISOString().slice(0, 19) + (match[3] || '.000') + 'Z';
}

// Only dotted codes declare ancestry. A level/order alone cannot identify a missing parent.
function parentCode(code) {
  return /^[^.\s]+(?:\.[^.\s]+)+$/.test(code) ? code.slice(0, code.lastIndexOf('.')) : null;
}
function hierarchy(rows, site, scope) {
  const nodes = [], byCode = new Map(), identities = new Set();
  const key = (plan, code) => JSON.stringify([plan, code]);
  for (const row of rows) {
    if (!uuid.test(row.source_uuid || '') || identities.has(row.source_uuid.toLowerCase()) ||
        !row.source_entity_key_id || row.identity_state === 'unresolved' ||
        typeof row.wbs_code !== 'string' || !row.wbs_code.trim() || !Number.isInteger(row.level) || row.level < 0 || row.level > 9) {
      fail(409, 'Missing/duplicate source identity, WBS code or valid level; reconcile the snapshot.');
    }
    identities.add(row.source_uuid.toLowerCase());
    const node = { ...row, source_uuid: row.source_uuid.toLowerCase(),
      id: stableId(site, scope, row.source_uuid.toLowerCase()), parent_id: null, is_synthetic: false };
    nodes.push(node);
    const codeKey = key(node.project_plan, node.wbs_code);
    byCode.set(codeKey, [...(byCode.get(codeKey) || []), node]);
  }
  const link = node => {
    if (node.level === 0) return;
    const code = parentCode(node.wbs_code);
    if (!code) return;
    const codeKey = key(node.project_plan, code);
    let candidates = byCode.get(codeKey);
    if (candidates?.length > 1) fail(409, 'Duplicate WBS parent code within a project plan; reconcile the snapshot.', 'WBS_AMBIGUOUS_PARENT');
    if (!candidates) {
      const parent = { id: stableId(site, scope, 'synthetic', node.project_plan, code), wbs_code: code,
        project_plan: node.project_plan, level: node.level - 1, parent_id: null, is_synthetic: true,
        source_uuid: null, source_entity_key_id: null, ...Object.fromEntries(fields.map(field => [field, null])) };
      byCode.set(codeKey, [parent]); nodes.push(parent); link(parent); candidates = [parent];
    }
    const parent = candidates[0];
    if (parent.level !== node.level - 1) fail(409, 'WBS code ancestry conflicts with source levels; reconcile the snapshot.');
    node.parent_id = parent.id;
  };
  for (const node of [...nodes].sort((a, b) => a.level - b.level || (a.sort_order ?? Infinity) - (b.sort_order ?? Infinity))) link(node);
  return nodes.sort((a, b) => a.level - b.level || (a.sort_order ?? Infinity) - (b.sort_order ?? Infinity));
}

export async function importWbs(db, inputSite, user) {
  if (!user?.id) fail(401, 'Authentication required.', 'UNAUTHENTICATED');
  const site = siteId(inputSite);
  return db.transaction(async tx => {
    await requireRole(tx, site, user, ['owner']);
    // Serialize promotions of a site on PostgreSQL as well as SQLite.
    await tx.run('UPDATE sites SET id = id WHERE id = ?', site);
    const config = await tx.get('SELECT * FROM wbs_import_sources WHERE site_id = ?', site);
    if (!config) fail(409, 'Configure an explicit source scope and completed import run for this site.', 'WBS_SOURCE_NOT_CONFIGURED');
    let run, rows;
    try {
      run = await tx.get(`SELECT r.id, r.scope_id, r.source_timezone, rb.batch_id, b.expected_rows
        FROM ingest.import_runs r JOIN ingest.run_batches rb ON rb.run_id = r.id AND rb.scope_id = r.scope_id
        JOIN ingest.import_batches b ON b.id = rb.batch_id AND b.scope_id = rb.scope_id AND b.family = rb.family
        WHERE r.id = ? AND r.scope_id = ? AND r.status = 'ready' AND r.completeness_verified = TRUE
          AND rb.family = 'time_schedule' AND b.status = 'typed'`, config.run_id, config.scope_id);
      if (!run) fail(409, 'A complete ready run with a typed Time Schedule batch is required.', 'WBS_RUN_NOT_READY');
      if (config.promoted_run_id === run.id && config.promoted_batch_id === run.batch_id) {
        return { imported: 0, synthetic: 0, unchanged: true, run_id: run.id };
      }
      // Cast before driver decoding: a TIMESTAMP WITHOUT TIME ZONE must not become a host-local Date.
      const sourceColumns = ['source_uuid', 'project_plan', 'wbs_code', 'level', ...fields];
      rows = await tx.all(`SELECT ${sourceColumns.map(field => dateFields.includes(field)
        ? `CAST(s.${field} AS TEXT) AS ${field}` : `s.${field}`).join(', ')},
        e.id AS source_entity_key_id, e.identity_state
        FROM source_snapshot.time_schedule s LEFT JOIN ingest.entity_keys e
          ON e.scope_id = s._scope_id AND e.family = 'time_schedule' AND e.external_key = s._identity_key
        WHERE s._batch_id = ? AND s._scope_id = ? ORDER BY s.level, s.sort_order, s._source_row`, run.batch_id, run.scope_id);
    } catch (error) {
      if (['42P01', '3F000'].includes(error.code) || /no such table/.test(error.message)) {
        fail(409, 'Time Schedule ingestion schemas are not available.', 'WBS_SOURCE_UNAVAILABLE');
      }
      throw error;
    }
    if (rows.length !== Number(run.expected_rows)) fail(409, 'Snapshot row count differs from the typed batch.', 'WBS_INCOMPLETE_SNAPSHOT');
    const nodes = hierarchy(rows, site, run.scope_id);
    for (const node of nodes) for (const field of dateFields) node[field] = sourceTimestamp(node[field], run.source_timezone);
    const at = new Date().toISOString();
    const existing = await tx.all('SELECT id FROM project_structure WHERE site_id = ?', site);
    // Rebuild links in the same transaction, retaining IDs/created_at of surviving identities.
    await tx.run('UPDATE project_structure SET parent_id = NULL WHERE site_id = ?', site);
    const ids = new Set(nodes.map(node => node.id));
    for (const row of existing) if (!ids.has(row.id)) await tx.run('DELETE FROM project_structure WHERE id = ? AND site_id = ?', row.id, site);
    const columns = ['site_id', 'parent_id', 'source_uuid', 'wbs_code', 'level', ...fields, 'source_entity_key_id'];
    for (const node of nodes) {
      const values = columns.map(column => column === 'site_id' ? site : column === 'summary_task' && node[column] != null ? String(Boolean(node[column])) : node[column] ?? null);
      // Boolean literals are portable; nullable summary_task uses an explicit SQL CASE below.
      const placeholders = columns.map(column => column === 'summary_task' ? "CASE ? WHEN 'true' THEN TRUE WHEN 'false' THEN FALSE ELSE NULL END" : '?');
      await tx.run(`INSERT INTO project_structure (id, ${columns.join(', ')}, is_synthetic, created_at)
        VALUES (?, ${placeholders.join(', ')}, ${node.is_synthetic ? 'TRUE' : 'FALSE'}, ?)
        ON CONFLICT (id) DO UPDATE SET ${columns.map(column => `${column} = excluded.${column}`).join(', ')}, is_synthetic = excluded.is_synthetic`,
      node.id, ...values, at);
    }
    await tx.run('UPDATE wbs_import_sources SET promoted_run_id = ?, promoted_batch_id = ?, promoted_at = ? WHERE site_id = ?', run.id, run.batch_id, at, site);
    return { imported: rows.length, synthetic: nodes.length - rows.length, unchanged: false, run_id: run.id };
  });
}
