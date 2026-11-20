import { requireModule } from './module-access.mjs';
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { deviationImportMeta, recordDeviationImportEvent, registeredDeviationExport, storeDeviationExport } from './deviations.mjs';
import { readWorkbook } from './xlsx.mjs';
import { RepositoryError, requireRole } from './repository.mjs';
import { sourceTimestamp, stableId, reconcileWbsSource, reconcileWbsMissing } from './wbs.mjs';

const fail = (code, message, status = 400) => { throw new RepositoryError(status, message, code); };
export const MAX_IMPORT_BYTES = 20 * 1024 * 1024;
const TOKEN_AGE = 15 * 60 * 1000;
const tokenSecret = process.env.PLANNING_IMPORT_TOKEN_SECRET || randomBytes(32);
const text = value => value == null || String(value).trim() === '' ? null : String(value).trim();
const sourceText = value => value == null ? null : String(value);
const number = value => {
  if (text(value) === null) return null;
  const raw = text(value).replace(',', '.');
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(raw) || !Number.isFinite(Number(raw))) fail('INVALID_NUMBER', 'Expected a finite decimal number.');
  return Number(raw);
};
const boolean = value => {
  if (text(value) === null) return null;
  const raw = String(value).trim().toLowerCase();
  if (['true', 'yes', '1'].includes(raw)) return true;
  if (['false', 'no', '0'].includes(raw)) return false;
  fail('INVALID_BOOLEAN', 'Expected true/false, yes/no or 1/0.');
};
const canonicalInstant = value => {
  const raw = value instanceof Date ? value.toISOString() : String(value);
  const fraction = /:\d\d\.(\d{1,6})/.exec(raw)?.[1] || '';
  return `${new Date(raw).toISOString().slice(0, 19)}.${fraction.padEnd(6, '0')}Z`;
};
const timestamp = value => {
  const raw = text(value);
  if (raw === null) return null;
  if (!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(raw)) {
    fail('INVALID_DATE', 'Expected an ISO 8601 timestamp with an explicit offset.');
  }
  try { return canonicalInstant(sourceTimestamp(raw)); }
  catch { fail('INVALID_DATE', 'Invalid timestamp.'); }
};
// Calendar dates and clock times retain their local meaning.
const date = value => {
  const raw = text(value);
  if (raw === null) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) fail('INVALID_DATE', 'Expected YYYY-MM-DD.');
  try { sourceTimestamp(raw + 'T00:00:00Z'); }
  catch { fail('INVALID_DATE', 'Invalid calendar date.'); }
  return raw;
};
const time = value => {
  const raw = text(value);
  if (raw === null) return null;
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(raw)) fail('INVALID_TIME', 'Expected HH:MM or HH:MM:SS.');
  return raw.length === 5 ? raw + ':00' : raw;
};
const integer = value => {
  const result = number(value);
  if (result !== null && (!Number.isSafeInteger(result) || result < 0 || result > 2147483647)) fail('INVALID_NUMBER', 'Expected a nonnegative 32-bit integer.');
  return result;
};
const statuses = new Set(['open', 'in_progress', 'completed', 'closed', 'rejected']);
const status = value => {
  const label = text(value)?.toLowerCase();
  if (!statuses.has(label)) fail('UNKNOWN_STATUS', 'Unrecognized deviation status.');
  return label === 'completed' ? 'work_completed' : label;
};
const col = (field, normalize = text) => ({ field, normalize });
const common = {
  title: col('description'), area_code: col('plc_area'), section: col('section'), assignee: col('assigned_to'),
  planned_start: col('planned_start', timestamp), planned_finish: col('planned_finish', timestamp),
  actual_start: col('actual_start', timestamp),
};
export const DEFAULT_IDENTITIES = Object.freeze(Object.fromEntries(Object.entries({
  employees: ['employee_no'], work_days: ['operational_date', 'employee_no'], time_schedule: ['wbs_code'],
  site_progress_items: ['description', 'planned_start', 'planned_finish', 'plc_area', 'section'],
  deviations: ['deviation_no'], daily_log: ['operational_date'],
}).map(([family, fields]) => [family, Object.freeze(fields)])));
const definition = (table, columns, required) => ({ table, columns, required });

