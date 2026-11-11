import { randomUUID } from 'node:crypto';
import { RepositoryError, requireRole, getSite } from './repository.mjs';

// Personnel fitness records: who is allowed on site, with which qualification, until when.
export const CERT_CATEGORIES = ['qualification', 'medical', 'training', 'other'];
export const CERT_STATUSES = ['expired', 'expiring', 'valid', 'no_expiry'];
const READ_ROLES = ['owner', 'editor', 'verifier'];
const WRITE_ROLES = ['owner', 'editor'];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// DATE columns must reach JavaScript as plain calendar strings, never driver-decoded Dates.
const CERT_COLUMNS = `id, site_id, employee_id, category, name, issuer, CAST(issued_on AS TEXT) AS issued_on,
  CAST(expires_on AS TEXT) AS expires_on, outcome, notes, created_at, updated_at`;
const fail = (status, message, code) => { throw new RepositoryError(status, message, code); };
const invalid = message => fail(400, message, 'CERT_INVALID');

function requireUser(user) {
  if (!user?.id) fail(401, 'Authentication required.', 'UNAUTHENTICATED');
}

function object(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('Expected a JSON object.');
}

function validId(value, field) {
  if (typeof value !== 'string' || !uuid.test(value)) invalid(`${field} must be a UUID.`);
  return value.toLowerCase();
}

function validName(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 120) {
    invalid('name must contain between 1 and 120 characters.');
  }
  return value.trim();
}

function validCategory(value) {
  if (!CERT_CATEGORIES.includes(value)) invalid(`category must be one of ${CERT_CATEGORIES.join(', ')}.`);
  return value;
}

function optionalText(value, field, max) {
  if (value == null) return null;
  if (typeof value !== 'string' || value.length > max) invalid(`${field} must be a string of at most ${max} characters.`);
  return value.trim() || null;
}

function optionalDate(value, field) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\d$/.test(value)
    || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) {
    invalid(`${field} must be a YYYY-MM-DD date.`);
  }
  return value;
}

function dayNumber(value) {
  return Math.floor(Date.parse(`${value}T00:00:00Z`) / 86400000);
}

