import { moduleAllowed, requireModule } from './module-access.mjs';
import { appendAuditEvent } from './audit.mjs';
import { randomUUID } from 'node:crypto';
import { DEMO_ROLE, EDIT_ROLES, RepositoryError, requireRole, WRITE_ROLES } from './repository.mjs';
import { createReconciliation, reconciliationTransaction } from './reconciliation.mjs';
import { createReconciledCompany } from './site-registry.mjs';
import { text, validateInput } from './place-asset-scope.mjs';

const statuses = new Set(['available', 'in_use', 'maintenance', 'retired']);
const COLUMNS = 'id, site_id, name, code, company, status, location, notes, created_at, updated_at';
const SCOPED_COLUMNS = COLUMNS.split(', ').map(column => 't.' + column).join(', ');
const relationships = ['owner', 'custodian', 'supplier'];
const companyKey = value => value.normalize('NFKC').toLowerCase();
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail = (status, message, code) => { throw new RepositoryError(status, message, code); };
const invalid = message => fail(400, message, 'TOOL_INVALID');

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

function validStatus(value) {
  if (!statuses.has(value)) invalid('status must be available, in_use, maintenance or retired.');
  return value;
}

function optionalText(value, field) {
  if (value == null) return null;
  if (typeof value !== 'string' || value.length > 10000) invalid(`${field} must be a string of at most 10000 characters.`);
  return value.trim() || null;
}

async function toolRole(db, siteId, user, roles) {
  let role;
  try {
    role = await requireRole(db, siteId, user, roles);
  } catch (error) {
    if (error instanceof RepositoryError && error.status === 403) {
      fail(403, 'Insufficient site role for tools.', 'TOOL_FORBIDDEN');
    }
    if (error instanceof RepositoryError && error.status === 404) {
      fail(404, 'Tool site not found.', 'TOOL_NOT_FOUND');
    }
    throw error;
  }
  await requireModule(db, siteId, user, 'tools');
  return role;
}

export async function listTools(db, { siteId, company } = {}, user) {
  requireUser(user);
  const site = validId(siteId, 'site_id');
  const clauses = ['t.site_id = ?', 't.deleted_at IS NULL'], values = [site];
  if (company != null && company !== '') {
    if (typeof company !== 'string') invalid('company must be a string.');
    clauses.push('t.company = ?'); values.push(company);
  }
  const role = await toolRole(db, site, user);
  const canReadRegistry = role !== DEMO_ROLE && await moduleAllowed(db, site, user, 'registry');
  const scope = `${clauses.join(' AND ')} ORDER BY t.company IS NULL, t.company, t.name, t.id`;
  if (!canReadRegistry) return await db.all(`SELECT ${COLUMNS} FROM tools t WHERE ${scope}`, ...values);
  return await db.all(`SELECT ${SCOPED_COLUMNS},
      l.company_id, l.company_label, l.relationship AS company_relationship, c.archived_at AS company_archived_at
    FROM tools t LEFT JOIN reconciliation_adoptions a ON a.site_id = t.site_id AND a.module = 'tools' AND a.enabled
    LEFT JOIN tool_company_links l ON l.site_id = a.site_id AND l.tool_id = t.id
    LEFT JOIN registry_companies c ON c.site_id = l.site_id AND c.id = l.company_id WHERE ${scope}`, ...values);
}

async function lockToolSite(tx, site, user, roles) {
  await toolRole(tx, site, user, roles);
  await tx.run('UPDATE sites SET id = id WHERE id = ?', site);
  await toolRole(tx, site, user, roles);
}

function rejectLinkFields(input) {
  if (['companyId', 'company_id', 'companyRelationship', 'company_relationship'].some(field => Object.hasOwn(input, field))) {
    invalid('Use company reconciliation to change the registry link.');
  }
}

export async function createTool(db, input, user) {
  requireUser(user);
  object(input);
  rejectLinkFields(input);
  const site = validId(input.site_id ?? input.siteId, 'site_id');
  const name = validName(input.name);
  const status = input.status === undefined ? 'available' : validStatus(input.status);
  const code = optionalText(input.code, 'code');
  const company = optionalText(input.company, 'company');
  const location = optionalText(input.location, 'location');
  const notes = optionalText(input.notes, 'notes');
  return await reconciliationTransaction(db, async tx => {
    await lockToolSite(tx, site, user, EDIT_ROLES);
    const now = new Date().toISOString();
    const row = await tx.get(`INSERT INTO tools
      (id, site_id, name, code, company, status, location, notes, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING ${COLUMNS}`,
    randomUUID(), site, name, code, company, status, location, notes, now, now);
    await appendAuditEvent(tx, { entityType: 'tool', action: 'create', after: row, actor: user.id, at: now });
    return row;
  });
}

async function lockTool(tx, id, user, roles) {
  const scope = await tx.get('SELECT site_id FROM tools WHERE id = ? AND deleted_at IS NULL', id);
  if (!scope) fail(404, 'Tool not found.', 'TOOL_NOT_FOUND');
  await lockToolSite(tx, scope.site_id, user, roles);
  const row = await tx.get(`SELECT ${COLUMNS} FROM tools WHERE id = ? AND deleted_at IS NULL`, id);
  if (!row) fail(404, 'Tool not found.', 'TOOL_NOT_FOUND');
  return row;
}

