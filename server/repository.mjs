import { randomUUID } from 'node:crypto';
import { operationalDate } from './operational-day.mjs';

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
  todo: { in_progress: 'start', blocked: 'block' },
  in_progress: { to_verify: 'submit', blocked: 'block' },
  to_verify: { closed: 'verify', blocked: 'block', in_progress: 'reject' },
  closed: { in_progress: 'reopen' },
};

function transitionAction(task, to) {
  if (task.status === 'blocked') {
    return ['todo', 'in_progress', 'to_verify'].includes(task.blocked_from)
      && to === task.blocked_from ? 'resume' : undefined;
  }
  return transitions[task.status]?.[to];
}

// Invalid UUID lookup parameters used to be simple misses with TEXT columns.
async function idLookup(read, missing) {
  try { return await read(); }
  catch (error) {
    if (error.code === '22P02') return missing;
    throw error;
  }
}

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

export async function listSites(db, user) {
  return await db.all(`SELECT * FROM sites ${user ? 'WHERE id IN (SELECT site_id FROM site_members WHERE user_id = ?)' : ''}
    ORDER BY created_at, id`, ...(user ? [user.id] : []));
}

export const WRITE_ROLES = ['owner', 'editor', 'verifier'];
export const ROLES = [...WRITE_ROLES, 'viewer'];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function requireRole(db, siteId, user, roles = ROLES) {
  await getSite(db, siteId);
  const member = await db.get('SELECT role FROM site_members WHERE site_id = ? AND user_id = ?', siteId, user.id);
  if (!member || !roles.includes(member.role)) fail(403, 'Insufficient site role.', 'FORBIDDEN');
  return member.role;
}

export async function listMembers(db, siteId, user) {
  await requireRole(db, siteId, user, ['owner']);
  return await db.all(`SELECT u.id, u.email, u.name, m.role FROM site_members m
    JOIN users u ON u.id = m.user_id WHERE m.site_id = ? ORDER BY u.id`, siteId);
}

export async function setMember(db, siteId, input, user) {
  object(input);
  return await db.transaction(async tx => {
    await requireRole(tx, siteId, user, ['owner']);
    if (typeof input.user_id !== 'string' || !uuid.test(input.user_id) || (input.role !== null && !ROLES.includes(input.role))) {
      fail(400, 'A user UUID and valid role (or null for removal) are required.', 'VALIDATION_ERROR');
    }
    const userId = input.user_id.toLowerCase();
    if (!await tx.get('SELECT id FROM users WHERE id = ?', userId)) fail(404, 'User not found.', 'USER_NOT_FOUND');
    // Prevent accidental self-removal by an administrator.
    if (userId === user.id && input.role !== 'owner') fail(400, 'An owner cannot downgrade themselves.', 'VALIDATION_ERROR');
    if (input.role === null) await tx.run('DELETE FROM site_members WHERE site_id = ? AND user_id = ?', siteId, userId);
    else await tx.run(`INSERT INTO site_members (site_id, user_id, role) VALUES (?, ?, ?)
      ON CONFLICT (site_id, user_id) DO UPDATE SET role = excluded.role`, siteId, userId, input.role);
    return { site_id: siteId, user_id: userId, role: input.role };
  });
}