// Fixed public column contract. Missing optional columns never erase existing fields.
export const FAMILIES = {
  employees: definition('employees', {
    employee_id: col('employee_no'), given_name: col('first_name'), family_name: col('last_name'),
    organisation: col('company'), role: col('qualification'), supervisor_id: col('supervisor'), team: col('team'),
    start_date: col('hire_date', date), end_date: col('expire_date', date),
  }, ['employee_id']),
  work_days: definition('work_days', {
    work_date: col('operational_date', date), employee_id: col('employee_no'),
    start_time: col('start_time', time), end_time: col('finish_time', time),
    hours_worked: col('work_time', number), hours_open: col('open_hours', number),
    hours_booked: col('booked_hours', number), attendance_status: col('source_status'),
  }, ['work_date', 'employee_id']),
  time_schedule: definition('project_structure', {
    item_id: col('wbs_code'), ...common, actual_finish: col('actual_finish', timestamp),
    progress_percent: col('progress_pct', number),
    order_index: col('sort_order', integer), is_summary: col('summary_task', boolean), planned_hours: col('planned_hours', number),
  }, ['item_id']),
  site_progress_items: definition('site_progress_items', {
    title: common.title, planned_start: common.planned_start, planned_finish: common.planned_finish,
    area_code: common.area_code, section: common.section, assignee: common.assignee,
    actual_start: common.actual_start, progress_percent: col('progress_pct', number),
    planned_progress_percent: col('planned_progress_pct', number), progress_delta: col('delta_progress_source', number),
    expected_delay_days: col('expected_delay', number), has_files: col('has_files', boolean),
    has_notes: col('has_notes', boolean), has_deviations: col('has_deviations', boolean), planned_hours: col('planned_hours', number),
  }, ['title', 'planned_start', 'planned_finish', 'area_code', 'section']),
  deviations: definition('deviations', {
    deviation_id: col('deviation_no'), status: col('status', status), title: col('title'),
    description: col('problem_description'), priority: col('priority'), author: col('author'),
    assignee: col('assigned_to'), area_code: col('plc_area'), created_at: col('creation_date', timestamp),
    due_at: col('due_date', timestamp), approved_at: col('approved_date', timestamp), closed_at: col('closed_date', timestamp),
    actual_cost: col('actual_cost', number), claim_quantity: col('claim_quantity', number),
    labour_hours: col('labor_hours', number), completed_percent: col('completed_tasks_pct', number),
  }, ['deviation_id', 'status']),
  daily_log: definition('diary', {
    log_date: col('operational_date', date), plan: col('plan'), actual: col('actual'),
    impediments: col('impediments'), next_step: col('next_step'),
  }, ['log_date']),
};
const familyModule = family => ({ time_schedule: 'wbs', site_progress_items: 'progress', deviations: 'deviations', daily_log: 'diary' })[family];
const familyOf = family => {
  if (!Object.hasOwn(FAMILIES, family)) fail('UNKNOWN_FAMILY', 'Unknown import family.');
  return FAMILIES[family];
};
export function canonicalHeaders(family) {
  return Object.keys(familyOf(family).columns);
}
// aliases_json is an object of destination field -> alternative header arrays.
export function resolveMapping(family, row = null) {
  const base = familyOf(family), columns = { ...base.columns };
  const fields = new Map(Object.values(columns).map(column => [column.field, column]));
  let aliases = {}, identity = [...DEFAULT_IDENTITIES[family]];
  if (row !== null) {
    try { aliases = JSON.parse(row.aliases_json); identity = JSON.parse(row.identity_json); }
    catch { fail('MAP_INVALID', 'Mapping must contain valid JSON.'); }
  }
  if (!aliases || typeof aliases !== 'object' || Array.isArray(aliases) ||
      !Array.isArray(identity) || !identity.length || new Set(identity).size !== identity.length ||
      identity.some(field => !fields.has(field))) fail('MAP_INVALID', 'Invalid aliases or row identity.');
  const used = new Set(Object.keys(columns)), normalizedAliases = {};
  for (const [field, headers] of Object.entries(aliases)) {
    if (!fields.has(field) || !Array.isArray(headers)) fail('MAP_INVALID', 'Unknown alias field or invalid alias array.');
    const names = [];
    for (const header of headers) {
      if (typeof header !== 'string' || !header.trim() || header.length > 80 || used.has(header.trim())) {
        fail('MAP_INVALID', 'Alias headers must be unique, nonempty and at most 80 characters.');
      }
      const name = header.trim(); used.add(name); names.push(name);
      Object.defineProperty(columns, name, { value: fields.get(field), enumerable: true });
    }
    Object.defineProperty(normalizedAliases, field, { value: names, enumerable: true });
  }
  return { columns, required: [...base.required], identity: [...identity], aliases: normalizedAliases };
}
const mappingResult = (family, row) => {
  const mapping = resolveMapping(family, row);
  return { family, aliases: mapping.aliases, identity: mapping.identity, custom: row !== null,
    columns: Object.fromEntries(Object.entries(mapping.columns).map(([header, column]) => [header, { field: column.field }])),
    required: mapping.required, fields: [...new Set(Object.values(mapping.columns).map(column => column.field))] };
};
async function mappingSite(db, siteId, user) {
  if (!user?.id) fail('UNAUTHENTICATED', 'Authentication required.', 401);
  if (typeof siteId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(siteId)) {
    fail('VALIDATION_ERROR', 'site_id must be a UUID.');
  }
  siteId = siteId.toLowerCase();
  await requireRole(db, siteId, user, ['owner', 'editor']);
  return siteId;
}
export async function listImportMappings(db, siteId, user) {
  siteId = await mappingSite(db, siteId, user);
  const rows = await db.all('SELECT * FROM import_mappings WHERE site_id = ?', siteId);
  return Object.keys(FAMILIES).map(family => mappingResult(family, rows.find(row => row.family === family) ?? null));
}
export async function saveImportMapping(db, input, user) {
  const siteId = await mappingSite(db, input.site_id, user), family = input.family;
  const mapping = resolveMapping(family, { aliases_json: JSON.stringify(input.aliases), identity_json: JSON.stringify(input.identity) });
  const row = { aliases_json: JSON.stringify(mapping.aliases), identity_json: JSON.stringify(mapping.identity) };
  await db.transaction(async tx => {
    await requireRole(tx, siteId, user, ['owner', 'editor']);
    const at = new Date().toISOString();
    await tx.run(`INSERT INTO import_mappings (id, site_id, family, aliases_json, identity_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (site_id, family)
      DO UPDATE SET aliases_json = excluded.aliases_json, identity_json = excluded.identity_json, updated_at = excluded.updated_at`,
    randomUUID(), siteId, family, row.aliases_json, row.identity_json, at, at);
  });
  return mappingResult(family, row);
}
export async function deleteImportMapping(db, siteId, family, user) {
  siteId = await mappingSite(db, siteId, user); familyOf(family);
  await db.transaction(async tx => {
    await requireRole(tx, siteId, user, ['owner', 'editor']);
    await tx.run('DELETE FROM import_mappings WHERE site_id = ? AND family = ?', siteId, family);
  });
  return mappingResult(family, null);
}
const loadMapping = async (db, siteId, family) => resolveMapping(family,
  await db.get('SELECT * FROM import_mappings WHERE site_id = ? AND family = ?', siteId, family) ?? null);

