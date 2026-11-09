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
