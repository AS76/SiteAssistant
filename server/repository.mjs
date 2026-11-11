import { createHash, randomUUID } from 'node:crypto';
import { operationalDate } from './operational-day.mjs';
import { ObjectStorageError, S3Storage } from './s3.mjs';

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
export const TASK_KINDS = ['ordinary', 'corrective'];
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

// Rows created before the classification existed read as ordinary work.
const publicTask = task => ({ ...task, kind: task.kind ?? 'ordinary' });

function taskFilters({ siteId, status, kind }, user) {
  const site = text(siteId, 'siteId');
  const state = text(status, 'status');
  const type = text(kind, 'kind');
  if (state && !STATUSES.includes(state)) fail(400, 'Unknown task status.', 'VALIDATION_ERROR');
  if (type && !TASK_KINDS.includes(type)) fail(400, 'Unknown task kind.', 'VALIDATION_ERROR');
  const clauses = [];
  const values = [];
  if (user) { clauses.push('site_id IN (SELECT site_id FROM site_members WHERE user_id = ?)'); values.push(user.id); }
  if (site) { clauses.push('site_id = ?'); values.push(site); }
  if (state) { clauses.push('status = ?'); values.push(state); }
  if (type) { clauses.push("COALESCE(kind, 'ordinary') = ?"); values.push(type); }
  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', values };
}

export async function listTasks(db, { limit = 50, offset = 0, ...filters } = {}, user) {
  const { where, values } = taskFilters(filters, user);
  return (await idLookup(() => db.all(`SELECT * FROM tasks ${where}
    ORDER BY created_at, id LIMIT ? OFFSET ?`, ...values, limit, offset), [])).map(publicTask);
}

export async function countTasks(db, filters = {}, user) {
  const { where, values } = taskFilters(filters, user);
  const row = await idLookup(() => db.get(`SELECT COUNT(*) AS total FROM tasks ${where}`, ...values), { total: 0 });
  return Number(row.total);
}

