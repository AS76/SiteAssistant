export const STATUSES = ['todo', 'in_progress', 'to_verify', 'closed', 'blocked'];
export const PRIORITIES = ['normal', 'high', 'urgent'];
const transitions = {
  todo: ['in_progress', 'blocked'],
  in_progress: ['to_verify', 'blocked'],
  to_verify: ['closed', 'blocked'],
  closed: ['in_progress'],
  blocked: [],
};
const fail = code => { throw new Error(code); };
export function today(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
export function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
function text(value, required = false) {
  if (value == null) value = '';
  if (typeof value !== 'string' || value.length > 10000 || (required && !value.trim())) fail('invalidData');
  return value.trim();
}
function date(value, required = false) {
  const result = text(value, required);
  if (!result && !required) return null;
  if (!validDate(result)) fail('invalidDate');
  return result;
}
// Validate form values and map them to the API's write payloads.
export function sitePayload(input) {
  const result = { code: text(input.code, true), name: text(input.name, true), location: text(input.location), start_date: date(input.start), end_date: date(input.end) };
  if (result.start_date && result.end_date && result.end_date < result.start_date) fail('dateOrder');
  return result;
}
export function taskPayload(input) {
  const result = {
    siteId: text(input.siteId, true), title: text(input.title, true), area: text(input.area), company: text(input.company),
    executor: text(input.assignee, true), verifier: text(input.reviewer, true), priority: text(input.priority) || 'normal', due_date: date(input.due),
  };
  if (result.executor === result.verifier) fail('separatePeople');
  return result;
}
export function diaryPayload(input) {
  if (!['day', 'night'].includes(input.shift)) fail('invalidData');
  return { siteId: text(input.siteId, true), operational_date: date(input.date, true), shift: input.shift,
    plan: text(input.plan), actual: text(input.actual), impediments: text(input.blockers), next_step: text(input.next) };
}
export function allowedTransitions(task) {
  return [...(transitions[task.status] || [])];
}
export function transitionRequirements(task, to) {
  return { note: ['to_verify', 'closed'].includes(to), reason: to === 'blocked' || task.status === 'closed' };
}
export function transitionPayload(task, input) {
  if (!allowedTransitions(task).includes(input.to)) fail('actionDenied');
  const result = { to: input.to, actor: text(input.actor, true), note: text(input.note), reason: text(input.reason) };
  const required = transitionRequirements(task, input.to);
  if (required.note && !result.note) fail('noteRequired');
  if (required.reason && !result.reason) fail('reasonRequired');
  return result;
}
export function counts(tasks, referenceDate = today()) {
  return { execution: tasks.filter(task => ['todo', 'in_progress', 'blocked'].includes(task.status)).length,
    review: tasks.filter(task => task.status === 'to_verify').length,
    closed: tasks.filter(task => task.status === 'closed').length,
    overdue: tasks.filter(task => task.status !== 'closed' && task.due && task.due < referenceDate).length,
    blocked: tasks.filter(task => task.status === 'blocked').length };
}
export function csvCell(value) {
  let result = String(value ?? '');
  if (/^[\s\u0000-\u001f]*[=+@-]/u.test(result) || /^[\t\r\n]/u.test(result)) result = `'${result}`;
  return `"${result.replaceAll('"', '""')}"`;
}

export const DEVIATION_STATUSES = ['open', 'approved', 'in_progress', 'work_completed', 'closed', 'rejected'];
export const IMPACT_STATUSES = ['open', 'notification_sent', 'submitted', 'closed'];
export const IMPACT_RESULTS = ['settled', 'dropped', 'rejected'];
export function impactTransitions(status) {
  return [...({ open: ['notification_sent', 'closed'], notification_sent: ['submitted'], submitted: ['closed'], closed: [] }[status] || [])];
}
export function corePermissions(role) {
  return { book: ['editor', 'owner'].includes(role), transition: ['owner', 'verifier'].includes(role) };
}
// Exact matching, nulls last and ID tie-breaking keep imported lists stable without mutating the cache.
export function filterSortRecords(records, filters = {}, sort = [{ key: 'title' }]) {
  return records.filter(row => Object.entries(filters).every(([key, value]) =>
    value === '' || value === undefined || row[key] === value)).sort((a, b) => {
    for (const { key, descending = false } of sort) {
      const av = a[key], bv = b[key];
      if (av == null && bv == null) continue;
      if (av == null) return 1;
      if (bv == null) return -1;
      const order = typeof av === 'number' && typeof bv === 'number' ? av - bv
        : String(av).localeCompare(String(bv), 'en', { numeric: true });
      if (order) return descending ? -order : order;
    }
    return String(a.id).localeCompare(String(b.id));
  });
}
// Add decimal amounts without losing PostgreSQL NUMERIC precision or assuming a currency.
function decimalTotal(values) {
  if (!values.length) return '0';
  let total = 0n, scale = 0, known = 0;
  for (const value of values) {
    if (value == null) continue;
    const match = /^([+-]?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(String(value));
    if (!match) continue;
    let digits = BigInt(`${match[1] === '-' ? '-' : ''}${match[2]}${match[3] || ''}`);
    let places = (match[3]?.length || 0) - Number(match[4] || 0);
    if (places < 0) { digits *= 10n ** BigInt(-places); places = 0; }
    const nextScale = Math.max(scale, places);
    total = total * 10n ** BigInt(nextScale - scale) + digits * 10n ** BigInt(nextScale - places);
    scale = nextScale; known++;
  }
  if (!known) return null;
  const sign = total < 0n ? '-' : '', digits = (total < 0n ? -total : total).toString().padStart(scale + 1, '0');
  return sign + (scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}` : digits);
}
export function impactTotals(records) {
  return { claimAmount: decimalTotal(records.map(row => row.claimAmount)), settlementAmount: decimalTotal(records.map(row => row.settlementAmount)),
    missingClaim: records.filter(row => row.claimAmount == null).length, missingSettlement: records.filter(row => row.settlementAmount == null).length };
}
export function groupBookings(bookings, workDays, employees, items) {
  const days = new Map(workDays.map(row => [row.id, row])), people = new Map(employees.map(row => [row.id, row]));
  const progress = new Map(items.map(row => [row.id, row])), groups = new Map();
  for (const booking of bookings) {
    const day = days.get(booking.workDayId), employee = people.get(day?.employeeId);
    const date = day?.operationalDate ?? null;
    if (!groups.has(date)) groups.set(date, { date, hours: 0, rows: [] });
    const group = groups.get(date);
    group.hours += Number(booking.hours);
    group.rows.push({ ...booking, day, employee, item: progress.get(booking.siteProgressItemId), employeeNo: employee?.employeeNo ?? null });
  }
  return [...groups.values()].sort((a, b) => a.date == null ? 1 : b.date == null ? -1 : b.date.localeCompare(a.date))
    .map(group => ({ ...group, rows: filterSortRecords(group.rows, {}, [{ key: 'employeeNo' }, { key: 'siteProgressItemId' }]) }));
}
export function progressWithHours(items, bookings) {
  const hours = new Map();
  for (const row of bookings) hours.set(row.siteProgressItemId, (hours.get(row.siteProgressItemId) || 0) + Number(row.hours));
  return items.map(item => ({ ...item, bookedHours: item.bookedHours ?? hours.get(item.id) ?? 0 }));
}
export function flattenWbs(nodes) {
  return nodes.flatMap(node => [node, ...flattenWbs(node.children || [])]);
}
