import { randomUUID } from 'node:crypto';
import { RepositoryError, requireRole } from './repository.mjs';
import { requireModule } from './module-access.mjs';

// Record facts and measures only. There is no personnel or medical record relation.
export const HSE_TYPES = Object.freeze(['near_miss', 'accident', 'observation']);
export const HSE_SEVERITIES = Object.freeze(['low', 'medium', 'high']);
const READ_ROLES = ['owner', 'editor', 'verifier'];
const WRITE_ROLES = ['owner', 'editor'];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COLUMNS = `id, site_id, event_no, type, severity, CAST(occurred_on AS TEXT) AS occurred_on,
  location, persons_involved, measures, notes, deviation_id, created_at, updated_at`;
const fields = new Set(['siteId', 'site_id', 'eventNo', 'event_no', 'type', 'severity', 'occurredOn',
  'occurred_on', 'location', 'personsInvolved', 'persons_involved', 'measures', 'notes', 'deviationId', 'deviation_id']);
const fail = (status, message, code) => { throw new RepositoryError(status, message, code); };
const invalid = message => fail(400, message, 'HSE_INVALID');

function requireUser(user) {
  if (!user?.id) fail(401, 'Authentication required.', 'UNAUTHENTICATED');
}
function object(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid('Expected a JSON object.');
  if (Object.keys(input).some(key => !fields.has(key))) invalid('Unsupported HSE field. Record facts and measures only.');
}
function validId(value, field) {
  if (typeof value !== 'string' || !uuid.test(value)) invalid(`${field} must be a UUID.`);
  return value.toLowerCase();
}
function text(value, field, max) {
  if (value == null) return null;
  if (typeof value !== 'string' || value.length > max) invalid(`${field} must be a string of at most ${max} characters.`);
  return value.trim() || null;
}
function choice(value, values, field) {
  if (!values.includes(value)) invalid(`${field} must be one of ${values.join(', ')}.`);
  return value;
}
function date(value, field) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\d$/.test(value) || value.startsWith('0000')) {
    invalid(`${field} must be a YYYY-MM-DD date.`);
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    invalid(`${field} must be a YYYY-MM-DD date.`);
  }
  return value;
}
function persons(value) {
  if (value == null) return null;
  if (!Number.isInteger(value) || value < 0 || value > 2147483647) invalid('persons_involved must be an integer between 0 and 2147483647.');
  return value;
}
// Preserve explicit nulls and reject conflicting aliases instead of silently choosing a value.
function value(input, camel, snake) {
  if (Object.hasOwn(input, camel) && Object.hasOwn(input, snake) && input[camel] !== input[snake]) invalid(`Conflicting ${snake} values.`);
  return Object.hasOwn(input, camel) ? input[camel] : input[snake];
}
async function hseRole(db, siteId, user, roles) {
  try {
    await requireRole(db, siteId, user, roles);
  } catch (error) {
    if (error instanceof RepositoryError && error.status === 403) fail(403, 'Insufficient site role for HSE.', 'HSE_FORBIDDEN');
    if (error instanceof RepositoryError && error.status === 404) fail(404, 'HSE site not found.', 'HSE_NOT_FOUND');
    throw error;
  }
  await requireModule(db, siteId, user, 'hse');
}
function nextEvent(input, existing = {}) {
  const result = { ...existing };
  for (const [camel, snake, validate] of [
    ['eventNo', 'event_no', v => text(v, 'event_no', 120)],
    ['type', 'type', v => choice(v, HSE_TYPES, 'type')],
    ['severity', 'severity', v => choice(v, HSE_SEVERITIES, 'severity')],
    ['occurredOn', 'occurred_on', v => date(v, 'occurred_on')],
    ['location', 'location', v => text(v, 'location', 200)],
    ['personsInvolved', 'persons_involved', persons],
    ['measures', 'measures', v => text(v, 'measures', 2000)],
    ['notes', 'notes', v => text(v, 'notes', 2000)],
    ['deviationId', 'deviation_id', v => v == null ? null : validId(v, 'deviation_id')],
  ]) {
    if (!existing.id || Object.hasOwn(input, camel) || Object.hasOwn(input, snake)) result[snake] = validate(value(input, camel, snake));
  }
  return result;
}
async function checkDeviation(db, event) {
  if (event.deviation_id && !await db.get('SELECT id FROM deviations WHERE id = ? AND site_id = ?', event.deviation_id, event.site_id)) {
    invalid('deviation_id must belong to the site.');
  }
}
async function write(db, sql, ...values) {
  try { await db.run(sql, ...values); }
  catch (error) {
    if (db.isUniqueViolation(error)) invalid('event_no must be unique within the site.');
    throw error;
  }
}
async function findEvent(db, id) {
  const event = await db.get(`SELECT ${COLUMNS} FROM hse_events WHERE id = ?`, validId(id, 'id'));
  if (!event) fail(404, 'HSE event not found.', 'HSE_NOT_FOUND');
  return event;
}

