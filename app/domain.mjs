export const USERS = [
  { id: 'lead', key: 'lead' }, { id: 'worker', key: 'worker' }, { id: 'reviewer', key: 'reviewer' },
];
export const STATUSES = ['todo', 'active', 'blocked', 'review', 'closed'];
export const PRIORITIES = ['normal', 'high', 'urgent'];
export const SCHEMA_VERSION = 1;
const userIds = USERS.map(user => user.id);
const fail = code => { throw new Error(code); };
export const uid = () => globalThis.crypto.randomUUID();
export function today(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
export function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
function text(value, max = 4000, required = false) {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) fail('invalidData');
  return value.trim();
}
function id(value) { return text(value, 100, true); }
function person(value) { if (!userIds.includes(value)) fail('invalidPerson'); return value; }
function date(value, optional = false) {
  if (optional && value === '') return '';
  if (!validDate(value)) fail('invalidDate');
  return value;
}
function timestamp(value) {
  if (typeof value !== 'string' || value.length > 40 || !Number.isFinite(Date.parse(value))) fail('invalidData');
  return value;
}
function cleanSite(site) {
  const result = { id: id(site.id), code: text(site.code, 30, true), name: text(site.name, 120, true), location: text(site.location, 160), start: date(site.start, true), end: date(site.end, true) };
  if (result.start && result.end && result.end < result.start) fail('dateOrder');
  return result;
}
function cleanTask(task) {
  if (!STATUSES.includes(task.status) || !PRIORITIES.includes(task.priority)) fail('invalidData');
  if (!Array.isArray(task.history) || !task.history.length || task.history.length > 2000) fail('invalidData');
  const result = {
    id: id(task.id), siteId: id(task.siteId), title: text(task.title, 180, true), description: text(task.description),
    area: text(task.area, 100), company: text(task.company, 100, true), assignee: person(task.assignee), reviewer: person(task.reviewer),
    priority: task.priority, due: date(task.due, true), status: task.status, criteria: text(task.criteria, 2000, true),
    createdAt: timestamp(task.createdAt), submittedBy: task.submittedBy === null ? null : person(task.submittedBy),
    history: task.history.map(event => {
      if (!['created', 'updated', 'start', 'block', 'resume', 'submit', 'verify', 'reject', 'reopen'].includes(event.action) || !STATUSES.includes(event.status)) fail('invalidData');
      return { id: id(event.id), action: event.action, status: event.status, actor: person(event.actor), at: timestamp(event.at), note: text(event.note) };
    }),
  };
  if (result.assignee === result.reviewer) fail('separatePeople');
  if (['review', 'closed'].includes(result.status) && (result.submittedBy !== result.assignee || result.submittedBy === result.reviewer)) fail('invalidData');
  const last = result.history.at(-1);
  if (last.status !== result.status) fail('invalidData');
  if (result.status === 'closed' && !result.history.some(event => event.action === 'verify' && event.actor === result.reviewer && event.note)) fail('invalidData');
  return result;
}
export function validateState(raw) {
  if (!raw || raw.schemaVersion !== SCHEMA_VERSION || !Array.isArray(raw.sites) || !Array.isArray(raw.tasks) || !Array.isArray(raw.reports)) fail('invalidBackup');
  if (!raw.sites.length || raw.sites.length > 200 || raw.tasks.length > 10000 || raw.reports.length > 10000) fail('invalidBackup');
  const sites = raw.sites.map(cleanSite);
  const tasks = raw.tasks.map(cleanTask);
  const unique = values => new Set(values).size === values.length;
  if (!unique(sites.map(site => site.id)) || !unique(sites.map(site => site.code.toLowerCase())) || !unique(tasks.map(task => task.id))) fail('duplicate');
  const siteIds = new Set(sites.map(site => site.id));
  const taskById = new Map(tasks.map(task => [task.id, task]));
  if (tasks.some(task => !siteIds.has(task.siteId))) fail('invalidData');
  const reports = raw.reports.map(report => {
    if (!siteIds.has(report.siteId) || !Array.isArray(report.entries) || !report.entries.length || report.entries.length > 500) fail('invalidData');
    return { id: id(report.id), siteId: id(report.siteId), date: date(report.date), entries: report.entries.map(entry => {
      if (!['day', 'night'].includes(entry.shift)) fail('invalidData');
      const taskId = entry.taskId === '' ? '' : id(entry.taskId);
      if (taskId && taskById.get(taskId)?.siteId !== report.siteId) fail('wrongSite');
      return { id: id(entry.id), shift: entry.shift, taskId, plan: text(entry.plan, 4000, true), actual: text(entry.actual, 4000, true), blockers: text(entry.blockers), next: text(entry.next), author: person(entry.author), createdAt: timestamp(entry.createdAt) };
    }) };
  });
  if (!unique(reports.map(report => report.id)) || !unique(reports.map(report => `${report.siteId}:${report.date}`)) || !unique(reports.flatMap(report => report.entries.map(entry => entry.id)))) fail('duplicate');
  return { schemaVersion: SCHEMA_VERSION, sites, tasks, reports };
}
export function createSite(state, input) {
  const site = cleanSite({ ...input, id: uid() });
  if (state.sites.some(existing => existing.code.toLowerCase() === site.code.toLowerCase())) fail('duplicateCode');
  return { state: validateState({ ...state, sites: [...state.sites, site] }), site };
}
export function createTask(state, input, actor, at = new Date().toISOString()) {
  person(actor);
  if (!state.sites.some(site => site.id === input.siteId)) fail('wrongSite');
  const task = cleanTask({ ...input, id: uid(), status: 'todo', createdAt: at, submittedBy: null, history: [{ id: uid(), action: 'created', status: 'todo', actor, at, note: '' }] });
  return { ...state, tasks: [...state.tasks, task] };
}
export function allowedActions(task, actor) {
  const execute = actor === task.assignee;
  const manage = execute || actor === 'lead';
  const review = actor === task.reviewer && actor !== task.submittedBy;
  return [
    ...(task.status === 'todo' && manage ? ['start', 'block'] : []),
    ...(task.status === 'active' && manage ? ['block'] : []),
    ...(task.status === 'active' && execute ? ['submit'] : []),
    ...(task.status === 'blocked' && manage ? ['resume'] : []),
    ...(task.status === 'review' && review ? ['verify', 'reject'] : []),
    ...(task.status === 'closed' && (actor === 'lead' || actor === task.reviewer) ? ['reopen'] : []),
  ];
}
export function transition(state, taskId, action, actor, note = '', at = new Date().toISOString()) {
  const task = state.tasks.find(item => item.id === taskId);
  if (!task || !allowedActions(task, actor).includes(action)) fail('actionDenied');
  const reason = text(note);
  if (['block', 'submit', 'verify', 'reject', 'reopen'].includes(action) && !reason) fail('reasonRequired');
  const statuses = { start: 'active', block: 'blocked', resume: 'active', submit: 'review', verify: 'closed', reject: 'active', reopen: 'active' };
  const next = cleanTask({ ...task, status: statuses[action], submittedBy: action === 'submit' ? actor : ['reject', 'reopen'].includes(action) ? null : task.submittedBy,
    history: [...task.history, { id: uid(), action, status: statuses[action], actor, at, note: reason }] });
  return { ...state, tasks: state.tasks.map(item => item.id === taskId ? next : item) };
}
export function updateTask(state, taskId, input, actor, at = new Date().toISOString()) {
  const old = state.tasks.find(task => task.id === taskId);
  if (!old || !['todo', 'active', 'blocked'].includes(old.status) || (actor !== 'lead' && actor !== old.assignee)) fail('actionDenied');
  const task = cleanTask({ ...old, ...input, id: old.id, siteId: old.siteId, createdAt: old.createdAt, submittedBy: old.submittedBy, status: old.status,
    history: [...old.history, { id: uid(), action: 'updated', status: old.status, actor, at, note: '' }] });
  return { ...state, tasks: state.tasks.map(item => item.id === taskId ? task : item) };
}
export function addDiaryEntry(state, siteId, reportDate, input, actor, at = new Date().toISOString()) {
  person(actor);
  const entry = { ...input, id: uid(), author: actor, createdAt: at };
  const found = state.reports.find(report => report.siteId === siteId && report.date === reportDate);
  const reports = found ? state.reports.map(report => report.id === found.id ? { ...report, entries: [...report.entries, entry] } : report)
    : [...state.reports, { id: uid(), siteId, date: reportDate, entries: [entry] }];
  return validateState({ ...state, reports });
}
export function counts(tasks, referenceDate = today()) {
  return { execution: tasks.filter(task => ['todo', 'active', 'blocked'].includes(task.status)).length,
    review: tasks.filter(task => task.status === 'review').length,
    closed: tasks.filter(task => task.status === 'closed').length,
    overdue: tasks.filter(task => task.status !== 'closed' && task.due && task.due < referenceDate).length,
    blocked: tasks.filter(task => task.status === 'blocked').length };
}
export function csvCell(value) {
  let result = String(value ?? '');
  if (/^[\s\u0000-\u001f]*[=+@-]/u.test(result) || /^[\t\r\n]/u.test(result)) result = `'${result}`;
  return `"${result.replaceAll('"', '""')}"`;
}
export function seedState() {
  const day = today();
  const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1);
  const at = new Date().toISOString();
  let state = { schemaVersion: SCHEMA_VERSION, sites: [
    { id: 'site-alpha', code: 'DEMO-01', name: 'Progetto Alfa', location: 'Sede dimostrativa', start: day, end: '' },
    { id: 'site-beta', code: 'DEMO-02', name: 'Progetto Beta', location: 'Sede dimostrativa', start: day, end: '' },
  ], tasks: [], reports: [] };
  const inputs = [
    { title: 'Controllare le protezioni della zona A', area: 'Zona A · Asset A-01', priority: 'high', due: today(yesterday), status: 'blocked' },
    { title: 'Verificare il fissaggio del supporto', area: 'Zona B · Asset B-01', priority: 'urgent', due: day, status: 'review' },
    { title: 'Preparare il passaggio al turno successivo', area: 'Zona A', priority: 'normal', due: day, status: 'todo' },
    { title: 'Completare il controllo visivo', area: 'Zona C', priority: 'normal', due: day, status: 'active' },
  ];
  for (const input of inputs) {
    state = createTask(state, { ...input, siteId: 'site-alpha', description: 'Esempio fittizio per provare il flusso operativo.', company: 'Impresa Alfa', assignee: 'worker', reviewer: 'reviewer', criteria: 'Controllo eseguito e risultato documentato.' }, 'lead', at);
    const taskId = state.tasks.at(-1).id;
    if (input.status !== 'todo') state = transition(state, taskId, 'start', 'worker', '', at);
    if (input.status === 'blocked') state = transition(state, taskId, 'block', 'worker', 'In attesa del materiale dimostrativo. Prossimo passo: confermare la disponibilità.', at);
    if (input.status === 'review') state = transition(state, taskId, 'submit', 'worker', 'Controllo completato; riferimento dimostrativo E-01.', at);
  }
  state = addDiaryEntry(state, 'site-alpha', day, { shift: 'day', taskId: '', plan: 'Controllare due aree e preparare il passaggio di consegne.', actual: 'Una verifica proposta. Una lavorazione in attesa di materiale.', blockers: 'Disponibilità del materiale da confermare.', next: 'Rivedere il piano prima del turno successivo.' }, 'lead', at);
  return state;
}