const defaultIdentity = (family, mapping) => JSON.stringify(mapping.identity) === JSON.stringify(DEFAULT_IDENTITIES[family]);
function identityKey(values, family, mapping) {
  const normalizers = new Map(Object.values(mapping.columns).map(column => [column.field, column.normalize]));
  const parts = mapping.identity.map(field => {
    const normalize = normalizers.get(field);
    const value = normalize === text ? text(values[field]) : comparable(values[field], normalize);
    return family === 'site_progress_items' && typeof value === 'string'
      ? value.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase() : value;
  });
  // Preserve persisted default keys, including the fixed day shift in diary keys.
  const defaults = defaultIdentity(family, mapping);
  if (defaults && ['employees', 'time_schedule', 'deviations'].includes(family)) return parts[0];
  if (defaults && family === 'daily_log') return JSON.stringify([...parts, 'day']);
  return JSON.stringify(parts);
}
function normalizeRow(raw, mapping) {
  const values = {};
  for (const [name, { field, normalize }] of Object.entries(mapping.columns)) if (Object.hasOwn(raw, name)) {
    const value = text(raw[name]) === null ? null : normalize(raw[name]);
    if (Object.hasOwn(values, field) && values[field] !== null) {
      if (value === null) continue;
      if (values[field] !== value) fail('AMBIGUOUS_COLUMNS', 'Canonical and alias columns disagree.');
    }
    values[field] = value;
  }
  return values;
}
const parentCode = code => code.includes('.') ? code.slice(0, code.lastIndexOf('.')) : null;

