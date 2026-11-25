import { requireModule } from './module-access.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { EDIT_ROLES, RepositoryError, getSite, requireRole } from './repository.mjs';

const fail = (status, message, code = 'WBS_RECONCILIATION_REQUIRED') => { throw new RepositoryError(status, message, code); };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fields = ['description', 'sort_order', 'summary_task', 'progress_pct', 'planned_start', 'planned_finish',
  'actual_start', 'actual_finish', 'planned_hours', 'section', 'plc_area', 'assigned_to'];
const dateFields = fields.filter(field => field.endsWith('_start') || field.endsWith('_finish'));
const order = 'ORDER BY level, CASE WHEN sort_order IS NULL THEN 1 ELSE 0 END, sort_order, wbs_code, id';
const editFields = ['description', 'parent_id', 'sort_order'];
const parse = value => JSON.parse(value || '{}');
function publicNode(row, override) {
  const source = { ...row };
  const local = {}, conflicts = override ? parse(override.conflicts_json) : {};
  for (const field of editFields) if (override?.[`${field === 'parent_id' ? 'parent' : field}_set`]) local[field] = override[field];
  return { ...row, ...local, is_synthetic: Boolean(row.is_synthetic), missing_from_source: Boolean(row.missing_from_source),
    summary_task: row.summary_task === null ? null : Boolean(row.summary_task),
    source_values: source, local_overrides: local, conflicts,
    override_source_values: override ? parse(override.source_values_json) : {},
    provenance: { origin: row.source_scope || row.source_uuid ? 'source' : row.is_synthetic ? 'synthetic' : 'native',
      scope: row.source_scope, run_id: row.source_run_id, source_uuid: row.source_uuid,
      updated_at: override?.updated_at ?? row.updated_at, updated_by: override?.updated_by ?? row.updated_by } };
}
function siteId(value) {
  if (typeof value !== 'string' || !uuid.test(value)) fail(400, 'site_id must be a UUID.', 'VALIDATION_ERROR');
  return value.toLowerCase();
}
export function stableId(...parts) {
  const hex = createHash('sha256').update(JSON.stringify(parts)).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

async function effectiveRows(db, site) {
  const rows = await db.all(`SELECT * FROM project_structure WHERE site_id = ? ${order}`, site);
  const overrides = new Map((await db.all('SELECT * FROM wbs_node_overrides WHERE site_id = ?', site)).map(row => [row.wbs_id, row]));
  const nodes = rows.map(row => publicNode(row, overrides.get(row.id))), byId = new Map(nodes.map(row => [row.id, row]));
  const level = (node, seen = new Set()) => {
    if (seen.has(node.id)) fail(409, 'The parent would create a cycle.', 'WBS_CYCLE');
    seen.add(node.id);
    const parent = byId.get(node.parent_id);
    return parent ? level(parent, seen) + 1 : node.source_values.level;
  };
  for (const node of nodes) node.level = level(node);
  return nodes.sort((a, b) => a.level - b.level || (a.sort_order ?? Infinity) - (b.sort_order ?? Infinity)
    || a.wbs_code.localeCompare(b.wbs_code) || a.id.localeCompare(b.id));
}
export async function listWbs(db, { siteId: input, flat } = {}) {
  const site = siteId(input);
  await getSite(db, site);
  const rows = await effectiveRows(db, site);
  if (flat === 1 || flat === '1' || flat === true) return rows;
  const nodes = new Map(rows.map(row => [row.id, { ...row, children: [] }])), roots = [];
  for (const node of nodes.values()) {
    const parent = nodes.get(node.parent_id);
    if (parent) parent.children.push(node); else roots.push(node);
  }
  return roots;
}
export async function getWbs(db, id) {
  const row = typeof id === 'string' && uuid.test(id) ? await db.get('SELECT * FROM project_structure WHERE id = ?', id.toLowerCase()) : null;
  if (!row) fail(404, 'WBS node not found.', 'WBS_NOT_FOUND');
  const rows = await effectiveRows(db, row.site_id);
  return { ...rows.find(node => node.id === row.id), children: rows.filter(node => node.parent_id === row.id) };
}
async function writer(tx, site, user) {
  if (!user?.id) fail(401, 'Authentication required.', 'UNAUTHENTICATED');
  await requireRole(tx, site, user, EDIT_ROLES);
  await requireModule(tx, site, user, 'wbs');
  await tx.run('UPDATE sites SET id = id WHERE id = ?', site);
  await requireRole(tx, site, user, EDIT_ROLES);
  await requireModule(tx, site, user, 'wbs');
}
function editInput(input, create = false) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail(400, 'Invalid node.', 'VALIDATION_ERROR');
  const allowed = [...editFields, 'archived', 'reset_fields', 'keep_fields', ...(create ? ['site_id', 'wbs_code'] : [])];
  if (Object.keys(input).some(key => !allowed.includes(key))) fail(400, 'Source fields are read only.', 'VALIDATION_ERROR');
  if (Object.hasOwn(input, 'description') && input.description !== null && (typeof input.description !== 'string' || input.description.length > 4000)) fail(400, 'Invalid description.', 'VALIDATION_ERROR');
  if (Object.hasOwn(input, 'parent_id') && input.parent_id !== null) input = { ...input, parent_id: siteId(input.parent_id) };
  if (Object.hasOwn(input, 'sort_order') && input.sort_order !== null && (!Number.isSafeInteger(input.sort_order) || Math.abs(input.sort_order) > 2147483647)) fail(400, 'Invalid order.', 'VALIDATION_ERROR');
  if (Object.hasOwn(input, 'archived') && typeof input.archived !== 'boolean') fail(400, 'Invalid archive state.', 'VALIDATION_ERROR');
  for (const key of ['reset_fields', 'keep_fields']) if (input[key] !== undefined && (!Array.isArray(input[key]) || input[key].some(field => !editFields.includes(field)))) fail(400, 'Invalid resolution.', 'VALIDATION_ERROR');
  return input;
}
async function parentInSite(tx, site, parent) {
  if (parent && !await tx.get('SELECT id FROM project_structure WHERE id = ? AND site_id = ?', parent, site)) fail(400, 'Parent must belong to this site.', 'WBS_WRONG_SITE');
}
export async function createWbs(db, input, user) {
  input = editInput(input, true);
  const site = siteId(input.site_id);
  if (typeof input.wbs_code !== 'string' || !input.wbs_code.trim() || input.wbs_code.length > 100) fail(400, 'A code is required.', 'VALIDATION_ERROR');
  return db.transaction(async tx => {
    await writer(tx, site, user);
    await parentInSite(tx, site, input.parent_id);
    const id = randomUUID(), at = new Date().toISOString();
    const parent = input.parent_id ? await getWbs(tx, input.parent_id) : null;
    await tx.run(`INSERT INTO project_structure (id, site_id, wbs_code, description, parent_id, sort_order, level, created_at, updated_at, updated_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, id, site, input.wbs_code.trim(), input.description ?? null,
    input.parent_id ?? null, input.sort_order ?? null, parent ? parent.level + 1 : 0, at, at, user.id);
    return getWbs(tx, id);
  });
}
export async function updateWbs(db, id, input, user) {
  input = editInput(input);
  return db.transaction(async tx => {
    const node = await getWbs(tx, id);
    await writer(tx, node.site_id, user);
    await parentInSite(tx, node.site_id, input.parent_id);
    if (input.parent_id === node.id) fail(400, 'A node cannot be its own parent.', 'WBS_CYCLE');
    const old = await tx.get('SELECT * FROM wbs_node_overrides WHERE wbs_id = ?', node.id);
    const local = { ...node.local_overrides }, snapshots = old ? parse(old.source_values_json) : {}, conflicts = { ...node.conflicts };
    for (const field of editFields) {
      if (Object.hasOwn(input, field)) {
        local[field] = input[field];
        if (!Object.hasOwn(snapshots, field)) snapshots[field] = node.source_values[field];
      }
      if (input.reset_fields?.includes(field)) { delete local[field]; delete snapshots[field]; delete conflicts[field]; }
      if (input.keep_fields?.includes(field)) { snapshots[field] = node.source_values[field]; delete conflicts[field]; }
    }
    const at = new Date().toISOString();
    await tx.run(`INSERT INTO wbs_node_overrides (wbs_id, site_id, description, description_set, parent_id, parent_set,
      sort_order, sort_order_set, source_values_json, conflicts_json, updated_at, updated_by)
      VALUES (?, ?, ?, CASE ? WHEN 'true' THEN TRUE ELSE FALSE END, ?, CASE ? WHEN 'true' THEN TRUE ELSE FALSE END,
      ?, CASE ? WHEN 'true' THEN TRUE ELSE FALSE END, ?, ?, ?, ?)
      ON CONFLICT (wbs_id) DO UPDATE SET description = excluded.description, description_set = excluded.description_set,
      parent_id = excluded.parent_id, parent_set = excluded.parent_set, sort_order = excluded.sort_order, sort_order_set = excluded.sort_order_set,
      source_values_json = excluded.source_values_json, conflicts_json = excluded.conflicts_json, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    node.id, node.site_id, local.description ?? null, String(Object.hasOwn(local, 'description')), local.parent_id ?? null,
    String(Object.hasOwn(local, 'parent_id')), local.sort_order ?? null, String(Object.hasOwn(local, 'sort_order')), JSON.stringify(snapshots), JSON.stringify(conflicts), at, user.id);
    await tx.run('UPDATE project_structure SET updated_at = ?, updated_by = ?, archived_at = ? WHERE id = ?', at, user.id,
      input.archived === undefined ? node.archived_at : input.archived ? at : null, node.id);
    // Reading the effective graph validates self-parent and cycles before committing.
    return getWbs(tx, node.id);
  });
}