async function bumpToolRevision(tx, site, id) {
  await tx.run(`INSERT INTO tool_reconciliation_revisions (site_id, tool_id, revision) VALUES (?, ?, 1)
    ON CONFLICT (site_id, tool_id) DO UPDATE SET revision = tool_reconciliation_revisions.revision + 1`, site, id);
}

export async function updateTool(db, id, input, user) {
  requireUser(user);
  const toolId = validId(id, 'id');
  object(input);
  rejectLinkFields(input);
  const keys = Object.getOwnPropertyNames(input);
  // Verifiers can record inspection notes on an existing tool.
  const roles = keys.length === 1 && keys[0] === 'notes' ? WRITE_ROLES : EDIT_ROLES;
  const fields = new Map([
    ['name', value => validName(value)],
    ['code', value => optionalText(value, 'code')],
    ['company', value => optionalText(value, 'company')],
    ['status', value => validStatus(value)],
    ['location', value => optionalText(value, 'location')],
    ['notes', value => optionalText(value, 'notes')],
  ]);
  return await reconciliationTransaction(db, async tx => {
    const row = await lockTool(tx, toolId, user, roles);
    const changes = [], values = [];
    for (const [field, validate] of fields) {
      if (!keys.includes(field)) continue;
      changes.push(`${field} = ?`); values.push(validate(input[field]));
    }
    if (!changes.length) {
      await appendAuditEvent(tx, { entityType: 'tool', action: 'update', before: row, after: row, actor: user.id });
      return row;
    }
    changes.push('updated_at = ?');
    values.push(new Date().toISOString(), toolId);
    const updated = await tx.get(`UPDATE tools SET ${changes.join(', ')} WHERE id = ? RETURNING ${COLUMNS}`, ...values);
    if (!updated) fail(404, 'Tool not found.', 'TOOL_NOT_FOUND');
    await bumpToolRevision(tx, row.site_id, toolId);
    let note;
    if (row.company !== updated.company) {
      const prior = await tx.get('DELETE FROM tool_company_links WHERE site_id = ? AND tool_id = ? RETURNING batch_id', row.site_id, toolId);
      if (prior) note = { action: 'company_label_changed', batchId: prior.batch_id };
    }
    await appendAuditEvent(tx, { entityType: 'tool', action: 'update', before: row, after: updated, actor: user.id, note });
    return updated;
  });
}

export async function deleteTool(db, id, user) {
  requireUser(user);
  const toolId = validId(id, 'id');
  return await reconciliationTransaction(db, async tx => {
    const row = await lockTool(tx, toolId, user, EDIT_ROLES);
    const at = new Date().toISOString();
    const result = await tx.run('UPDATE tools SET deleted_at = ? WHERE id = ?', at, toolId);
    if (!result.rowCount) fail(404, 'Tool not found.', 'TOOL_NOT_FOUND');
    await appendAuditEvent(tx, { entityType: 'tool', action: 'delete', before: row, actor: user.id, at });
    return { deleted: true, id: toolId };
  });
}

async function findCompany({ tx, site }, id) {
  return await tx.get(`SELECT id, name, revision FROM registry_companies
    WHERE site_id = ? AND id = ? AND archived_at IS NULL`, site, id);
}

async function toolCompanySource({ tx, site }, { recordId, field }) {
  if (field !== 'company') invalid('Unknown tool reconciliation field.');
  const row = await tx.get(`SELECT ${SCOPED_COLUMNS}, COALESCE(r.revision, 0) AS reconciliation_revision
    FROM tools t LEFT JOIN tool_reconciliation_revisions r ON r.site_id = t.site_id AND r.tool_id = t.id
    WHERE t.site_id = ? AND t.id = ? AND t.deleted_at IS NULL`, site, recordId);
  if (!row) return null;
  const link = await tx.get(`SELECT company_id, company_label, relationship, linked_at, batch_id
    FROM tool_company_links WHERE site_id = ? AND tool_id = ?`, site, recordId);
  return { ...row, link: link ?? null };
}

async function companySuggestions({ tx, site }, label) {
  if (!label) return { total: 0, records: [] };
  const key = companyKey(label);
  const { total } = await tx.get(`SELECT CAST(count(*) AS INTEGER) AS total FROM registry_companies
    WHERE site_id = ? AND search_name = ? AND archived_at IS NULL`, site, key);
  const records = await tx.all(`SELECT id, name, revision, created_at FROM registry_companies
    WHERE site_id = ? AND search_name = ? AND archived_at IS NULL ORDER BY id LIMIT 50`, site, key);
  return { total, records };
}