export function parseFamily(buffer, family, { timeZone = 'Europe/Rome', mapping = resolveMapping(family), trackedDeviations = false } = {}) {
  familyOf(family);
  if (!Buffer.isBuffer(buffer) || !buffer.length) fail('EMPTY_FILE', 'An XLSX file is required.');
  if (buffer.length > MAX_IMPORT_BYTES) fail('FILE_TOO_LARGE', 'File exceeds 20 MiB.', 413);
  let workbook;
  try { workbook = readWorkbook(buffer); }
  catch { fail('INVALID_XLSX', 'Cannot read the XLSX workbook.'); }
  const { header, rows } = workbook;
  if (!trackedDeviations && !rows.length) fail('EMPTY_FILE', 'The first worksheet has no data rows.');
  if (trackedDeviations && !header.includes('source_id')) {
    fail('DEVIATION_IDENTITY_UNRESOLVED', 'A source_id column with stable IDs is required.', 422);
  }
  const presentFields = new Set(header.filter(name => Object.hasOwn(mapping.columns, name)).map(name => mapping.columns[name].field));
  const missing = mapping.required.filter(name => !presentFields.has(mapping.columns[name].field));
  if (!trackedDeviations) missing.push(...mapping.identity.filter(field => !presentFields.has(field) && !missing.some(name => mapping.columns[name]?.field === field)));
  if (missing.length) fail('MISSING_COLUMNS', `Missing columns: ${missing.join(', ')}.`);
  if (new Set(header.filter(v => v != null)).size !== header.filter(v => v != null).length) fail('MISSING_COLUMNS', 'Duplicate column names are ambiguous.');
  const rejected = [], occurrences = new Map();
  let accepted = 0;
  // Replace the reader's arrays in place, retaining only one set of full import rows.
  for (let index = 0; index < rows.length; index++) {
    const cells = rows[index], sourceRow = index + 2;
    rows[index] = null;
    if (cells.every(value => text(value) === null)) continue;
    try {
      const raw = Object.fromEntries(header.map((name, i) => [name, cells[i] ?? null]));
      // Composite dimensions may be NULL; the title is the mandatory progress cell.
      const requiredCells = family === 'site_progress_items' ? ['title'] : mapping.required;
      const empty = requiredCells.filter(name => !Object.entries(mapping.columns).some(([header, column]) =>
        column.field === mapping.columns[name].field && Object.hasOwn(raw, header) && text(raw[header]) !== null));
      if (empty.length) fail('MISSING_VALUE', `Required cells are empty: ${empty.join(', ')}.`);
      const values = normalizeRow(raw, mapping);
      if (trackedDeviations) {
        values.source_id = sourceText(raw.source_id);
        const statusHeader = Object.keys(mapping.columns).find(name =>
          mapping.columns[name].field === 'status' && Object.hasOwn(raw, name) && text(raw[name]) !== null);
        values.source_status = sourceText(raw[statusHeader]);
      }
      const base = trackedDeviations ? values.source_id : identityKey(values, family, mapping);
      const occurrence = (occurrences.get(base) || 0) + 1;
      occurrences.set(base, occurrence);
      if (occurrence > 1 && family !== 'site_progress_items') fail(family === 'daily_log' ? 'DUPLICATE_DAY' : 'DUPLICATE_KEY', 'Duplicate key in this file.');
      const warnings = [];
      if (family === 'time_schedule') {
        if (!/^[^.\s]+(?:\.[^.\s]+)*$/.test(values.wbs_code)) fail('INVALID_KEY', 'Invalid hierarchical code.');
        values.level = values.wbs_code.split('.').length - 1;
      }
      if (family === 'daily_log') { values.shift = 'day'; values.time_zone = timeZone; }
      const identity_state = family === 'site_progress_items' && occurrence > 1 ? 'unresolved' : 'observed';
      if (identity_state === 'unresolved') warnings.push({ code: 'UNRESOLVED_IDENTITY', message: 'Da confermare: repeated composite identity.' });
      rows[accepted++] = { key: family === 'site_progress_items' ? JSON.stringify([base, occurrence]) : base,
        values, warnings, identity_state, source_row: sourceRow };
    } catch (error) {
      if (!(error instanceof RepositoryError)) throw error;
      rejected.push({ source_row: sourceRow, rejected: error.code, reason: error.message });
    }
  }
  rows.length = accepted;
  if (!trackedDeviations && !accepted && !rejected.length) fail('EMPTY_FILE', 'The first worksheet has no data rows.');
  if (family === 'time_schedule') {
    const codes = new Set(rows.map(row => row.values.wbs_code));
    for (const row of rows) if (parentCode(row.values.wbs_code) && !codes.has(parentCode(row.values.wbs_code))) {
      row.warnings.push({ code: 'ORPHAN_ROOT', message: 'Parent absent from export; imported as a root.' });
    }
    rows.sort((a, b) => a.values.level - b.values.level || a.values.wbs_code.localeCompare(b.values.wbs_code));
  }
  return { rows, rejected, unmapped_columns: header.filter(name => name != null && !Object.hasOwn(mapping.columns, name) &&
    !(trackedDeviations && name === 'source_id')) };
}