export async function getSite(db, id) {
  const site = await idLookup(() => db.get('SELECT * FROM sites WHERE id = ?', id));
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

export async function listTasks(db, { siteId, status } = {}, user) {
  const site = text(siteId, 'siteId');
  const state = text(status, 'status');
  if (state && !STATUSES.includes(state)) fail(400, 'Unknown task status.', 'VALIDATION_ERROR');
  const clauses = [];
  const values = [];
  if (user) { clauses.push('site_id IN (SELECT site_id FROM site_members WHERE user_id = ?)'); values.push(user.id); }
  if (site) { clauses.push('site_id = ?'); values.push(site); }
  if (state) { clauses.push('status = ?'); values.push(state); }
  return await idLookup(() => db.all(`SELECT * FROM tasks ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
    ORDER BY created_at, id`, ...values), []);
}

export async function getTask(db, id) {
  const task = await idLookup(() => db.get('SELECT * FROM tasks WHERE id = ?', id));
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
  const actor = text(input.actor, 'actor') || executor;
  let executorId = input.executor_id ?? null;
  let verifierId = input.verifier_id ?? null;
  for (const value of [executorId, verifierId]) {
    if (value !== null && (typeof value !== 'string' || !uuid.test(value))) fail(400, 'Invalid user UUID.', 'VALIDATION_ERROR');
  }
  executorId = executorId?.toLowerCase() ?? null;
  verifierId = verifierId?.toLowerCase() ?? null;
  if (executorId && executorId === verifierId) fail(400, 'executor and verifier must differ.', 'SEPARATE_PEOPLE_REQUIRED');
  const id = randomUUID();
  const at = new Date().toISOString();
  const write = async tx => {
    await getSite(tx, siteId);
    for (const [userId, roles] of [[executorId, WRITE_ROLES], [verifierId, ['owner', 'verifier']]]) {
      if (userId) {
        const member = await tx.get(`SELECT m.role FROM site_members m JOIN users u ON u.id = m.user_id
          WHERE m.site_id = ? AND m.user_id = ? AND u.disabled_at IS NULL`, siteId, userId);
        if (!member || !roles.includes(member.role)) fail(400, 'Invalid task assignment for this site.', 'VALIDATION_ERROR');
      }
    }
    await tx.run(`
      INSERT INTO tasks (id, site_id, title, area, company, executor, verifier, priority,
        due_date, status, created_at, executor_id, verifier_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'todo', ?, ?, ?)
    `, id, siteId, title, area, company, executor, verifier, priority, due, at, executorId, verifierId);
    await tx.run(`INSERT INTO task_events
      (task_id, at, actor, from_status, to_status, note, reason, action)
      VALUES (?, ?, ?, 'todo', 'todo', '', '', 'create')`, id, at, actor);
    return await getTask(tx, id);
  };
  // Idempotent POST and seed already supply a transaction executor.
  return await (db.transaction ? db.transaction(write) : write(db));
}

export async function transitionTask(db, id, input, user) {
  object(input);
  return await db.transaction(async tx => {
    const task = await getTask(tx, id);
    const to = text(input.to, 'to', true);
    const actor = user ? user.name : text(input.actor, 'actor', true);
    const role = user ? await requireRole(tx, task.site_id, user, WRITE_ROLES) : null;
    const note = text(input.note, 'note');
    const reason = text(input.reason, 'reason');
    if (!STATUSES.includes(to)) fail(400, 'Unknown task status.', 'VALIDATION_ERROR');
    const action = transitionAction(task, to);
    if (!action) {
      fail(409, `Transition from ${task.status} to ${to} is not allowed.`, 'INVALID_TRANSITION');
    }
    if (user && ['verify', 'reject', 'reopen'].includes(action) && role !== 'owner' && user.id !== task.verifier_id) {
      fail(403, 'Only the designated verifier or a site owner can perform this transition.', 'FORBIDDEN');
    }
    if (['submit', 'verify', 'reject'].includes(action) && !note) {
      fail(400, 'A non-empty note is required.', 'NOTE_REQUIRED');
    }
    if ((to === 'blocked' || task.status === 'closed') && !reason) {
      fail(400, 'A non-empty reason is required.', 'REASON_REQUIRED');
    }
    if (!user && to === 'closed' && actor !== task.verifier) {
      fail(409, 'Only the designated verifier can close this task.', 'VERIFIER_REQUIRED');
    }
    if (user && ['verify', 'reject'].includes(action) && !task.submitted_by_id && !task.submitted_by) {
      fail(400, 'The submission has no recorded submitter.', 'SUBMITTER_REQUIRED');
    }
    const selfReview = user && task.submitted_by_id ? user.id === task.submitted_by_id : actor === task.submitted_by;
    if ((action === 'reject' || (user && action === 'verify')) && selfReview) {
      fail(409, 'The submitter cannot review their own submission.', 'INVALID_TRANSITION');
    }
    // Preserve the legacy internal-call contract; HTTP always supplies a session user.
    if (!user && action === 'reopen' && actor !== task.verifier && actor !== 'owner') {
      fail(409, 'Only the designated verifier or owner can reopen this task.', 'INVALID_TRANSITION');
    }

    const { rowCount } = await tx.run(
      `UPDATE tasks SET status = ?, blocked_from = ?, submitted_by = ?, submitted_by_id = ?
        WHERE id = ? AND status = ?`,
      to, action === 'block' ? task.status : null,
      action === 'submit' ? actor : task.submitted_by,
      action === 'submit' ? user?.id ?? null : task.submitted_by_id, id, task.status,
    );
    if (rowCount === 0) {
      const current = await getTask(tx, id);
      fail(409, `Transition from ${current.status} to ${to} is not allowed.`, 'INVALID_TRANSITION');
    }
    await tx.run(`
      INSERT INTO task_events (task_id, at, actor, from_status, to_status, note, reason, action)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, id, new Date().toISOString(), actor, task.status, to, note, reason, action);
    return await getTask(tx, id);
  });
}

export async function listDiary(db, { siteId } = {}, user) {
  const site = text(siteId, 'siteId');
  const clauses = [], values = [];
  if (site) { clauses.push('site_id = ?'); values.push(site); }
  if (user) { clauses.push('site_id IN (SELECT site_id FROM site_members WHERE user_id = ?)'); values.push(user.id); }
  return await idLookup(() => db.all(`SELECT * FROM diary ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
    ORDER BY operational_date, shift, created_at, id`, ...values), []);
}

export async function createDiary(db, input) {
  object(input);
  const siteId = text(input.siteId, 'siteId', true);
  const createdAt = new Date().toISOString();
  const timeZone = input.time_zone === undefined ? 'Europe/Rome' : text(input.time_zone, 'time_zone', true);
  const cutoff = input.day_cutoff_time === undefined ? '06:00' : text(input.day_cutoff_time, 'day_cutoff_time', true);
  let derivedDate;
  try { derivedDate = operationalDate(createdAt, { timeZone, cutoff }); }
  catch (error) {
    if (error instanceof RangeError) fail(400, error.message, 'VALIDATION_ERROR');
    throw error;
  }
  const entryDate = input.operational_date === undefined
    ? derivedDate : date(input.operational_date, 'operational_date', true);
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
      impediments, next_step, created_at, time_zone, day_cutoff_time)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, id, siteId, entryDate, shift, plan, actual, impediments, nextStep, createdAt, timeZone, cutoff),
  'A diary entry already exists for this site, date and shift.', 'DUPLICATE_DIARY');
  return await db.get('SELECT * FROM diary WHERE id = ?', id);
}