export async function getTask(db, id) {
  const task = await idLookup(() => db.get('SELECT * FROM tasks WHERE id = ?', id));
  if (!task) fail(404, 'Task not found.', 'TASK_NOT_FOUND');
  const events = await db.all('SELECT * FROM task_events WHERE task_id = ? ORDER BY at, id', id);
  return { ...publicTask(task), events };
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
  const kind = text(input.kind, 'kind');
  if (kind && !TASK_KINDS.includes(kind)) fail(400, 'kind must be ordinary or corrective.', 'VALIDATION_ERROR');
  // Ordinary work keeps the column empty: only the exception is stored.
  const storedKind = kind === 'corrective' ? 'corrective' : null;
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
    const row = [id, siteId, title, area, company, executor, verifier, priority];
    // The classification column is only written for corrective work, so ordinary inserts keep
    // working on a schema that predates it (upgrade tests and old snapshots).
    if (storedKind) {
      await tx.run(`INSERT INTO tasks (id, site_id, title, area, company, executor, verifier, priority, kind,
        due_date, status, created_at, executor_id, verifier_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'todo', ?, ?, ?)`,
        ...row, storedKind, due, at, executorId, verifierId);
    } else {
      await tx.run(`INSERT INTO tasks (id, site_id, title, area, company, executor, verifier, priority,
        due_date, status, created_at, executor_id, verifier_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'todo', ?, ?, ?)`,
        ...row, due, at, executorId, verifierId);
    }
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

function diaryFilters({ siteId }, user) {
  const site = text(siteId, 'siteId');
  const clauses = [], values = [];
  if (site) { clauses.push('site_id = ?'); values.push(site); }
  if (user) { clauses.push('site_id IN (SELECT site_id FROM site_members WHERE user_id = ?)'); values.push(user.id); }
  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', values };
}

export async function listDiary(db, { limit = 50, offset = 0, ...filters } = {}, user) {
  const { where, values } = diaryFilters(filters, user);
  return await idLookup(() => db.all(`SELECT * FROM diary ${where}
    ORDER BY operational_date, shift, created_at, id LIMIT ? OFFSET ?`, ...values, limit, offset), []);
}

export async function countDiary(db, filters = {}, user) {
  const { where, values } = diaryFilters(filters, user);
  const row = await idLookup(() => db.get(`SELECT COUNT(*) AS total FROM diary ${where}`, ...values), { total: 0 });
  return Number(row.total);
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

export const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;
const ATTACHMENT_ROLES = ['owner', 'editor'];
const attachmentTables = { task: 'tasks', diary: 'diary', site: 'sites' };

function attachmentUser(user) {
  if (!user?.id) fail(401, 'Authentication required.', 'UNAUTHENTICATED');
}

function attachmentId(value, field) {
  if (typeof value !== 'string' || !uuid.test(value)) fail(400, `${field} must be a UUID.`, 'VALIDATION_ERROR');
  return value.toLowerCase();
}

async function attachmentEntity(db, input, user, roles) {
  attachmentUser(user);
  if (typeof input.entity_type !== 'string' || !Object.hasOwn(attachmentTables, input.entity_type)) fail(400, 'Invalid entity_type.', 'VALIDATION_ERROR');
  const entityId = attachmentId(input.entity_id, 'entity_id');
  const entity = await db.get(`SELECT * FROM ${attachmentTables[input.entity_type]} WHERE id = ?`, entityId);
  if (!entity) fail(400, 'Attachment entity does not exist.', 'VALIDATION_ERROR');
  const siteId = input.entity_type === 'site' ? entity.id : entity.site_id;
  await requireRole(db, siteId, user, roles);
  // The POST contract derives site_id; an optional explicit scope must agree.
  if (input.site_id !== undefined && attachmentId(input.site_id, 'site_id') !== siteId) {
    fail(403, 'Attachment entity belongs to another site.', 'FORBIDDEN');
  }
  return { siteId, entityId };
}

function attachmentData(input) {
  const filename = text(input.filename, 'filename', true);
  if (!filename.isWellFormed() || Buffer.byteLength(filename) > 255 || /[\x00-\x1f\x7f/\\]/.test(filename) || ['.', '..'].includes(filename)) {
    fail(400, 'Invalid attachment filename.', 'VALIDATION_ERROR');
  }
  const mime = text(input.content_type, 'content_type', true).toLowerCase();
  if (mime !== 'application/pdf' && !/^image\/[a-z0-9][a-z0-9.+-]*$/.test(mime)) {
    fail(415, 'Only images and PDF are supported.', 'UNSUPPORTED_MEDIA_TYPE');
  }
  const encoded = input.data_base64;
  if (typeof encoded !== 'string' || !encoded.length) fail(400, 'data_base64 is required.', 'VALIDATION_ERROR');
  if (encoded.length > 4 * Math.ceil(MAX_ATTACHMENT_BYTES / 3)) fail(413, 'Attachment exceeds 15 MiB.', 'ATTACHMENT_TOO_LARGE');
  // A flat character check avoids recursion on multi-megabyte base64 input.
  if (encoded.length % 4 || /[^A-Za-z0-9+/=]/.test(encoded)) fail(400, 'Invalid base64.', 'VALIDATION_ERROR');
  const data = Buffer.from(encoded, 'base64');
  if (data.toString('base64') !== encoded) fail(400, 'Invalid base64.', 'VALIDATION_ERROR');
  if (data.length > MAX_ATTACHMENT_BYTES) fail(413, 'Attachment exceeds 15 MiB.', 'ATTACHMENT_TOO_LARGE');
  return { filename, mime, data };
}

function publicAttachment(row) {
  const { storage_locator, ...metadata } = row;
  return metadata;
}

async function attachmentRecord(db, id, user, roles) {
  attachmentUser(user);
  const row = await idLookup(() => db.get('SELECT * FROM attachments WHERE id = ?', id));
  if (!row) fail(404, 'Attachment not found.', 'ATTACHMENT_NOT_FOUND');
  await requireRole(db, row.site_id, user, roles);
  return row;
}

export async function createAttachment(db, input, user, storage = new S3Storage()) {
  object(input);
  const { siteId, entityId } = await attachmentEntity(db, input, user, ATTACHMENT_ROLES);
  const { filename, mime, data } = attachmentData(input);
  const id = randomUUID();
  const sha256 = createHash('sha256').update(data).digest('hex');
  const locator = `attachments/${siteId}/${id}/v1`;
  // Unique keys and conditional PUT prevent replacement of an existing object.
  await storage.put(locator, data, { mime, sha256 });
  try {
    const head = await storage.head(locator);
    if (head.sha256 !== sha256 || head.size !== data.length) {
      fail(502, 'Attachment readback checksum mismatch.', 'ATTACHMENT_CHECKSUM_MISMATCH');
    }
    // Metadata can echo a supplied checksum even if bytes are corrupted.
    // Verify actual stored bytes as well; never treat an ETag as SHA-256.
    const readback = await storage.get(locator);
    const digest = createHash('sha256');
    let size = 0;
    for await (const chunk of readback) {
      size += chunk.length;
      if (size > data.length) fail(502, 'Attachment readback size mismatch.', 'ATTACHMENT_CHECKSUM_MISMATCH');
      digest.update(chunk);
    }
    if (size !== data.length || digest.digest('hex') !== sha256) {
      fail(502, 'Attachment readback checksum mismatch.', 'ATTACHMENT_CHECKSUM_MISMATCH');
    }
    return await db.transaction(async tx => {
      // Recheck scope and membership after the storage round trip.
      const current = await attachmentEntity(tx, input, user, ATTACHMENT_ROLES);
      if (current.siteId !== siteId) fail(403, 'Attachment entity changed site.', 'FORBIDDEN');
      await tx.run(`INSERT INTO attachments (id, site_id, entity_type, entity_id, filename, mime, size,
        content_sha256, storage_locator, manifest_version, uploaded_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'v1', ?, ?)`,
      id, siteId, input.entity_type, entityId, filename, mime, data.length, sha256, locator, user.id, new Date().toISOString());
      return publicAttachment(await tx.get('SELECT * FROM attachments WHERE id = ?', id));
    });
  } catch (error) {
    try { await storage.delete(locator); }
    catch { throw new ObjectStorageError('ATTACHMENT_CLEANUP_FAILED'); }
    throw error;
  }
}

export async function listAttachments(db, input, user) {
  object(input);
  attachmentUser(user);
  const siteId = attachmentId(input.site_id, 'site_id');
  await requireRole(db, siteId, user);
  const clauses = ['site_id = ?'], values = [siteId];
  if (input.entity_type !== undefined) {
    if (typeof input.entity_type !== 'string' || !Object.hasOwn(attachmentTables, input.entity_type)) fail(400, 'Invalid entity_type.', 'VALIDATION_ERROR');
    clauses.push('entity_type = ?'); values.push(input.entity_type);
  }
  if (input.entity_id !== undefined) {
    await attachmentEntity(db, input, user);
    clauses.push('entity_id = ?'); values.push(attachmentId(input.entity_id, 'entity_id'));
  }
  return (await db.all(`SELECT * FROM attachments WHERE ${clauses.join(' AND ')} ORDER BY created_at, id`, ...values)).map(publicAttachment);
}

export async function getAttachment(db, id, user, storage = new S3Storage()) {
  const row = await attachmentRecord(db, id, user);
  return { ...publicAttachment(row), stream: await storage.get(row.storage_locator) };
}

export async function deleteAttachment(db, id, user, storage = new S3Storage()) {
  await db.transaction(async tx => {
    const row = await attachmentRecord(tx, id, user, ATTACHMENT_ROLES);
    await tx.run('DELETE FROM attachments WHERE id = ?', row.id);
    // A storage failure rolls SQL back, preserving metadata for a retry.
    await storage.delete(row.storage_locator);
  });
}