const mappingDigest = mapping => digest(JSON.stringify({
  columns: Object.entries(mapping.columns).map(([header, column]) => [header, column.field]).sort(([a], [b]) => a.localeCompare(b)),
  required: mapping.required, identity: mapping.identity,
}));
const digest = value => createHash('sha256').update(value).digest('hex');
function rowsDigest(rows, rejected = []) {
  const hash = createHash('sha256');
  for (const row of rows) hash.update(JSON.stringify(row)).update('\n');
  for (const row of rejected) hash.update(JSON.stringify(row)).update('\n');
  return hash.digest('hex');
}
export function previewToken({ buffer, family, siteId, rows, rejected, timeZone = 'Europe/Rome', mapping = resolveMapping(family), completeVerified = false }, { now = Date.now(), secret = tokenSecret } = {}) {
  const payload = Buffer.from(JSON.stringify({ file: digest(buffer), family, siteId, timeZone, completeVerified, mapping: mappingDigest(mapping),
    rows: rowsDigest(rows, rejected), issued: now, expires: now + TOKEN_AGE })).toString('base64url');
  return `${payload}.${createHmac('sha256', secret).update(payload).digest('base64url')}`;
}
export function verifyPreviewToken(token, { buffer, family, siteId, rows, rejected, timeZone = 'Europe/Rome', mapping = resolveMapping(family), completeVerified = false }, { now = Date.now(), secret = tokenSecret } = {}) {
  const mismatch = () => fail('PREVIEW_MISMATCH', 'The preview does not match this import.', 409);
  if (typeof token !== 'string' || token.length > 2048) mismatch();
  const parts = token.split('.');
  if (parts.length !== 2) mismatch();
  const expected = createHmac('sha256', secret).update(parts[0]).digest();
  const signature = Buffer.from(parts[1], 'base64url');
  if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) mismatch();
  let claims;
  try { claims = JSON.parse(Buffer.from(parts[0], 'base64url').toString()); } catch { mismatch(); }
  if (!claims || !Number.isFinite(claims.issued) || claims.expires !== claims.issued + TOKEN_AGE || claims.issued > now) mismatch();
  if (now >= claims.expires) fail('PREVIEW_EXPIRED', 'Preview expired; request a new preview.', 409);
  if (claims.file !== digest(buffer) || claims.family !== family || claims.siteId !== siteId || claims.timeZone !== timeZone || claims.completeVerified !== completeVerified || claims.mapping !== mappingDigest(mapping) ||
      (rows && claims.rows !== rowsDigest(rows, rejected))) mismatch();
}

function comparable(value, normalize) {
  if (value == null) return null;
  if ([number, integer].includes(normalize)) return Number(value);
  if (normalize === boolean) return Boolean(value);
  if (normalize === timestamp) return canonicalInstant(value);
  return value;
}
function fingerprint(values, mapping, fields) {
  const normalizers = new Map(Object.values(mapping.columns).map(c => [c.field, c.normalize]));
  return digest(JSON.stringify(fields.map(field => comparable(values[field], normalizers.get(field)))));
}

// Configuring import identity does not remove uniqueness constraints from the fixed target model.
function targetConstraint(family, values) {
  if (family === 'employees') return values.employee_no;
  if (family === 'deviations') return values.deviation_no;
  if (family === 'daily_log') return JSON.stringify([values.operational_date, values.shift]);
  return null;
}

