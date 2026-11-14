// Display precision only: imported values and calculations retain their original precision.
export function formatDisplayNumber(value, { kind = 'number', language = 'it', currency = 'EUR', signed = false } = {}) {
  if (value == null || value === '') return '—';
  const digits = { money: 2, hours: 1, count: 0 }[kind];
  const options = digits == null ? { minimumFractionDigits: 0, maximumFractionDigits: 4 }
    : { minimumFractionDigits: digits, maximumFractionDigits: digits };
  if (kind === 'money') Object.assign(options, { style: 'currency', currency });
  if (signed) options.signDisplay = 'always';
  return new Intl.NumberFormat(language === 'it' ? 'it-IT' : 'en-GB', { ...options, useGrouping: 'always' }).format(Number(value));
}

export const STATUSES = ['todo', 'in_progress', 'to_verify', 'closed', 'blocked'];
export const PRIORITIES = ['normal', 'high', 'urgent'];
export const TASK_KINDS = Object.freeze(['ordinary', 'corrective']);
export const taskKindLabelKey = kind => kind === 'corrective' ? 'kindCorrective' : 'kindOrdinary';
export const TASK_COLUMNS = Object.freeze(['title', 'area', 'status', 'company', 'assignee', 'reviewer', 'due']);
export const REPORT_PROGRESS_COLUMNS = ['reportArea', 'reportItems', 'reportActual', 'reportPlanned', 'reportSource'];
export const REPORT_DEVIATION_COLUMNS = ['reportArea', 'reportTotal', 'reportOpen', 'reportClosed', 'reportByStatus'];

// CSV rows for the printable report. Values stay raw so the caller applies labels;
// a missing number becomes an empty cell instead of the word "null".
export function reportProgressRows(progress) {
  return (progress || []).map(row => [row.area, row.items, row.actual ?? '', row.planned ?? '', row.source]);
}
export function reportDeviationRows(deviations, label = status => status ?? 'unknown') {
  return (deviations || []).map(row => [row.area, row.total, row.open, row.closed,
    (row.by_status || []).map(entry => `${label(entry.status)}: ${entry.count}`).join('; ')]);
}


export function defaultViewState() {
  return { filters: { search: '', status: '', person: '', priority: '' },
    sort: { key: 'due', direction: 'asc' }, columns: [...TASK_COLUMNS], layout: 'board' };
}
// Read only contract fields, without traversing arbitrary stored objects. Bounded text
// and column input keep even malformed legacy payloads small and cheap to sanitize.
export function sanitizeViewState(payload) {
  const result = defaultViewState();
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const own = (value, key) => object(value) && Object.hasOwn(value, key) ? value[key] : undefined;
  try {
    const filters = own(payload, 'filters'), sort = own(payload, 'sort');
    for (const key of ['search', 'person']) {
      const value = own(filters, key);
      if (typeof value === 'string') result.filters[key] = value.slice(0, 512);
    }
    for (const [key, allowed] of [['status', STATUSES], ['priority', PRIORITIES]]) {
      const value = own(filters, key);
      if (allowed.includes(value)) result.filters[key] = value;
    }
    const key = own(sort, 'key'), direction = own(sort, 'direction');
    if (TASK_COLUMNS.includes(key)) result.sort.key = key;
    if (['asc', 'desc'].includes(direction)) result.sort.direction = direction;
    const columns = own(payload, 'columns');
    if (Array.isArray(columns)) {
      const known = new Set(columns.slice(0, 64));
      const visible = TASK_COLUMNS.filter(column => known.has(column));
      // At least one column remains visible, in the established table order.
      if (visible.length) result.columns = visible;
    }
    const layout = own(payload, 'layout');
    if (['board', 'list', 'light'].includes(layout)) result.layout = layout;
    return result;
  } catch {
    // Non-JSON callers may supply throwing getters or revoked proxies.
    return defaultViewState();
  }
}
export function viewStatePayload(state) { return sanitizeViewState(state); }