export async function listHseEvents(db, { siteId, type, severity, from, to } = {}, user) {
  requireUser(user);
  const site = validId(siteId, 'site_id');
  await hseRole(db, site, user, READ_ROLES);
  const clauses = ['site_id = ?'], values = [site];
  for (const [field, filter, validate, operator] of [
    ['type', type, v => choice(v, HSE_TYPES, 'type'), '='],
    ['severity', severity, v => choice(v, HSE_SEVERITIES, 'severity'), '='],
    ['occurred_on', from, v => date(v, 'from'), '>='],
    ['occurred_on', to, v => date(v, 'to'), '<='],
  ]) {
    if (filter != null && filter !== '') { clauses.push(`${field} ${operator} ?`); values.push(validate(filter)); }
  }
  if (from && to && from > to) invalid('from must not follow to.');
  return await db.all(`SELECT ${COLUMNS} FROM hse_events WHERE ${clauses.join(' AND ')} ORDER BY occurred_on DESC, id`, ...values);
}

export async function createHseEvent(db, input, user) {
  requireUser(user);
  object(input);
  const siteId = validId(value(input, 'siteId', 'site_id'), 'site_id');
  await hseRole(db, siteId, user, WRITE_ROLES);
  const event = { ...nextEvent(input), site_id: siteId };
  await checkDeviation(db, event);
  const id = randomUUID(), at = new Date().toISOString();
  await write(db, `INSERT INTO hse_events (id, site_id, event_no, type, severity, occurred_on,
    location, persons_involved, measures, notes, deviation_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  id, siteId, event.event_no, event.type, event.severity, event.occurred_on, event.location,
  event.persons_involved, event.measures, event.notes, event.deviation_id, at, at);
  return await findEvent(db, id);
}

export async function updateHseEvent(db, id, input, user) {
  requireUser(user);
  object(input);
  const event = await findEvent(db, id);
  await hseRole(db, event.site_id, user, WRITE_ROLES);
  if ((Object.hasOwn(input, 'siteId') || Object.hasOwn(input, 'site_id'))
    && validId(value(input, 'siteId', 'site_id'), 'site_id') !== event.site_id) invalid('site_id cannot be changed.');
  const next = nextEvent(input, event);
  await checkDeviation(db, next);
  await write(db, `UPDATE hse_events SET event_no = ?, type = ?, severity = ?, occurred_on = ?, location = ?,
    persons_involved = ?, measures = ?, notes = ?, deviation_id = ?, updated_at = ? WHERE id = ?`,
  next.event_no, next.type, next.severity, next.occurred_on, next.location, next.persons_involved,
  next.measures, next.notes, next.deviation_id, new Date().toISOString(), next.id);
  return await findEvent(db, next.id);
}

export async function deleteHseEvent(db, id, user) {
  requireUser(user);
  const event = await findEvent(db, id);
  await hseRole(db, event.site_id, user, WRITE_ROLES);
  await db.run('DELETE FROM hse_events WHERE id = ?', event.id);
  return { id: event.id };
}

export async function hseSummary(db, { siteId } = {}, user) {
  const rows = await listHseEvents(db, { siteId }, user);
  const by_type = Object.fromEntries(HSE_TYPES.map(type => [type, 0]));
  const by_severity = Object.fromEntries(HSE_SEVERITIES.map(severity => [severity, 0]));
  for (const row of rows) { by_type[row.type] += 1; by_severity[row.severity] += 1; }
  return { by_type, by_severity, total: rows.length };
}
