import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readWorkbook } from './xlsx.mjs';
import { RepositoryError, requireRole } from './repository.mjs';
import { sourceTimestamp, stableId } from './wbs.mjs';

const fail = (code, message, status = 400) => { throw new RepositoryError(status, message, code); };
export const MAX_IMPORT_BYTES = 20 * 1024 * 1024;
const TOKEN_AGE = 15 * 60 * 1000;
const tokenSecret = process.env.PLANNING_IMPORT_TOKEN_SECRET || randomBytes(32);
const text = value => value == null || String(value).trim() === '' ? null : String(value).trim();
const number = value => {
  if (text(value) === null) return null;
  const raw = text(value).replace(',', '.');
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(raw) || !Number.isFinite(Number(raw))) fail('INVALID_NUMBER', 'Expected a finite decimal number.');
  return Number(raw);
};
const boolean = value => {
  if (text(value) === null) return null;
  // planning writes booleans as text; case varies between exports.
  const raw = String(value).trim().toLowerCase();
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  fail('INVALID_BOOLEAN', 'Expected True or False.');
};
const canonicalInstant = value => {
  const raw = value instanceof Date ? value.toISOString() : String(value);
  const fraction = /:\d\d\.(\d{1,6})/.exec(raw)?.[1] || '';
  return `${new Date(raw).toISOString().slice(0, 19)}.${fraction.padEnd(6, '0')}Z`;
};
const timestamp = (value, zone) => {
  if (text(value) === null) return null;
  try { return canonicalInstant(sourceTimestamp(/^\d{4}-\d\d-\d\d$/.test(value) ? `${value} 00:00:00` : value, zone)); }
  catch { fail('INVALID_DATE', 'Invalid, ambiguous or nonexistent date in the site timezone.'); }
};
// DATE and TIME targets retain calendar/clock semantics; only timestamp targets become UTC.
const date = (value, zone) => {
  if (text(value) === null) return null;
  timestamp(value, zone);
  return value.slice(0, 10);
};
const time = value => {
  if (text(value) === null) return null;
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(value)) fail('INVALID_TIME', 'Expected HH:MM or HH:MM:SS.');
  return value.length === 5 ? `${value}:00` : value;
};
const integer = value => {
  const result = number(value);
  if (result !== null && (!Number.isSafeInteger(result) || result < 0 || result > 2147483647)) fail('INVALID_NUMBER', 'Expected a nonnegative 32-bit integer.');
  return result;
};
const statuses = new Map([['01 Open', 'open'], ['03 Work In Progress', 'in_progress'],
  ['04 Work Completed', 'work_completed'], ['05 Closed', 'closed'], ['06 Rejected', 'rejected']]);
const status = value => {
  if (!statuses.has(value)) fail('UNKNOWN_STATUS', 'Unverified deviation status.');
  return statuses.get(value);
};
const col = (field, normalize = text) => ({ field, normalize });
const common = { Description: col('description'), 'PLC-Area': col('plc_area'), 'PLC Area': col('plc_area'), Section: col('section'),
  'Assigned To': col('assigned_to'), 'Planned Start': col('planned_start', timestamp),
  'Planned Finish': col('planned_finish', timestamp), 'Actual Start': col('actual_start', timestamp),
  Progress: col('progress_pct', number), 'Progress %': col('progress_pct', number) };
const composite = values => JSON.stringify(['description', 'planned_start', 'planned_finish', 'plc_area', 'section']
  .map(field => text(values[field])?.normalize('NFKC').replace(/\s+/g, ' ').toLowerCase() ?? null));
const definition = (table, columns, required, key) => ({ table, columns, required, key,
  normalize(raw, zone) {
    return Object.fromEntries(Object.entries(columns).filter(([name]) => Object.hasOwn(raw, name))
      .map(([name, { field, normalize }]) => [field, normalize(raw[name], zone)]));
  } });