// Apply after the shared search and filters; never include corrective work.
export function lightTaskRows(tasks) {
  return tasks.filter(task => task.kind === 'ordinary').sort((a, b) => {
    const closed = Number(a.status === 'closed') - Number(b.status === 'closed');
    if (closed) return closed;
    if (Boolean(a.due) !== Boolean(b.due)) return a.due ? -1 : 1;
    return String(a.due ?? '').localeCompare(String(b.due ?? ''))
      || String(a.title ?? '').localeCompare(String(b.title ?? ''), 'en', { numeric: true })
      || String(a.id).localeCompare(String(b.id));
  });
}

export function transitionNeedsDialog(requirements) {
  return Boolean(requirements.note || requirements.reason);
}

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
  // Only an explicit corrective classification is sent; the server defaults to ordinary.
  if (input.kind === 'corrective') result.kind = 'corrective';
  else if (input.kind !== undefined && input.kind !== '' && input.kind !== 'ordinary') fail('invalidData');
  if (result.executor === result.verifier) fail('separatePeople');
  for (const key of ['executor_id', 'verifier_id']) {
    if (input[key] != null && input[key] !== '') result[key] = text(input[key], true);
  }
  if (result.executor_id && result.executor_id === result.verifier_id) fail('separatePeople');
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

const APP_VIEWS = ['today', 'overview', 'sites', 'tasks', 'wbs', 'deviations', 'progress', 'bookings', 'impacts', 'diary', 'tools', 'certifications', 'hse', 'report'];
export function initialView({ width, hash = '' }) {
  if (!hash) return width < 800 ? 'today' : 'overview';
  const name = hash.replace(/^#/, '');
  return APP_VIEWS.includes(name) ? name : 'overview';
}

// Targets and metadata contain contract fields and translation keys, never UI text.
export function todayActions({ tasks = [], progress = [], diary = [], deviations = [], userId, today: day, modules = {} }) {
  const rows = [], seen = new Set();
  const orderedTasks = filterSortRecords(tasks, {}, [{ key: 'due' }, { key: 'title' }, { key: 'id' }]);
  const addTask = (task, label) => {
    if (seen.has(task.id)) return;
    seen.add(task.id);
    rows.push({ kind: 'task', id: task.id, title: task.title, meta: { label, status: task.status, due: task.due ?? null },
      target: { view: 'tasks', filters: { id: task.id } } });
  };
  if (visibleModules(['tasks'], modules).length) {
    for (const task of orderedTasks) if (userId && task.executor_id === userId && task.status !== 'closed' && task.due && task.due <= day) addTask(task, 'todayMine');
    for (const task of orderedTasks) if (userId && task.verifier_id === userId && task.status === 'to_verify') addTask(task, 'todayVerify');
  }
  if (visibleModules(['progress'], modules).length) {
    const open = progress.filter(item => Array.isArray(item.steps)
      ? item.steps.some(step => step.percent == null || Number(step.percent) < 100)
      // List responses expose the computed aggregate, detail responses expose steps.
      : item.progressTypeId != null && item.progressPct != null && Number(item.progressPct) < 100);
    for (const item of filterSortRecords(open, {}, [{ key: 'description' }, { key: 'id' }]).slice(0, 2)) {
      rows.push({ kind: 'progress', id: item.id, title: item.description, meta: { label: 'todayOpenSteps' },
        target: { view: 'progress', filters: { id: item.id } } });
    }
  }
  if (visibleModules(['diary'], modules).length && !diary.some(entry => entry.date === day)) {
    rows.push({ kind: 'diary', id: day, title: null, meta: { label: 'todayDiaryMissing', date: day }, target: { view: 'diary', date: day } });
  }
  if (visibleModules(['deviations'], modules).length) {
    for (const item of filterSortRecords(deviations.filter(row => ['open', 'approved', 'in_progress', 'work_completed'].includes(row.status)), {}, [{ key: 'creationDate' }, { key: 'id' }])) {
      rows.push({ kind: 'deviation', id: item.id, title: item.title, meta: { label: 'todayReadOnly', status: item.status },
        target: { view: 'deviations', filters: { id: item.id } } });
    }
  }
  if (visibleModules(['tasks'], modules).length) {
    for (const task of orderedTasks) if (task.executor_id == null && task.status !== 'closed' && task.due && task.due < day) addTask(task, 'todayUnassigned');
  }
  return rows.slice(0, 5);
}

export function recentActions({ tasks = [] }) {
  const closure = task => typeof task.closedAt === 'string' && Number.isFinite(Date.parse(task.closedAt)) ? task.closedAt : null;
  return tasks.filter(task => task.status === 'closed').sort((a, b) => {
    const first = closure(a), second = closure(b);
    if (first && second) return Date.parse(second) - Date.parse(first) || String(a.id).localeCompare(String(b.id));
    if (Boolean(first) !== Boolean(second)) return first ? -1 : 1;
    return String(b.due || '').localeCompare(String(a.due || '')) || String(a.id).localeCompare(String(b.id));
  }).slice(0, 3).map(task => ({ id: task.id, title: task.title, date: closure(task), target: { view: 'tasks', filters: { id: task.id } } }));
}
export function csvCell(value) {
  let result = String(value ?? '');
  if (/^[\s\u0000-\u001f]*[=+@-]/u.test(result) || /^[\t\r\n]/u.test(result)) result = `'${result}`;
  return `"${result.replaceAll('"', '""')}"`;
}

export const DEVIATION_STATUSES = ['open', 'approved', 'in_progress', 'work_completed', 'closed', 'rejected'];
// Presentation groups preserve each record and its precise official status.
export function groupDeviationRows(records = []) {
  const groups = [
    { label: 'deviationsGroupOpen', statuses: ['open', 'approved'] },
    { label: 'deviationsGroupInProgress', statuses: ['in_progress'] },
    { label: 'deviationsGroupToClose', statuses: ['work_completed'] },
    { label: 'deviationsGroupClosed', statuses: ['closed', 'rejected'] },
  ].map(group => ({ ...group, rows: records.filter(row => group.statuses.includes(row.status)) }));
  const unknown = records.filter(row => !DEVIATION_STATUSES.includes(row.status));
  if (unknown.length) groups.push({ label: 'coreUnmappedStatus', statuses: [], rows: unknown });
  return groups;
}
export const IMPACT_STATUSES = ['open', 'notification_sent', 'submitted', 'closed'];
export const IMPACT_RESULTS = ['settled', 'dropped', 'rejected'];
export const TOOL_STATUSES = Object.freeze(['available', 'in_use', 'maintenance', 'retired']);
export const TOOL_STATUS_LABELS = Object.freeze({
  available: 'toolStatusAvailable', in_use: 'toolStatusInUse',
  maintenance: 'toolStatusMaintenance', retired: 'toolStatusRetired',
});
const NAV_GROUPS = Object.freeze([
  Object.freeze({ label: 'navOperations', items: Object.freeze(['overview', 'tasks', 'deviations', 'diary']) }),
  Object.freeze({ label: 'navSite', items: Object.freeze(['progress', 'bookings', 'wbs', 'impacts']) }),
  Object.freeze({ label: 'navManagement', items: Object.freeze(['sites', 'tools', 'certifications', 'hse']) }),
]);
export function visibleModules(items, modules = {}) {
  return items.filter(module => ['sites', 'overview', 'today'].includes(module) || modules[module] !== false);
}
export function navGroups(modules = {}) {
  return NAV_GROUPS.map(group => ({ label: group.label, items: visibleModules(group.items, modules) }))
    .filter(group => group.items.length);
}
export function toolStatusLabelKey(status) {
  return TOOL_STATUS_LABELS[status] || 'coreUnknown';
}
export function toolCompanies(tools = []) {
  return [...new Set(tools.map(tool => tool?.company).filter(company => typeof company === 'string' && company))].sort();
}
export function filterTools(tools = [], { company = '', status = '' } = {}) {
  return tools.filter(tool => (!company || tool.company === company) && (!status || tool.status === status))
    .sort((a, b) => {
      if (a.company == null && b.company != null) return 1;
      if (a.company != null && b.company == null) return -1;
      return String(a.company ?? '').localeCompare(String(b.company ?? ''), 'en', { numeric: true })
        || String(a.name ?? '').localeCompare(String(b.name ?? ''), 'en', { numeric: true })
        || String(a.id ?? '').localeCompare(String(b.id ?? ''));
    });
}
export const CERT_CATEGORIES = Object.freeze(['qualification', 'medical', 'training', 'other']);
export const CERT_STATUSES = Object.freeze(['expired', 'expiring', 'valid', 'no_expiry']);
export const certCategoryLabelKey = category => CERT_CATEGORIES.includes(category) ? `certCategory_${category}` : 'coreUnknown';
export const certStatusLabelKey = status => CERT_STATUSES.includes(status) ? `certStatus_${status}` : 'coreUnknown';
export function filterCertifications(certifications = [], { employee = '', category = '', status: state = '' } = {}) {
  return certifications.filter(cert => (!employee || cert.employee_id === employee)
    && (!category || cert.category === category) && (!state || cert.status === state));
}
export function certificationCounts(certifications = []) {
  const counts = { expired: 0, expiring: 0, valid: 0, no_expiry: 0 };
  for (const cert of certifications) if (counts[cert.status] !== undefined) counts[cert.status] += 1;
  return counts;
}
export function impactTransitions(status) {
  return [...({ open: ['notification_sent', 'closed'], notification_sent: ['submitted'], submitted: ['closed'], closed: [] }[status] || [])];
}
export function corePermissions(role) {
  return { book: ['editor', 'owner'].includes(role), transition: ['owner', 'verifier'].includes(role),
    steps: ['editor', 'owner'].includes(role), assign: role === 'owner',
    tools: ['owner', 'editor', 'verifier'].includes(role),
    certifications: ['owner', 'editor', 'verifier'].includes(role),
    certificationWrite: ['owner', 'editor'].includes(role),
    hse: ['owner', 'editor', 'verifier'].includes(role),
    hseWrite: ['owner', 'editor'].includes(role) };
}
export const HSE_TYPES = Object.freeze(['near_miss', 'accident', 'observation']);
export const HSE_SEVERITIES = Object.freeze(['low', 'medium', 'high']);
export function filterHseEvents(events = [], { type = '', severity = '', from = '', to = '' } = {}) {
  return events.filter(row => (!type || row.type === type) && (!severity || row.severity === severity)
    && (!from || row.occurredOn >= from) && (!to || row.occurredOn <= to))
    .sort((a, b) => b.occurredOn.localeCompare(a.occurredOn) || a.id.localeCompare(b.id));
}
export function hseCounts(events = []) {
  const byType = Object.fromEntries(HSE_TYPES.map(type => [type, 0]));
  for (const row of events) if (Object.hasOwn(byType, row.type)) byType[row.type] += 1;
  return { ...byType, total: events.length };
}
// Which offline banner to show, if any. A missing service worker never raises a permanent
// error while the app is online; the storage message is reserved for a broken IndexedDB.
export function offlineBannerState({ offline = false, storageError = false, swUnavailable = false, pending = 0 } = {}) {
  const queued = pending > 0;
  return {
    visible: Boolean(offline || storageError || queued || (swUnavailable && (offline || queued))),
    offline: Boolean(offline),
    storage: Boolean(storageError),
    serviceWorker: Boolean(swUnavailable && (offline || queued)),
    pending: queued ? pending : 0,
  };
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
  const groupFor = (day, workDayId) => {
    const date = day?.operationalDate ?? null, employeeId = day?.employeeId ?? null;
    // Keep unresolved work days separate rather than inventing a shared employee.
    const key = JSON.stringify([day?.siteId ?? null, date, employeeId ?? workDayId]);
    if (!groups.has(key)) groups.set(key, { date, employeeId, employee: people.get(employeeId), workDays: [], rows: [] });
    return groups.get(key);
  };
  for (const day of workDays) groupFor(day, day.id).workDays.push(day);
  for (const booking of bookings) {
    const day = days.get(booking.workDayId), employee = people.get(day?.employeeId);
    const group = groupFor(day, booking.workDayId);
    group.rows.push({ ...booking, day, employee, item: progress.get(booking.siteProgressItemId), employeeNo: employee?.employeeNo ?? null });
  }
  const result = [...groups.values()].map(group => {
    // Source totals count each work day once, even when it has several bookings.
    const sourceWorkTime = sourceHours(group.workDays, 'workTime');
    const sourceBookedHours = sourceHours(group.workDays, 'bookedHours');
    const sourceOpenHours = sourceHours(group.workDays, 'openHours');
    const appBookedHours = Number(decimalTotal(group.rows.map(row => row.hours)));
    const missing = Object.entries({ sourceWorkTime, sourceBookedHours, sourceOpenHours })
      .filter(([, value]) => value == null).map(([field]) => field);
    const variance = sourceWorkTime == null || sourceBookedHours == null ? null
      : Number(decimalTotal([sourceWorkTime, -sourceBookedHours, -appBookedHours]));
    return { ...group, sourceWorkTime, sourceBookedHours, sourceOpenHours, appBookedHours, variance, missing,
      employeeNo: group.employee?.employeeNo ?? null,
      rows: filterSortRecords(group.rows, {}, [{ key: 'siteProgressItemId' }]) };
  });
  return filterSortRecords(result, {}, [{ key: 'date', descending: true }, { key: 'employeeNo' }, { key: 'employeeId' }]);
}

// A partial source total is unknown; missing input must never become zero.
function sourceHours(workDays, field) {
  if (!workDays.length || workDays.some(day => day[field] == null)) return null;
  return Number(decimalTotal(workDays.map(day => day[field])));
}

export function weeklyBookingHours(bookedWeeks, workDays) {
  const byWeek = new Map(bookedWeeks.map(row => [row.week, { week: row.week, appBookedHours: row.hours, workDays: [] }]));
  for (const day of workDays) {
    if (!validDate(day.operationalDate)) continue;
    const date = new Date(`${day.operationalDate}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7);
    const week = date.toISOString().slice(0, 10);
    if (!byWeek.has(week)) byWeek.set(week, { week, appBookedHours: 0, workDays: [] });
    byWeek.get(week).workDays.push(day);
  }
  return [...byWeek.values()].sort((a, b) => a.week.localeCompare(b.week)).slice(-6)
    .map(({ week, appBookedHours, workDays: days }) => ({ week, appBookedHours, sourceWorkTime: sourceHours(days, 'workTime') }));
}
export function progressWithHours(items, bookings) {
  const hours = new Map();
  for (const row of bookings) hours.set(row.siteProgressItemId, (hours.get(row.siteProgressItemId) || 0) + Number(row.hours));
  return items.map(item => ({ ...item, bookedHours: item.bookedHours ?? hours.get(item.id) ?? 0 }));
}
export function flattenWbs(nodes) {
  return nodes.flatMap(node => [node, ...flattenWbs(node.children || [])]);
}
// A text hint for human review, never detection of the contents of an image.
export function hseAttachmentNeedsReview(filename = '', description = '') {
  return /(?:^|[^\p{L}])(?:person(?:a|e|s)?|people|infortuni(?:o)?|ferit[aeoi]|sangue|vis[oi]|volt[oi]|injur(?:y|ies|ed)|wound(?:s|ed)?|blood(?:y)?|faces?)(?=$|[^\p{L}])/iu.test(`${filename} ${description}`);
}
