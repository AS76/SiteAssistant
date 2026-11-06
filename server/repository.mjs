import { randomUUID } from 'node:crypto';

export class RepositoryError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const fail = (status, message, code) => {
  throw new RepositoryError(status, message, code);
};

export const STATUSES = ['todo', 'in_progress', 'to_verify', 'closed', 'blocked'];
const transitions = {
  todo: ['in_progress', 'blocked'],
  in_progress: ['to_verify', 'blocked'],
  to_verify: ['closed', 'blocked'],
  closed: ['in_progress'],
  blocked: [],
};

function object(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    fail(400, 'Expected a JSON object.', 'VALIDATION_ERROR');
  }
}

function text(value, field, required = false) {
  if (value === undefined || value === null) value = '';
  if (typeof value !== 'string' || value.length > 10000) {
    fail(400, `${field} must be a string of at most 10000 characters.`, 'VALIDATION_ERROR');
  }
  const result = value.trim();
  if (required && !result) fail(400, `${field} is required.`, 'VALIDATION_ERROR');
  return result;
}

function date(value, field, required = false) {
  const result = text(value, field, required);
  if (!result) return null;
  const parsed = new Date(`${result}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result) ||
      !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== result) {
    fail(400, `${field} must be a valid YYYY-MM-DD date.`, 'VALIDATION_ERROR');
  }
  return result;
}

async function uniqueWrite(db, write, message, code) {
  try {
    return await write();
  } catch (error) {
    if (db.isUniqueViolation(error)) fail(409, message, code);
    throw error;
  }
}

export async function listSites(db) {
  return await db.all('SELECT * FROM sites ORDER BY created_at, id');
}

export async function getSite(db, id) {
  const site = await db.get('SELECT * FROM sites WHERE id = ?', id);
  if (!site) fail(404, 'Site not found.', 'SITE_NOT_FOUND');
  return site;
}

export async function createSite(db, input) {
  object(input);
  const code = text(input.code, 'code', true);
  const name = text(input.name, 'name', true);
  const location = text(input.location, 'location');
  const start = date(input.start_date, 'start_date');
  const end = date(input.end_date, 'end_date');
  if (start && end && end < start) {
    fail(400, 'end_date must not precede start_date.', 'VALIDATION_ERROR');
  }
  const id = randomUUID();
  await uniqueWrite(db, () => db.run(`
    INSERT INTO sites (id, code, name, location, start_date, end_date, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `, id, code, name, location, start, end, new Date().toISOString()),
  'Site code already exists.', 'DUPLICATE_SITE_CODE');
  return await getSite(db, id);
}

export async function listTasks(db, { siteId, status } = {}) {
  const site = text(siteId, 'siteId');
  const state = text(status, 'status');
  if (state && !STATUSES.includes(state)) fail(400, 'Unknown task status.', 'VALIDATION_ERROR');
  const clauses = [];
  const values = [];
  if (site) { clauses.push('site_id = ?'); values.push(site); }
  if (state) { clauses.push('status = ?'); values.push(state); }
  return await db.all(`SELECT * FROM tasks ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
    ORDER BY created_at, id`, ...values);
}

export async function getTask(db, id) {
  const task = await db.get('SELECT * FROM tasks WHERE id = ?', id);
  if (!task) fail(404, 'Task not found.', 'TASK_NOT_FOUND');
  const events = await db.all('SELECT * FROM task_events WHERE task_id = ? ORDER BY at, id', id);
  return { ...task, events };
}

export async function createTask(db, input) {
  object(input);
  const siteId = text(input.siteId, 'siteId', true);
  const title = text(input.title, 'title', true);
  const executor = text(input.executor, 'executor', true);
  const verifier = text(input.verifier, 'verifier', true);
  if (executor === verifier) {
    fail(400, 'executor and verifier must differ.', 'SEPARATE_PEOPLE_REQUIRED');
  }
  const area = text(input.area, 'area');
  const company = text(input.company, 'company');
  const priority = text(input.priority, 'priority') || 'normal';
  const due = date(input.due_date, 'due_date');
  await getSite(db, siteId);
  const id = randomUUID();
  await db.run(`
    INSERT INTO tasks (id, site_id, title, area, company, executor, verifier, priority,
      due_date, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'todo', ?)
  `, id, siteId, title, area, company, executor, verifier, priority, due, new Date().toISOString());
  return await getTask(db, id);
}

export async function transitionTask(db, id, input) {
  object(input);
  return await db.transaction(async tx => {
    const task = await getTask(tx, id);
    const to = text(input.to, 'to', true);
    const actor = text(input.actor, 'actor', true);
    const note = text(input.note, 'note');
    const reason = text(input.reason, 'reason');
    if (!STATUSES.includes(to)) fail(400, 'Unknown task status.', 'VALIDATION_ERROR');
    if (!transitions[task.status].includes(to)) {
      fail(409, `Transition from ${task.status} to ${to} is not allowed.`, 'INVALID_TRANSITION');
    }
    if ((to === 'to_verify' || to === 'closed') && !note) {
      fail(400, 'A non-empty note is required.', 'NOTE_REQUIRED');
    }
    if ((to === 'blocked' || task.status === 'closed') && !reason) {
      fail(400, 'A non-empty reason is required.', 'REASON_REQUIRED');
    }
    if (to === 'closed' && actor !== task.verifier) {
      fail(409, 'Only the designated verifier can close this task.', 'VERIFIER_REQUIRED');
    }

    const { rowCount } = await tx.run(
      'UPDATE tasks SET status = ? WHERE id = ? AND status = ?', to, id, task.status,
    );
    if (rowCount === 0) {
      const current = await getTask(tx, id);
      fail(409, `Transition from ${current.status} to ${to} is not allowed.`, 'INVALID_TRANSITION');
    }
    await tx.run(`
      INSERT INTO task_events (task_id, at, actor, from_status, to_status, note, reason)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, id, new Date().toISOString(), actor, task.status, to, note, reason);
    return await getTask(tx, id);
  });
}

export async function listDiary(db, { siteId } = {}) {
  const site = text(siteId, 'siteId');
  return await db.all(`SELECT * FROM diary ${site ? 'WHERE site_id = ?' : ''}
    ORDER BY operational_date, shift, created_at, id`, ...(site ? [site] : []));
}

export async function createDiary(db, input) {
  object(input);
  const siteId = text(input.siteId, 'siteId', true);
  const operationalDate = date(input.operational_date, 'operational_date', true);
  const shift = text(input.shift, 'shift', true);
  if (!['day', 'night'].includes(shift)) fail(400, 'shift must be day or night.', 'VALIDATION_ERROR');
  const plan = text(input.plan, 'plan');
  const actual = text(input.actual, 'actual');
  const impediments = text(input.impediments, 'impediments');
  const nextStep = text(input.next_step, 'next_step');
  await getSite(db, siteId);
  const id = randomUUID();
  await uniqueWrite(db, () => db.run(`
    INSERT INTO diary (id, site_id, operational_date, shift, plan, actual,
      impediments, next_step, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, id, siteId, operationalDate, shift, plan, actual, impediments, nextStep, new Date().toISOString()),
  'A diary entry already exists for this site, date and shift.', 'DUPLICATE_DIARY');
  return await db.get('SELECT * FROM diary WHERE id = ?', id);
}