// Fixed public column contract. Missing optional columns never erase existing fields.
export const FAMILIES = {
  employees: definition('employees', {
    'Employee No': col('employee_no'), 'First Name': col('first_name'), 'Last Name': col('last_name'),
    Company: col('company'), Qualification: col('qualification'), Supervisor: col('supervisor'), Team: col('team'),
    'Hire Date': col('hire_date', date), 'Expire Date': col('expire_date', date),
  }, ['Employee No'], v => v.employee_no),
  work_days: definition('work_days', {
    Date: col('operational_date', date), 'Employee No': col('employee_no'),
    'Start Time': col('start_time', time), 'Finish Time': col('finish_time', time),
    'Work Time': col('work_time', number), 'Open Hours': col('open_hours', number),
    'Booked Hours': col('booked_hours', number), Status: col('source_status', value => value ?? null),
  }, ['Date', 'Employee No'], v => JSON.stringify([v.operational_date, v.employee_no])),
  time_schedule: definition('project_structure', {
    'Time Schedule Item No': col('wbs_code'), ...common, 'Actual Finish': col('actual_finish', timestamp),
    'Sort Order': col('sort_order', integer), 'Summary Task': col('summary_task', boolean), 'Planned Hours': col('planned_hours', number),
  }, ['Time Schedule Item No'], v => v.wbs_code),
  site_progress_items: definition('site_progress_items', {
    ...common, 'Planned Progress': col('planned_progress_pct', number), 'Planned Progress %': col('planned_progress_pct', number),
    'Delta Progress': col('delta_progress_source', number),
    'Expected Delay': col('expected_delay'), 'Has Files': col('has_files', boolean),
    'Has Notes': col('has_notes', boolean), 'Has Deviations': col('has_deviations', boolean),
  }, ['Description', 'Planned Start', 'Planned Finish', 'PLC-Area', 'Section'], composite),
  deviations: definition('deviations', {
    'Deviation No': col('deviation_no'), Title: col('title'), 'Problem Description': col('problem_description'),
    'Deviation Status': col('status', status), Status: col('status', status), Priority: col('priority'), Author: col('author'),
    'Assigned To': col('assigned_to'), 'PLC-Area': col('plc_area'), 'PLC Area': col('plc_area'), 'Creation Date': col('creation_date', timestamp), 'Due Date': col('due_date', timestamp),
    'Approved Date': col('approved_date', timestamp), 'Closed Date': col('closed_date', timestamp),
    'Actual Cost': col('actual_cost', number), 'Claim Quantity': col('claim_quantity', number),
    'Labor Hours': col('labor_hours', number), 'Completed Tasks %': col('completed_tasks_pct', number),
  }, ['Deviation No', 'Deviation Status'], v => v.deviation_no),
  // The planning daily log has no plan/next-step columns: Activities are what happened, Delays are the impediments.
  daily_log: definition('diary', { Date: col('operational_date', date), Activities: col('actual'),
    Delays: col('impediments'), Plan: col('plan'), Actual: col('actual'), Impediments: col('impediments'),
    'Next Step': col('next_step') }, ['Date'], v => JSON.stringify([v.operational_date, 'day'])),
};
const familyOf = family => {
  if (!Object.hasOwn(FAMILIES, family)) fail('UNKNOWN_FAMILY', 'Unknown import family.');
  return FAMILIES[family];
};
const parentCode = code => code.includes('.') ? code.slice(0, code.lastIndexOf('.')) : null;

