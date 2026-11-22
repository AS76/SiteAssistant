import { createHash } from 'node:crypto';
import { RepositoryError, getSite, requireRole } from './repository.mjs';
import { requireModule } from './module-access.mjs';
import { shiftForLocalTime } from './operational-day.mjs';

const fail = (status, message, code = 'HR_RECONCILIATION_REQUIRED') => { throw new RepositoryError(status, message, code); };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const employeeFields = ['employee_no', 'first_name', 'last_name', 'company', 'qualification', 'supervisor', 'team', 'hire_date', 'expire_date'];
const workFields = ['employee_id', 'operational_date', 'shift', 'start_time', 'finish_time', 'work_time', 'open_hours', 'booked_hours', 'source_status'];
const temporal = new Set(['hire_date', 'expire_date', 'operational_date', 'start_time', 'finish_time']);
// DATE/TIME are source calendar values, never driver-decoded local Date objects.
const selectFields = (fields, prefix = '') => fields.map(field => temporal.has(field)
  ? `CAST(${prefix}${field} AS TEXT) AS ${field}` : `${prefix}${field}`).join(', ');
const appFields = fields => selectFields(['id', 'site_id', ...fields, 'source_entity_key_id', 'created_at']);

function validId(value, field) {
  if (typeof value !== 'string' || !uuid.test(value)) fail(400, `${field} must be a UUID.`, 'VALIDATION_ERROR');
  return value.toLowerCase();
}
function date(value, status = 409) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\d$/.test(value) ||
      (status === 400 && value.startsWith('0000-')) ||
      !Number.isFinite(Date.parse(`${value}T00:00:00Z`)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) {
    fail(status, 'A valid YYYY-MM-DD date is required.', status === 400 ? 'VALIDATION_ERROR' : 'HR_RECONCILIATION_REQUIRED');
  }
  return value;
}
function time(value) {
  if (value === null) return null;
  if (typeof value !== 'string' || !/^(?:(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,6})?)?|24:00:00(?:\.0{1,6})?)$/.test(value)) {
    fail(409, 'Invalid source time.');
  }
  return value;
}
function stableId(...parts) {
  const hex = createHash('sha256').update(JSON.stringify(parts)).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

async function requireWorkforceAccess(db, site, user, module) {
  if (!user?.id) fail(401, 'Authentication required.', 'UNAUTHENTICATED');
  await requireRole(db, site, user);
  await requireModule(db, site, user, module);
}

export async function listEmployees(db, { siteId: input } = {}, user) {
  const site = validId(input, 'site_id');
  await requireWorkforceAccess(db, site, user, 'workforce_names');
  return db.all(`SELECT ${appFields(employeeFields)} FROM employees WHERE site_id = ? ORDER BY employee_no, id`, site);
}

export async function getEmployee(db, id, user) {
  const employeeId = typeof id === 'string' && uuid.test(id) ? id.toLowerCase() : null;
  const locator = employeeId && await db.get('SELECT site_id FROM employees WHERE id = ?', employeeId);
  if (!locator) fail(404, 'Employee not found.', 'EMPLOYEE_NOT_FOUND');
  await requireWorkforceAccess(db, locator.site_id, user, 'workforce_names');
  const row = await db.get(`SELECT ${appFields(employeeFields)} FROM employees WHERE id = ? AND site_id = ?`, employeeId, locator.site_id);
  if (!row) fail(404, 'Employee not found.', 'EMPLOYEE_NOT_FOUND');
  return { ...row, work_days: await workDayRows(db, ['site_id = ?', 'employee_id = ?'], [row.site_id, row.id]) };
}

function workDayRows(db, clauses, values) {
  return db.all(`SELECT ${appFields(workFields)} FROM work_days WHERE ${clauses.join(' AND ')} ORDER BY operational_date, id`, ...values);
}

export async function listWorkDays(db, { siteId: input, employee_id, from, to } = {}, user) {
  const site = validId(input, 'site_id'), clauses = ['site_id = ?'], values = [site];
  if (employee_id != null) { clauses.push('employee_id = ?'); values.push(validId(employee_id, 'employee_id')); }
  if (from != null) { clauses.push('operational_date >= ?'); values.push(date(from, 400)); }
  if (to != null) { clauses.push('operational_date <= ?'); values.push(date(to, 400)); }
  if (from != null && to != null && from > to) fail(400, 'from must not follow to.', 'VALIDATION_ERROR');
  await requireWorkforceAccess(db, site, user, 'workforce_names');
  return workDayRows(db, clauses, values);
}

const summaryGroups = new Map([
  ['company', 'e.company'],
  ['day', 'w.operational_date'],
  ['period', null],
]);
const summaryHours = ['work_time', 'open_hours', 'booked_hours'];
const dayMillis = 86_400_000;

export async function workforceSummary(db, { siteId: input, groupBy, from, to }, user) {
  const site = validId(input, 'site_id');
  if (!summaryGroups.has(groupBy)) fail(400, 'group_by must be company, day or period.', 'VALIDATION_ERROR');
  date(from, 400);
  date(to, 400);
  const span = (Date.parse(to) - Date.parse(from)) / dayMillis + 1;
  if (span < 1 || span > 366) fail(400, 'The date range must include between 1 and 366 days.', 'VALIDATION_ERROR');
  await requireWorkforceAccess(db, site, user, 'bookings');

  const group = summaryGroups.get(groupBy);
  // Preserve the existing meaning of a partial source total as unknown.
  const hours = summaryHours.map(field => `CASE WHEN COUNT(w.${field}) = COUNT(*) THEN SUM(w.${field}) END AS ${field}`).join(', ');
  const rows = await db.all(`SELECT ${group ? `CAST(${group} AS TEXT) AS group_key, ` : ''}${hours}
    FROM work_days w
    ${groupBy === 'company' ? 'LEFT JOIN employees e ON e.id = w.employee_id AND e.site_id = w.site_id' : ''}
    WHERE w.site_id = ? AND w.operational_date BETWEEN ? AND ?
    ${group ? `GROUP BY ${group} ORDER BY ${group} IS NULL, ${group}` : 'HAVING COUNT(*) > 0'}`, site, from, to);
  return rows.map(row => ({
    group_key: group ? row.group_key : `${from}/${to}`,
    ...Object.fromEntries(summaryHours.map(field => [field, row[field] == null ? null : Number(row[field])])),
  }));
}

export async function workforcePresence(db, { siteId: input, date: inputDate }, user) {
  const site = validId(input, 'site_id'), day = date(inputDate, 400);
  await requireWorkforceAccess(db, site, user, 'workforce_presence');
  return db.all(`SELECT e.first_name, e.last_name, e.company, w.shift, ${selectFields(['start_time', 'finish_time'], 'w.')}
    FROM work_days w JOIN employees e ON e.id = w.employee_id AND e.site_id = w.site_id
    WHERE w.site_id = ? AND w.operational_date = ?
    ORDER BY e.last_name, e.first_name, w.start_time, w.id`, site, day);
}

async function sourceRows(tx, family, batch, scope) {
  const fields = family === 'employees' ? employeeFields
    : ['source_uuid', 'employee_no', 'operational_date', 'start_time', 'finish_time', 'work_time_source', 'open_hours_source', 'booked_hours_source', 'source_status'];
  const rows = await tx.all(`SELECT ${selectFields(fields, 's.')}, s._identity_key,
    e.id AS source_entity_key_id, e.identity_state
    FROM source_snapshot.${family} s LEFT JOIN ingest.entity_keys e
      ON e.scope_id = s._scope_id AND e.family = ? AND e.external_key = s._identity_key
    WHERE s._batch_id = ? AND s._scope_id = ? ORDER BY s._source_row`, family, batch.batch_id, scope);
  if (rows.length !== Number(batch.expected_rows)) fail(409, 'Snapshot row count differs from the typed batch.', 'HR_INCOMPLETE_SNAPSHOT');
  const seen = new Set();
  for (const row of rows) {
    const key = family === 'employees' ? row.employee_no : row.source_uuid;
    if (typeof key !== 'string' || !key.trim() || (family === 'work_days' && !uuid.test(key)) ||
        key !== row._identity_key || seen.has(key) || !row.source_entity_key_id || !['observed', 'manual'].includes(row.identity_state)) {
      fail(409, 'Missing, duplicate or unresolved source identity; reconcile the snapshot.');
    }
    seen.add(key);
  }
  return rows;
}

export async function importEmployees(db, inputSite, user) {
  if (!user?.id) fail(401, 'Authentication required.', 'UNAUTHENTICATED');
  const site = validId(inputSite, 'site_id');
  return db.transaction(async tx => {
    await requireRole(tx, site, user, ['owner']);
    await tx.run('UPDATE sites SET id = id WHERE id = ?', site);
    const { day_cutoff_time: dayStart } = await getSite(tx, site);
    const config = await tx.get('SELECT * FROM hr_import_sources WHERE site_id = ?', site);
    if (!config) fail(409, 'Configure an explicit source scope and completed import run for this site.', 'HR_SOURCE_NOT_CONFIGURED');
    let batches, employees, workDays;
    try {
      batches = await tx.all(`SELECT rb.family, rb.batch_id, b.expected_rows
        FROM ingest.import_runs r JOIN ingest.run_batches rb ON rb.run_id = r.id AND rb.scope_id = r.scope_id
        JOIN ingest.import_batches b ON b.id = rb.batch_id AND b.scope_id = rb.scope_id AND b.family = rb.family
        WHERE r.id = ? AND r.scope_id = ? AND r.status = 'ready' AND r.completeness_verified = TRUE
          AND rb.family IN ('employees', 'work_days') AND b.status = 'typed'`, config.run_id, config.scope_id);
      const byFamily = Object.fromEntries(batches.map(batch => [batch.family, batch]));
      if (batches.length !== 2 || !byFamily.employees || !byFamily.work_days) {
        fail(409, 'A complete ready run with typed Employees and Work Days batches is required.', 'HR_RUN_NOT_READY');
      }
      if (config.promoted_run_id === config.run_id && config.promoted_employees_batch_id === byFamily.employees.batch_id &&
          config.promoted_work_days_batch_id === byFamily.work_days.batch_id) {
        return { employees: 0, work_days: 0, unchanged: true, run_id: config.run_id };
      }
      employees = await sourceRows(tx, 'employees', byFamily.employees, config.scope_id);
      workDays = await sourceRows(tx, 'work_days', byFamily.work_days, config.scope_id);
    } catch (error) {
      if (['42P01', '3F000'].includes(error.code) || /no such table/.test(error.message)) {
        fail(409, 'Employees and Work Days ingestion schemas are not available.', 'HR_SOURCE_UNAVAILABLE');
      }
      throw error;
    }
    const employeeIds = new Map();
    for (const row of employees) {
      row.id = stableId('employee', site, row.employee_no);
      employeeIds.set(row.employee_no, row.id);
      for (const field of ['hire_date', 'expire_date']) if (row[field] !== null) date(row[field]);
    }
    for (const row of workDays) {
      row.id = stableId('work-day', site, config.scope_id, row.source_uuid.toLowerCase());
      row.employee_id = row.employee_no === null ? null : employeeIds.get(row.employee_no);
      if (row.employee_id === undefined) fail(409, 'Employee reference is absent from the selected Employees snapshot.');
      date(row.operational_date);
      time(row.start_time); time(row.finish_time);
      // The source date and times are already local calendar values.
      const clock = row.start_time?.slice(0, 5).replace('24:00', '00:00');
      row.shift = clock == null ? null : shiftForLocalTime(clock, { dayStart });
      for (const field of ['work_time', 'open_hours', 'booked_hours']) row[field] = row[`${field}_source`];
    }
    const at = new Date().toISOString();
    // Replace the current projection; keep IDs/timestamps for surviving identities.
    // Historical source snapshots and raw rows remain untouched.
    for (const [table, rows] of [['work_days', workDays], ['employees', employees]]) {
      const ids = new Set(rows.map(row => row.id));
      for (const existing of await tx.all(`SELECT id FROM ${table} WHERE site_id = ?`, site)) {
        if (!ids.has(existing.id)) await tx.run(`DELETE FROM ${table} WHERE id = ? AND site_id = ?`, existing.id, site);
      }
      // Existing work days can reference an employee removed in this new snapshot.
      if (table === 'work_days') await tx.run('UPDATE work_days SET employee_id = NULL WHERE site_id = ?', site);
    }
    for (const [table, rows, fields] of [['employees', employees, employeeFields], ['work_days', workDays, workFields]]) {
      const columns = ['site_id', ...fields, 'source_entity_key_id'];
      for (const row of rows) await tx.run(`INSERT INTO ${table} (id, ${columns.join(', ')}, created_at)
        VALUES (?, ${columns.map(() => '?').join(', ')}, ?)
        ON CONFLICT (id) DO UPDATE SET ${columns.map(column => `${column} = excluded.${column}`).join(', ')}`,
      row.id, ...columns.map(column => column === 'site_id' ? site : row[column]), at);
    }
    const batchIds = Object.fromEntries(batches.map(batch => [batch.family, batch.batch_id]));
    await tx.run(`UPDATE hr_import_sources SET promoted_run_id = ?, promoted_employees_batch_id = ?,
      promoted_work_days_batch_id = ?, promoted_at = ? WHERE site_id = ?`, config.run_id, batchIds.employees, batchIds.work_days, at, site);
    return { employees: employees.length, work_days: workDays.length, unchanged: false, run_id: config.run_id };
  });
}