async function context(db, siteId, family, rows, resolved) {
  const mapping = { ...familyOf(family), ...(resolved ?? await loadMapping(db, siteId, family)) }, existing = new Map(), ids = new Map(), employees = new Map(), bindings = new Map(), uniqueTargets = new Map();
  const fieldSet = new Set();
  for (const row of rows) for (const field of Object.keys(row.values)) fieldSet.add(field);
  const fields = [...fieldSet].filter(f => f !== 'employee_no' || family === 'employees');
  if (family === 'work_days') fields.push('employee_id');
  if (family === 'time_schedule') fields.push('parent_id');
  if (family === 'work_days') {
    let cursor = '';
    for (;;) {
      const page = await db.all('SELECT id, employee_no FROM employees WHERE site_id = ? AND CAST(id AS TEXT) > ? ORDER BY id LIMIT 500', siteId, cursor);
      for (const row of page) employees.set(row.employee_no, row.id);
      if (page.length < 500) break;
      cursor = page.at(-1).id;
    }
  }
  const occurrence = new Map();
  let cursor = family === 'site_progress_items' ? -2147483648 : '', maxSourceRow = 0;
  for (;;) {
    const order = family === 'site_progress_items' ? 'a.source_row' : 'a.id';
    const dateFields = [...new Set(Object.values(mapping.columns).filter(c => [date, time, timestamp].includes(c.normalize)).map(c => c.field))];
    const page = await db.all(`SELECT a.*${dateFields.map(field => `, CAST(a.${field} AS TEXT) AS ${field}`).join('')},
      k.import_key AS bound_key${family === 'work_days' ? ', e.employee_no' : ''}
      FROM ${mapping.table} a LEFT JOIN planning_import_keys k ON k.site_id = a.site_id AND k.family = ? AND k.target_id = a.id
      ${family === 'work_days' ? 'LEFT JOIN employees e ON e.id = a.employee_id AND e.site_id = a.site_id' : ''}
      WHERE a.site_id = ? ${family === 'deviations' ? 'AND a.source_id IS NULL' : ''} AND ${family === 'site_progress_items' ? order : `CAST(${order} AS TEXT)`} > ? ORDER BY ${order} LIMIT 500`, family, siteId, cursor);
    for (const row of page) {
      let key = identityKey(row, family, mapping);
      if (family === 'daily_log' && row.shift !== 'day') key = defaultIdentity(family, mapping)
        ? JSON.stringify([row.operational_date, row.shift]) : JSON.stringify(['other_shift', row.shift, key]);
      if (family === 'site_progress_items') {
        // Normalize existing instants identically to the parser before building identity.
        for (const field of ['planned_start', 'planned_finish']) if (row[field]) row[field] = canonicalInstant(row[field]);
        const base = identityKey(row, family, mapping), n = (occurrence.get(base) || 0) + 1;
        occurrence.set(base, n); key = JSON.stringify([base, n]);
        maxSourceRow = Math.max(maxSourceRow, Number(row.source_row));
      }
      // Occurrence bindings remain stable when progress rows are reordered or absent from a later file.
      if (family === 'site_progress_items' && row.bound_key) {
        try { if (JSON.parse(row.bound_key)[0] === JSON.parse(key)[0]) key = row.bound_key; } catch { /* adopt current identity */ }
      }
      const constraint = targetConstraint(family, row);
      if (constraint !== null) uniqueTargets.set(constraint, row.id);
      if (row.bound_key != null) bindings.set(row.bound_key, row.id);
      const entry = { id: row.id, key, hash: fingerprint(row, mapping, fields), ambiguous: existing.has(key) };
      if (existing.has(key)) entry.duplicates = (existing.get(key).duplicates || 1) + 1;
      existing.set(key, entry); ids.set(key, row.id);
    }
    if (page.length < 500) break;
    cursor = family === 'site_progress_items' ? page.at(-1).source_row : page.at(-1).id;
  }
  for (const row of rows) if (!ids.has(row.key)) ids.set(row.key, stableId('planning', siteId, family, row.key));
  const codes = new Map(rows.map(row => [row.values.wbs_code, ids.get(row.key)]));
  if (family === 'time_schedule') {
    const previous = await db.all('SELECT id, wbs_code FROM project_structure WHERE site_id = ?', siteId);
    for (const node of previous) if (!codes.has(node.wbs_code) && previous.filter(other => other.wbs_code === node.wbs_code).length === 1) codes.set(node.wbs_code, node.id);
  }
  return { mapping, existing, ids, employees, bindings, uniqueTargets, fields, maxSourceRow, codes };
}
function targetValues(row, family, ctx) {
  const values = { ...row.values };
  if (family === 'work_days') { values.employee_id = ctx.employees.get(values.employee_no); delete values.employee_no; }
  if (family === 'time_schedule') values.parent_id = ctx.codes.has(parentCode(values.wbs_code)) ? ctx.codes.get(parentCode(values.wbs_code)) : null;
  return values;
}
const emptyDiff = () => Object.fromEntries(['added', 'updated', 'unchanged', 'removed', 'rejected'].map(key => [key, { count: 0, samples: [] }]));
function record(diff, category, sample, count = 1) {
  diff[category].count += count;
  if (diff[category].samples.length < 50) diff[category].samples.push(sample);
}
async function compare(db, { siteId, family, rows, rejected = [], mapping }, visit) {
  const ctx = await context(db, siteId, family, rows, mapping), diff = emptyDiff(), seen = new Set();
  const invalidParents = new Set(), proposedTargets = new Map();
  for (const row of rejected) record(diff, 'rejected', row);
  for (const row of rows) {
    seen.add(row.key);
    const old = ctx.existing.get(row.key), values = targetValues(row, family, ctx);
    const boundId = ctx.bindings.get(row.key), id = ctx.ids.get(row.key), constraint = targetConstraint(family, row.values);
    const targetId = ctx.uniqueTargets.get(constraint) ?? proposedTargets.get(constraint);
    const rejection = old?.ambiguous || (boundId && boundId !== id) || (targetId && targetId !== id) ? 'AMBIGUOUS_KEY' : family === 'work_days' && !values.employee_id ? 'EMPLOYEE_UNKNOWN'
      : family === 'time_schedule' && invalidParents.has(parentCode(row.values.wbs_code)) ? 'AMBIGUOUS_KEY' : null;
    if (rejection && family === 'time_schedule') invalidParents.add(row.values.wbs_code);
    if (rejection) { record(diff, 'rejected', { key: row.key, source_row: row.source_row, rejected: rejection,
      reason: rejection === 'EMPLOYEE_UNKNOWN' ? 'Employee does not exist in this site.' : 'Existing identity requires reconciliation.' }); continue; }
    if (constraint !== null) proposedTargets.set(constraint, id);
    const category = !old ? 'added' : old.hash === fingerprint(values, ctx.mapping, ctx.fields) ? 'unchanged' : 'updated';
    record(diff, category, row);
    if (visit) await visit({ row, values, category, id: ctx.ids.get(row.key), ctx });
  }
  for (const [key, entry] of ctx.existing) if (!seen.has(key)) record(diff, 'removed', { key, id: entry.id }, entry.duplicates || 1);
  return diff;
}
export async function diffFamily(db, input) { return compare(db, input); }