export function parseFamily(buffer, family, { timeZone = 'Europe/Rome' } = {}) {
  const mapping = familyOf(family);
  if (!Buffer.isBuffer(buffer) || !buffer.length) fail('EMPTY_FILE', 'An XLSX file is required.');
  if (buffer.length > MAX_IMPORT_BYTES) fail('FILE_TOO_LARGE', 'File exceeds 20 MiB.', 413);
  let workbook;
  try { workbook = readWorkbook(buffer); }
  catch { fail('INVALID_XLSX', 'Cannot read the XLSX workbook.'); }
  const { header, rows } = workbook;
  if (!rows.length) fail('EMPTY_FILE', 'The first worksheet has no data rows.');
  const missing = mapping.required.filter(name => !header.includes(name));
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
      // Composite dimensions may be NULL; Description is the mandatory progress cell.
      const requiredCells = family === 'site_progress_items' ? ['Description'] : mapping.required;
      const empty = requiredCells.filter(name => text(raw[name]) === null);
      if (empty.length) fail('MISSING_VALUE', `Required cells are empty: ${empty.join(', ')}.`);
      const values = mapping.normalize(raw, timeZone), base = mapping.key(values);
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
  if (!accepted && !rejected.length) fail('EMPTY_FILE', 'The first worksheet has no data rows.');
  if (family === 'time_schedule') {
    const codes = new Set(rows.map(row => row.key));
    for (const row of rows) if (parentCode(row.key) && !codes.has(parentCode(row.key))) {
      row.warnings.push({ code: 'ORPHAN_ROOT', message: 'Parent absent from export; imported as a root.' });
    }
    rows.sort((a, b) => a.values.level - b.values.level || a.key.localeCompare(b.key));
  }
  return { rows, rejected, unmapped_columns: header.filter(name => name != null && !Object.hasOwn(mapping.columns, name)) };
}