// Status is derived, never stored: there is nothing to re-align every night.
export function certificationStatus(expiresOn, today, within = 30) {
  if (!expiresOn) return { status: 'no_expiry', days_left: null };
  const daysLeft = dayNumber(expiresOn) - dayNumber(today);
  return { status: daysLeft < 0 ? 'expired' : daysLeft <= within ? 'expiring' : 'valid', days_left: daysLeft };
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function withStatus(row, within, reference = today()) {
  return { ...row, ...certificationStatus(row.expires_on, reference, within) };
}

async function certRole(db, siteId, user, roles) {
  try {
    return await requireRole(db, siteId, user, roles);
  } catch (error) {
    if (error instanceof RepositoryError && error.status === 403) {
      fail(403, 'Insufficient site role for certifications.', 'CERT_FORBIDDEN');
    }
    if (error instanceof RepositoryError && error.status === 404) {
      fail(404, 'Certification site not found.', 'CERT_NOT_FOUND');
    }
    throw error;
  }
}

export async function listCertifications(db, { siteId, employeeId, status, category, within } = {}, user) {
  requireUser(user);
  const site = validId(siteId, 'site_id');
  if (status != null && status !== '' && !CERT_STATUSES.includes(status)) {
    invalid(`status must be one of ${CERT_STATUSES.join(', ')}.`);
  }
  if (category != null && category !== '' && !CERT_CATEGORIES.includes(category)) {
    invalid(`category must be one of ${CERT_CATEGORIES.join(', ')}.`);
  }
  const window = within == null || within === '' ? 30 : Number(within);
  if (!Number.isInteger(window) || window < 0 || window > 365) invalid('within must be an integer between 0 and 365.');
  await getSite(db, site);
  await certRole(db, site, user, READ_ROLES);
  const clauses = ['site_id = ?'];
  const values = [site];
  if (employeeId) { clauses.push('employee_id = ?'); values.push(validId(employeeId, 'employee_id')); }
  if (category) { clauses.push('category = ?'); values.push(category); }
  const rows = await db.all(`SELECT ${CERT_COLUMNS} FROM employee_certifications WHERE ${clauses.join(' AND ')}
    ORDER BY expires_on IS NULL, expires_on, name, id`, ...values);
  return rows.map(row => withStatus(row, window)).filter(row => !status || row.status === status);
}

export async function createCertification(db, input, user) {
  requireUser(user);
  object(input);
  if ((input.siteId ?? input.site_id) == null) invalid('siteId is required.');
  if ((input.employeeId ?? input.employee_id) == null) invalid('employeeId is required.');
  const siteId = validId(input.siteId ?? input.site_id, 'site_id');
  const employeeId = validId(input.employeeId ?? input.employee_id, 'employee_id');
  const name = validName(input.name);
  const category = validCategory(input.category ?? 'other');
  const issuer = optionalText(input.issuer, 'issuer', 200);
  const issuedOn = optionalDate(input.issuedOn ?? input.issued_on, 'issued_on');
  const expiresOn = optionalDate(input.expiresOn ?? input.expires_on, 'expires_on');
  const outcome = optionalText(input.outcome, 'outcome', 500);
  const notes = optionalText(input.notes, 'notes', 2000);
  if (issuedOn && expiresOn && expiresOn < issuedOn) invalid('expires_on must not precede issued_on.');
  await certRole(db, siteId, user, WRITE_ROLES);
  const employee = await db.get('SELECT id FROM employees WHERE id = ? AND site_id = ?', employeeId, siteId);
  if (!employee) invalid('employee_id must belong to the site.');
  const id = randomUUID();
  const at = new Date().toISOString();
  await db.run(`INSERT INTO employee_certifications
    (id, site_id, employee_id, category, name, issuer, issued_on, expires_on, outcome, notes, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  id, siteId, employeeId, category, name, issuer, issuedOn, expiresOn, outcome, notes, at, at);
  return withStatus(await db.get(`SELECT ${CERT_COLUMNS} FROM employee_certifications WHERE id = ?`, id), 30);
}

export async function updateCertification(db, id, input, user) {
  requireUser(user);
  object(input);
  const cert = await db.get(`SELECT ${CERT_COLUMNS} FROM employee_certifications WHERE id = ?`, validId(id, 'id'));
  if (!cert) fail(404, 'Certification not found.', 'CERT_NOT_FOUND');
  await certRole(db, cert.site_id, user, WRITE_ROLES);
  const next = { ...cert };
  if (input.name !== undefined) next.name = validName(input.name);
  if (input.category !== undefined) next.category = validCategory(input.category);
  if (input.issuer !== undefined) next.issuer = optionalText(input.issuer, 'issuer', 200);
  if (input.issuedOn !== undefined || input.issued_on !== undefined) next.issued_on = optionalDate(input.issuedOn ?? input.issued_on, 'issued_on');
  if (input.expiresOn !== undefined || input.expires_on !== undefined) next.expires_on = optionalDate(input.expiresOn ?? input.expires_on, 'expires_on');
  if (input.outcome !== undefined) next.outcome = optionalText(input.outcome, 'outcome', 500);
  if (input.notes !== undefined) next.notes = optionalText(input.notes, 'notes', 2000);
  if (next.issued_on && next.expires_on && next.expires_on < next.issued_on) invalid('expires_on must not precede issued_on.');
  await db.run(`UPDATE employee_certifications SET category = ?, name = ?, issuer = ?, issued_on = ?,
    expires_on = ?, outcome = ?, notes = ?, updated_at = ? WHERE id = ?`,
  next.category, next.name, next.issuer, next.issued_on, next.expires_on, next.outcome, next.notes,
  new Date().toISOString(), next.id);
  return withStatus(await db.get(`SELECT ${CERT_COLUMNS} FROM employee_certifications WHERE id = ?`, next.id), 30);
}

export async function deleteCertification(db, id, user) {
  requireUser(user);
  const cert = await db.get(`SELECT ${CERT_COLUMNS} FROM employee_certifications WHERE id = ?`, validId(id, 'id'));
  if (!cert) fail(404, 'Certification not found.', 'CERT_NOT_FOUND');
  await certRole(db, cert.site_id, user, WRITE_ROLES);
  await db.run('DELETE FROM employee_certifications WHERE id = ?', cert.id);
  return { id: cert.id };
}

// Counts for the view header: no per-employee fan-out in the client.
export async function certificationSummary(db, { siteId, within } = {}, user) {
  const rows = await listCertifications(db, { siteId, within }, user);
  const counts = { expired: 0, expiring: 0, valid: 0, no_expiry: 0 };
  for (const row of rows) counts[row.status] += 1;
  return { counts, total: rows.length };
}