function validateCompanyDecision(input) {
  object(input);
  const { action } = input;
  if (!['link', 'create', 'unresolved'].includes(action)) invalid('Choose an explicit company decision.');
  const common = ['action', 'reason'];
  const reason = text(input.reason, 'reason', { max: 2000 });
  if (action === 'unresolved') {
    validateInput(input, common);
    return { action, reason };
  }
  const { relationship } = input;
  if (!relationships.includes(relationship)) invalid('Choose what the company relationship represents.');
  if (action === 'create') {
    validateInput(input, [...common, 'relationship', 'name']);
    return { action, reason, relationship, name: text(input.name, 'name') };
  }
  validateInput(input, [...common, 'relationship', 'companyId', 'companyRevision']);
  const companyId = validId(input.companyId, 'companyId');
  if (!Number.isSafeInteger(input.companyRevision) || input.companyRevision < 1) invalid('Company revision is required.');
  return { action, reason, relationship, companyId, companyRevision: input.companyRevision };
}

async function prepareCompany(ctx, decision) {
  if (decision.action === 'unresolved') return null;
  if (decision.action === 'create') {
    if ((await companySuggestions(ctx, decision.name)).total) {
      fail(409, 'Choose a specific company or record why the occurrence is unresolved.', 'TOOL_COMPANY_AMBIGUOUS');
    }
    return { name: decision.name, relationship: decision.relationship };
  }
  const company = await findCompany(ctx, decision.companyId);
  if (!company) fail(404, 'Active company not found on this site.', 'TOOL_COMPANY_NOT_FOUND');
  if (company.revision !== decision.companyRevision) fail(409, 'The selected company changed.', 'RECONCILIATION_STALE');
  return { ...company, relationship: decision.relationship };
}

async function applyCompany(ctx, { recordId }, batchId, source, decision, target) {
  const { tx, site, at, user } = ctx;
  let company;
  if (decision.action === 'create') {
    if ((await companySuggestions(ctx, target.name)).total) return { status: 'conflicting', code: 'TOOL_COMPANY_AMBIGUOUS' };
    company = await createReconciledCompany(ctx, { name: target.name, reason: decision.reason });
  } else {
    company = await findCompany(ctx, target.id);
    if (!company || company.revision !== target.revision) return { status: 'conflicting', code: 'TOOL_COMPANY_CHANGED' };
  }
  if (source.link?.company_id === company.id && source.link.relationship === target.relationship &&
      source.link.company_label === company.name) return { status: 'matched' };
  await tx.run(`INSERT INTO tool_company_links
    (site_id, tool_id, company_id, company_label, relationship, linked_at, batch_id)
    VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (site_id, tool_id) DO UPDATE SET
      company_id = excluded.company_id, company_label = excluded.company_label,
      relationship = excluded.relationship, linked_at = excluded.linked_at, batch_id = excluded.batch_id`,
  site, recordId, company.id, company.name, target.relationship, at, batchId);
  await bumpToolRevision(tx, site, recordId);
  const before = { id: recordId, site_id: site, company_id: source.link?.company_id ?? null,
    company_relationship: source.link?.relationship ?? null, company_label: source.link?.company_label ?? null };
  const after = { ...before, company_id: company.id, company_relationship: target.relationship, company_label: company.name };
  await appendAuditEvent(tx, { entityType: 'tool', action: 'update', before, after, actor: user.id, at,
    note: { action: 'company_link_applied', batchId } });
  return { status: 'applied', target: { id: company.id, name: company.name, revision: company.revision,
    relationship: target.relationship, validFrom: at } };
}

async function compensateCompany({ tx, site, at, user }, item, batchId, reason, applied) {
  const source = await toolCompanySource({ tx, site }, item);
  const link = source?.link;
  const linkedAt = link?.linked_at instanceof Date ? link.linked_at.toISOString() : link?.linked_at;
  const { target } = applied;
  if (link?.batch_id !== batchId || link.company_id !== target.id || link.company_label !== target.name ||
      link.relationship !== target.relationship || linkedAt !== target.validFrom) {
    return { status: 'conflicting', code: 'TOOL_LINK_SUPERSEDED' };
  }
  const { recordId } = item;
  await tx.run('DELETE FROM tool_company_links WHERE site_id = ? AND tool_id = ? AND batch_id = ?', site, recordId, batchId);
  await bumpToolRevision(tx, site, recordId);
  const before = { id: recordId, site_id: site, company_id: link.company_id, company_label: link.company_label,
    company_relationship: link.relationship };
  const after = { ...before, company_id: null, company_label: null, company_relationship: null };
  await appendAuditEvent(tx, { entityType: 'tool', action: 'update', before, after, actor: user.id, at,
    note: { action: 'company_link_compensated', batchId, reason } });
  return { status: 'compensated', validTo: at };
}

export const toolCompanyReconciliation = createReconciliation('tools', {
  async authorize(db, site, user, roles) {
    await toolRole(db, site, user, roles);
    await requireModule(db, site, user, 'registry');
  },
  source: toolCompanySource,
  candidates: (ctx, source) => companySuggestions(ctx, source.company),
  validateDecision: validateCompanyDecision,
  prepare: prepareCompany,
  apply: applyCompany,
  compensate: compensateCompany,
});