const digest = value => createHash('sha256').update(value).digest('hex');
function rowsDigest(rows, rejected = []) {
  const hash = createHash('sha256');
  for (const row of rows) hash.update(JSON.stringify(row)).update('\n');
  for (const row of rejected) hash.update(JSON.stringify(row)).update('\n');
  return hash.digest('hex');
}
export function previewToken({ buffer, family, siteId, rows, rejected, timeZone = 'Europe/Rome' }, { now = Date.now(), secret = tokenSecret } = {}) {
  const payload = Buffer.from(JSON.stringify({ file: digest(buffer), family, siteId, timeZone,
    rows: rowsDigest(rows, rejected), issued: now, expires: now + TOKEN_AGE })).toString('base64url');
  return `${payload}.${createHmac('sha256', secret).update(payload).digest('base64url')}`;
}
export function verifyPreviewToken(token, { buffer, family, siteId, rows, rejected, timeZone = 'Europe/Rome' }, { now = Date.now(), secret = tokenSecret } = {}) {
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
  if (claims.file !== digest(buffer) || claims.family !== family || claims.siteId !== siteId || claims.timeZone !== timeZone ||
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

async function context(db, siteId, family, rows) {
  const mapping = familyOf(family), existing = new Map(), ids = new Map(), employees = new Map();
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
    const dateFields = Object.values(mapping.columns).filter(c => [date, time, timestamp].includes(c.normalize)).map(c => c.field);
    const page = await db.all(`SELECT a.*${dateFields.map(field => `, CAST(a.${field} AS TEXT) AS ${field}`).join('')},
      k.import_key AS bound_key${family === 'work_days' ? ', e.employee_no' : ''}
      FROM ${mapping.table} a LEFT JOIN planning_import_keys k ON k.site_id = a.site_id AND k.family = ? AND k.target_id = a.id
      ${family === 'work_days' ? 'LEFT JOIN employees e ON e.id = a.employee_id AND e.site_id = a.site_id' : ''}
      WHERE a.site_id = ? AND ${family === 'site_progress_items' ? order : `CAST(${order} AS TEXT)`} > ? ORDER BY ${order} LIMIT 500`, family, siteId, cursor);
    for (const row of page) {
      let key = mapping.key(row);
      if (family === 'daily_log' && row.shift !== 'day') key = JSON.stringify([row.operational_date, row.shift]);
      if (family === 'site_progress_items') {
        // Normalize existing instants identically to the parser before building identity.
        for (const field of ['planned_start', 'planned_finish']) if (row[field]) row[field] = canonicalInstant(row[field]);
        const base = composite(row), n = (occurrence.get(base) || 0) + 1;
        occurrence.set(base, n); key = JSON.stringify([base, n]);
        maxSourceRow = Math.max(maxSourceRow, Number(row.source_row));
      }
      key = row.bound_key ?? key;
      const entry = { id: row.id, key, hash: fingerprint(row, mapping, fields), ambiguous: existing.has(key) };
      if (existing.has(key)) entry.duplicates = (existing.get(key).duplicates || 1) + 1;
      existing.set(key, entry); ids.set(key, row.id);
    }
    if (page.length < 500) break;
    cursor = family === 'site_progress_items' ? page.at(-1).source_row : page.at(-1).id;
  }
  for (const row of rows) if (!ids.has(row.key)) ids.set(row.key, stableId('planning', siteId, family, row.key));
  return { mapping, existing, ids, employees, fields, maxSourceRow, codes: new Set(rows.map(row => row.key)) };
}
function targetValues(row, family, ctx) {
  const values = { ...row.values };
  if (family === 'work_days') { values.employee_id = ctx.employees.get(values.employee_no); delete values.employee_no; }
  if (family === 'time_schedule') values.parent_id = ctx.codes.has(parentCode(row.key)) ? ctx.ids.get(parentCode(row.key)) : null;
  return values;
}
const emptyDiff = () => Object.fromEntries(['added', 'updated', 'unchanged', 'removed', 'rejected'].map(key => [key, { count: 0, samples: [] }]));
function record(diff, category, sample, count = 1) {
  diff[category].count += count;
  if (diff[category].samples.length < 50) diff[category].samples.push(sample);
}
async function compare(db, { siteId, family, rows, rejected = [] }, visit) {
  const ctx = await context(db, siteId, family, rows), diff = emptyDiff(), seen = new Set();
  const invalidParents = new Set();
  for (const row of rejected) record(diff, 'rejected', row);
  for (const row of rows) {
    seen.add(row.key);
    const old = ctx.existing.get(row.key), values = targetValues(row, family, ctx);
    const rejection = old?.ambiguous ? 'AMBIGUOUS_KEY' : family === 'work_days' && !values.employee_id ? 'EMPLOYEE_UNKNOWN'
      : family === 'time_schedule' && invalidParents.has(parentCode(row.key)) ? 'AMBIGUOUS_KEY' : null;
    if (rejection && family === 'time_schedule') invalidParents.add(row.key);
    if (rejection) { record(diff, 'rejected', { key: row.key, source_row: row.source_row, rejected: rejection,
      reason: rejection === 'EMPLOYEE_UNKNOWN' ? 'Employee does not exist in this site.' : 'Existing identity requires reconciliation.' }); continue; }
    const category = !old ? 'added' : old.hash === fingerprint(values, ctx.mapping, ctx.fields) ? 'unchanged' : 'updated';
    record(diff, category, row);
    if (visit) await visit({ row, values, category, id: ctx.ids.get(row.key), ctx });
  }
  for (const [key, entry] of ctx.existing) if (!seen.has(key)) record(diff, 'removed', { key, id: entry.id }, entry.duplicates || 1);
  return diff;
}
export async function diffFamily(db, input) { return compare(db, input); }

export async function applyFamily(db, { siteId, family, rows, rejected = [], user, buffer = null, filename = null }) {
  familyOf(family);
  if (!user?.id) fail('UNAUTHENTICATED', 'Authentication required.', 401);
  return db.transaction(async tx => {
    await requireRole(tx, siteId, user, ['owner', 'editor']);
    await tx.run('UPDATE sites SET id = id WHERE id = ?', siteId);
    const runId = randomUUID(), at = new Date().toISOString(), keys = [];
    await tx.run(`INSERT INTO planning_import_runs (id, site_id, family, filename, file_sha256, file_data, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, runId, siteId, family, filename, buffer ? digest(buffer) : null, buffer, user.id, at);
    const result = await compare(tx, { siteId, family, rows, rejected }, async ({ row, values, category, id, ctx }) => {
      if (category !== 'unchanged') {
        if (category === 'added' && family === 'site_progress_items') values.source_row = ++ctx.maxSourceRow;
        const columns = Object.keys(values);
        const args = columns.map(column => typeof values[column] === 'boolean' ? String(values[column]) : values[column]);
        const placeholders = columns.map(column => typeof values[column] === 'boolean'
          ? "CASE ? WHEN 'true' THEN TRUE ELSE FALSE END" : '?');
        if (category === 'added') await tx.run(`INSERT INTO ${ctx.mapping.table} (id, site_id, ${columns.join(', ')}, created_at)
          VALUES (?, ?, ${placeholders.join(', ')}, ?)`, id, siteId, ...args, at);
        else await tx.run(`UPDATE ${ctx.mapping.table} SET ${columns.map((column, i) => `${column} = ${placeholders[i]}`).join(', ')}
          WHERE id = ? AND site_id = ?`, ...args, id, siteId);
        keys.push(row.key);
      }
      await tx.run(`INSERT INTO planning_import_keys (site_id, family, import_key, target_id, identity_state, last_import_run_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (site_id, family, import_key)
        DO UPDATE SET last_import_run_id = excluded.last_import_run_id, identity_state = excluded.identity_state, updated_at = excluded.updated_at`,
      siteId, family, row.key, id, row.identity_state, runId, at, at);
    });
    const counts = Object.fromEntries(Object.entries(result).map(([key, value]) => [key, value.count]));
    // Removed is informative only; applied removal count is always zero.
    const applied = { added: counts.added, updated: counts.updated, unchanged: counts.unchanged, rejected: counts.rejected, removed: 0 };
    await tx.run('UPDATE planning_import_runs SET counts_json = ?, applied_keys_json = ? WHERE id = ? AND site_id = ?', JSON.stringify(applied), JSON.stringify(keys), runId, siteId);
    return { counts: applied, applied_keys: keys, import_run_id: runId };
  });
}

export async function importRequest(db, input, user, { apply = false } = {}) {
  if (!user?.id) fail('UNAUTHENTICATED', 'Authentication required.', 401);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.site_id || '')) fail('VALIDATION_ERROR', 'site_id must be a UUID.');
  const siteId = input.site_id.toLowerCase(), family = input.family;
  await requireRole(db, siteId, user, ['owner', 'editor']);
  familyOf(family);
  if (typeof input.filename !== 'string' || !input.filename.trim() || input.filename.length > 255 || /[\x00-\x1f/\\]/.test(input.filename)) fail('VALIDATION_ERROR', 'Invalid filename.');
  const encoded = input.data_base64;
  if (encoded === '' || encoded == null) fail('EMPTY_FILE', 'An XLSX file is required.');
  if (typeof encoded !== 'string') fail('VALIDATION_ERROR', 'Invalid base64.');
  if (encoded.length > 4 * Math.ceil(MAX_IMPORT_BYTES / 3)) fail('FILE_TOO_LARGE', 'File exceeds 20 MiB.', 413);
  if (encoded.length % 4 || /[^A-Za-z0-9+/=]/.test(encoded)) fail('VALIDATION_ERROR', 'Invalid base64.');
  const buffer = Buffer.from(encoded, 'base64');
  if (buffer.length > MAX_IMPORT_BYTES) fail('FILE_TOO_LARGE', 'File exceeds 20 MiB.', 413);
  if (buffer.toString('base64') !== encoded) fail('VALIDATION_ERROR', 'Invalid base64.');
  // Sites currently have no timezone column. The application default is explicit, never host-local.
  const timeZone = 'Europe/Rome', binding = { buffer, family, siteId, timeZone };
  if (apply) verifyPreviewToken(input.preview_token, binding);
  const parsed = parseFamily(buffer, family, { timeZone });
  if (apply) {
    verifyPreviewToken(input.preview_token, { ...binding, ...parsed });
    return applyFamily(db, { ...binding, ...parsed, filename: input.filename, user });
  }
  const diff = await diffFamily(db, { siteId, family, ...parsed });
  return { counts: Object.fromEntries(Object.entries(diff).map(([key, value]) => [key, value.count])),
    samples: Object.fromEntries(Object.entries(diff).map(([key, value]) => [key, value.samples])),
    unmapped_columns: parsed.unmapped_columns,
    preview_token: previewToken({ ...binding, ...parsed }) };
}