export async function applyFamily(db, { siteId, family, rows, rejected = [], user, completeVerified = false, buffer = null, filename = null, mapping, preview_token, timeZone = 'Europe/Rome' }) {
  familyOf(family);
  if (!user?.id) fail('UNAUTHENTICATED', 'Authentication required.', 401);
  return db.transaction(async tx => {
    await requireRole(tx, siteId, user, ['owner', 'editor']);
    if (familyModule(family)) await requireModule(tx, siteId, user, familyModule(family));
    const currentMapping = await loadMapping(tx, siteId, family);
    if (mapping && mappingDigest(mapping) !== mappingDigest(currentMapping)) fail('PREVIEW_MISMATCH', 'Mapping changed; request a new preview.', 409);
    if (preview_token) verifyPreviewToken(preview_token, { buffer, family, siteId, rows, rejected, timeZone, mapping: currentMapping, completeVerified });
    if (['time_schedule', 'deviations'].includes(family)) await tx.run('UPDATE sites SET id = id WHERE id = ?', siteId);
    const runId = randomUUID(), at = new Date().toISOString(), keys = [], seenWbs = [];
    const wbsScope = family === 'time_schedule' ? (await tx.get('SELECT scope_id FROM wbs_import_sources WHERE site_id = ?', siteId))?.scope_id || 'planning-upload' : null;
    await tx.run(`INSERT INTO planning_import_runs (id, site_id, family, filename, file_sha256, file_data, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, runId, siteId, family, filename, buffer ? digest(buffer) : null, buffer, user.id, at);
    const result = await compare(tx, { siteId, family, rows, rejected, mapping: currentMapping }, async ({ row, values, category, id, ctx }) => {
      if (family === 'time_schedule') {
        seenWbs.push(id);
        await reconcileWbsSource(tx, { site: siteId, id, values, scope: wbsScope, run: runId, user, at, unchanged: category === 'unchanged' });
        if (category !== 'unchanged') keys.push(row.key);
      } else if (category !== 'unchanged') {
        if (category === 'added' && family === 'site_progress_items') values.source_row = ++ctx.maxSourceRow;
        const before = family === 'deviations' && category === 'updated'
          ? await tx.get('SELECT * FROM deviations WHERE id = ?', id) : null;
        const columns = Object.keys(values);
        const args = columns.map(column => typeof values[column] === 'boolean' ? String(values[column]) : values[column]);
        const placeholders = columns.map(column => typeof values[column] === 'boolean'
          ? "CASE ? WHEN 'true' THEN TRUE ELSE FALSE END" : '?');
        if (category === 'added') await tx.run(`INSERT INTO ${ctx.mapping.table} (id, site_id, ${columns.join(', ')}, created_at)
          VALUES (?, ?, ${placeholders.join(', ')}, ?)`, id, siteId, ...args, at);
        else await tx.run(`UPDATE ${ctx.mapping.table} SET ${columns.map((column, i) => `${column} = ${placeholders[i]}`).join(', ')}
          WHERE id = ? AND site_id = ?`, ...args, id, siteId);
        if (before) await recordDeviationImportEvent(tx, before, { ...before, ...values }, at);
        keys.push(row.key);
      }
      await tx.run(`INSERT INTO planning_import_keys (site_id, family, import_key, target_id, identity_state, last_import_run_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (site_id, family, target_id)
        DO UPDATE SET import_key = excluded.import_key, last_import_run_id = excluded.last_import_run_id, identity_state = excluded.identity_state, updated_at = excluded.updated_at`,
      siteId, family, row.key, id, row.identity_state, runId, at, at);
    });
    if (family === 'time_schedule') await reconcileWbsMissing(tx, siteId, wbsScope, runId, completeVerified && result.rejected.count === 0, seenWbs);
    const counts = Object.fromEntries(Object.entries(result).map(([key, value]) => [key, value.count]));
    // Removed is informative only; applied removal count is always zero.
    const applied = { added: counts.added, updated: counts.updated, unchanged: counts.unchanged, rejected: counts.rejected, removed: 0 };
    await tx.run('UPDATE planning_import_runs SET counts_json = ?, applied_keys_json = ? WHERE id = ? AND site_id = ?', JSON.stringify(applied), JSON.stringify(keys), runId, siteId);
    return { counts: applied, applied_keys: keys, import_run_id: runId };
  });
}

function workbookFile(input) {
  if (typeof input.filename !== 'string' || !input.filename.trim() || input.filename.length > 255 || /[\x00-\x1f\/\\]/.test(input.filename)) fail('VALIDATION_ERROR', 'Invalid filename.');
  const encoded = input.data_base64;
  if (encoded === '' || encoded == null) fail('EMPTY_FILE', 'An XLSX file is required.');
  if (typeof encoded !== 'string') fail('VALIDATION_ERROR', 'Invalid base64.');
  if (encoded.length > 4 * Math.ceil(MAX_IMPORT_BYTES / 3)) fail('FILE_TOO_LARGE', 'File exceeds 20 MiB.', 413);
  if (encoded.length % 4 || /[^A-Za-z0-9+/=]/.test(encoded)) fail('VALIDATION_ERROR', 'Invalid base64.');
  const buffer = Buffer.from(encoded, 'base64');
  if (buffer.length > MAX_IMPORT_BYTES) fail('FILE_TOO_LARGE', 'File exceeds 20 MiB.', 413);
  if (buffer.toString('base64') !== encoded) fail('VALIDATION_ERROR', 'Invalid base64.');
  return buffer;
}

export async function importDeviationWorkbook(db, input, user) {
  if (!user?.id) fail('UNAUTHENTICATED', 'Authentication required.', 401);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.site_id || '')) fail('VALIDATION_ERROR', 'site_id must be a UUID.');
  const site = input.site_id.toLowerCase();
  const meta = deviationImportMeta(input.meta);
  return db.transaction(async tx => {
    await requireRole(tx, site, user, ['owner']);
    await requireModule(tx, site, user, 'deviations');
    await tx.run('UPDATE sites SET id = id WHERE id = ?', site);
    const buffer = workbookFile(input);
    if (digest(buffer) !== meta.fileSha256) fail('DEVIATION_EXPORT_CHECKSUM_MISMATCH', 'The export checksum does not match the imported file.', 422);
    if (await registeredDeviationExport(tx, site, meta)) return { imported: 0, unchanged: true, unmapped_status: 0 };
    const mapping = await loadMapping(tx, site, 'deviations');
    const { rows, rejected } = parseFamily(buffer, 'deviations', { mapping, trackedDeviations: true });
    if (rejected.some(row => row.rejected === 'UNKNOWN_STATUS')) fail('UNKNOWN_STATUS', 'Unrecognized deviation status.', 422);
    if (rejected.length) fail('DEVIATION_EXPORT_INVALID', 'The deviation workbook contains invalid or duplicate rows.', 422);
    const at = new Date().toISOString();
    await storeDeviationExport(tx, site, meta, rows.map(row => row.values), at);
    const runId = randomUUID();
    await tx.run(`INSERT INTO planning_import_runs (id, site_id, family, filename, file_sha256, file_data, created_by, created_at)
      VALUES (?, ?, 'deviations', ?, ?, ?, ?, ?)`, runId, site, input.filename, meta.fileSha256, buffer, user.id, at);
    return { imported: rows.length, unchanged: false, unmapped_status: rows.filter(row => row.values.status == null).length, run_id: runId };
  });
}

export async function importRequest(db, input, user, { apply = false } = {}) {
  if (!user?.id) fail('UNAUTHENTICATED', 'Authentication required.', 401);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.site_id || '')) fail('VALIDATION_ERROR', 'site_id must be a UUID.');
  const siteId = input.site_id.toLowerCase(), family = input.family;
  await requireRole(db, siteId, user, ['owner', 'editor']);
  familyOf(family);
  if (familyModule(family)) await requireModule(db, siteId, user, familyModule(family));
  const buffer = workbookFile(input);
  // Diary entries use the application timezone for the fixed day shift.
  const timeZone = 'Europe/Rome', mapping = await loadMapping(db, siteId, family), binding = { buffer, family, siteId, timeZone, mapping, completeVerified: input.complete_verified === true };
  if (apply) verifyPreviewToken(input.preview_token, binding);
  const parsed = parseFamily(buffer, family, { timeZone, mapping });
  if (apply) {
    verifyPreviewToken(input.preview_token, { ...binding, ...parsed });
    return applyFamily(db, { ...binding, ...parsed, filename: input.filename, user, preview_token: input.preview_token });
  }
  const diff = await diffFamily(db, { siteId, family, mapping, ...parsed });
  return { counts: Object.fromEntries(Object.entries(diff).map(([key, value]) => [key, value.count])),
    samples: Object.fromEntries(Object.entries(diff).map(([key, value]) => [key, value.samples])),
    unmapped_columns: parsed.unmapped_columns,
    preview_token: previewToken({ ...binding, ...parsed }) };
}