// Both import paths use one operational row. Prefer UUID identity; only
// legacy/upload rows may adopt a unique code without a source UUID. Codes alone
// are never used to merge different source identities, plans or sites.
export async function sourceNodeId(tx, site, node, fallback) {
  if (node.source_uuid) {
    const found = await tx.get('SELECT id FROM project_structure WHERE site_id = ? AND source_uuid = ?', site, node.source_uuid);
    if (found) return found.id;
  }
  // A synthetic ancestor is identified by its deterministic fallback ID. Adopting
  // a real or another plan's node by code would overwrite that identity and merge
  // unrelated branches.
  if (node.is_synthetic) return fallback;
  const candidates = await tx.all('SELECT id, source_uuid FROM project_structure WHERE site_id = ? AND wbs_code = ?', site, node.wbs_code);
  // Legacy/upload rows may adopt a unique code only when that row has no source
  // identity to lose. A source-bearing parent is never overwritten by a row without one.
  if (candidates.length === 1 && !candidates[0].source_uuid) return candidates[0].id;
  return fallback;
}
export async function reconcileWbsSource(tx, { site, id, values, scope, run, user, unchanged = false, at = new Date().toISOString() }) {
  const old = await tx.get('SELECT * FROM project_structure WHERE id = ? AND site_id = ?', id, site);
  if (unchanged && old && !old.missing_from_source && old.source_scope === scope) return;
  const override = await tx.get('SELECT * FROM wbs_node_overrides WHERE wbs_id = ?', id);
  if (override) {
    const snapshots = parse(override.source_values_json), conflicts = parse(override.conflicts_json);
    for (const field of editFields) if (override[`${field === 'parent_id' ? 'parent' : field}_set`] && Object.hasOwn(values, field)
      && JSON.stringify(snapshots[field] ?? null) !== JSON.stringify(values[field] ?? null)) conflicts[field] = true;
    await tx.run('UPDATE wbs_node_overrides SET conflicts_json = ? WHERE wbs_id = ?', JSON.stringify(conflicts), id);
  }
  const columns = Object.keys(values), args = columns.map(key => typeof values[key] === 'boolean' ? String(values[key]) : values[key]);
  const placeholders = columns.map(key => typeof values[key] === 'boolean' ? "CASE ? WHEN 'true' THEN TRUE ELSE FALSE END" : '?');
  if (old) await tx.run(`UPDATE project_structure SET ${columns.map((key, i) => `${key} = ${placeholders[i]}`).join(', ')},
    source_scope = ?, source_run_id = ?, missing_from_source = FALSE WHERE id = ? AND site_id = ?`, ...args, scope, run, id, site);
  else await tx.run(`INSERT INTO project_structure (id, site_id, ${columns.join(', ')}, source_scope, source_run_id, created_at)
    VALUES (?, ?, ${placeholders.join(', ')}, ?, ?, ?)`, id, site, ...args, scope, run, at);
}
export async function reconcileWbsMissing(tx, site, scope, run, complete, seenIds) {
  // Absence is evidence only in a verified complete snapshot of this source scope.
  if (complete) {
    const seen = new Set(seenIds);
    const previous = await tx.all('SELECT id FROM project_structure WHERE site_id = ? AND source_scope = ?', site, scope);
    for (const row of previous) if (!seen.has(row.id)) await tx.run('UPDATE project_structure SET missing_from_source = TRUE WHERE id = ?', row.id);
  }
  await effectiveRows(tx, site);
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
    await requireModule(tx, site, user, 'wbs');
    // Serialize promotions of a site on PostgreSQL as well as SQLite.
    await tx.run('UPDATE sites SET id = id WHERE id = ?', site);
    const config = await tx.get('SELECT * FROM wbs_import_sources WHERE site_id = ?', site);
    if (!config) fail(409, 'Configure an explicit source scope and completed import run for this site.', 'WBS_SOURCE_NOT_CONFIGURED');
    let run, rows;
    try {
      run = await tx.get(`SELECT r.id, r.scope_id, r.source_timezone, r.completeness_verified, rb.batch_id, b.expected_rows
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
    // Resolve every identity before assigning parents; never delete absent nodes or
    // detach existing links. Synthetic ancestors keep their deterministic IDs.
    const mapped = new Map();
    for (const node of nodes) mapped.set(node.id, await sourceNodeId(tx, site, node, node.id));
    for (const node of nodes) {
      const values = Object.fromEntries(['parent_id', 'source_uuid', 'wbs_code', 'level', ...fields, 'source_entity_key_id', 'is_synthetic']
        .map(column => [column, column === 'parent_id' ? mapped.get(node.parent_id) ?? null : node[column] ?? null]));
      await reconcileWbsSource(tx, { site, id: mapped.get(node.id), values, scope: run.scope_id, run: run.id, user, at });
    }
    await reconcileWbsMissing(tx, site, run.scope_id, run.id, Boolean(run.completeness_verified), [...mapped.values()]);
    await tx.run('UPDATE wbs_import_sources SET promoted_run_id = ?, promoted_batch_id = ?, promoted_at = ? WHERE site_id = ?', run.id, run.batch_id, at, site);
    return { imported: rows.length, synthetic: nodes.length - rows.length, unchanged: false, run_id: run.id };
  });
}
