import { moduleAllowed, requireModule } from './module-access.mjs';
import { fail, invalid, requireUser, text, uuid, validateInput } from './place-asset-scope.mjs';
import { createReconciliation } from './reconciliation.mjs';
import { DEMO_ROLE, requireRole } from './repository.mjs';

const readers = ['owner', 'editor', 'verifier', 'viewer'];
const fields = new Map([['executor', ['person', 'team']], ['verifier', ['person']], ['company', ['company']]]);
const register = { person: 'registry_people', team: 'registry_teams', company: 'registry_companies' };
const iso = value => value instanceof Date ? value.toISOString() : value;
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

function evidenceInstant(value) {
  if (typeof value !== 'string' || !/(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function assignmentKinds(field) {
  const kinds = fields.get(field);
  if (!kinds) invalid('Unknown task assignment field.');
  return kinds;
}

async function authorize(db, site, user, roles) {
  await requireRole(db, site, user, roles);
  if (!await db.get('SELECT 1 FROM users WHERE id = ? AND disabled_at IS NULL AND NOT demo_sandbox', user.id)) {
    fail(403, 'FORBIDDEN', 'Task assignment reconciliation requires an active site account.');
  }
  await requireModule(db, site, user, 'tasks');
  await requireModule(db, site, user, 'registry');
}

async function lockSources(ctx, occurrences) {
  const { tx, site } = ctx;
  for (const id of [...new Set(occurrences.map(item => item.recordId))].sort()) {
    await tx.run('UPDATE tasks SET id = id WHERE site_id = ? AND id = ?', site, id);
  }
  ctx.at = new Date().toISOString();
}

async function confirmedAccount({ tx, site }, accountId, at) {
  if (!at) return null;
  const link = await tx.get(`SELECT l.person_id, l.valid_from
    FROM registry_account_links l WHERE l.site_id = ? AND l.account_id = ?
      AND l.valid_from <= ? AND (l.revoked_at IS NULL OR l.revoked_at > ?)
    ORDER BY l.valid_from DESC, l.id LIMIT 1`, site, accountId, at, at);
  return link ? { personId: link.person_id, validFrom: iso(link.valid_from) } : null;
}

async function accountEvidence(ctx, accountId, factAt) {
  if (!accountId) return null;
  const account = await ctx.tx.get(`SELECT u.name, CASE WHEN u.disabled_at IS NULL THEN m.role END AS role
    FROM users u LEFT JOIN accessible_site_members m ON m.user_id = u.id AND m.site_id = ?
    WHERE u.id = ?`, ctx.site, accountId);
  return {
    id: accountId, label: account?.name ?? null, siteRole: account?.role ?? null,
    atCreation: await confirmedAccount(ctx, accountId, evidenceInstant(factAt)),
    current: await confirmedAccount(ctx, accountId, ctx.at),
  };
}

async function latestAssignment({ tx, site }, task, field) {
  const row = await tx.get(`SELECT version, batch_id, snapshot, valid_from, valid_to, original_label,
      person_id, team_id, company_id, authority_role_id FROM task_assignment_links
    WHERE site_id = ? AND task_id = ? AND field = ? ORDER BY version DESC LIMIT 1`, site, task, field);
  return {
    version: row?.version ?? 0,
    link: row && !row.valid_to ? {
      batchId: row.batch_id, snapshot: JSON.parse(row.snapshot), validFrom: iso(row.valid_from), originalLabel: row.original_label,
      references: [row.person_id, row.team_id, row.company_id, row.authority_role_id],
    } : null,
  };
}

async function source(ctx, { recordId, field }) {
  assignmentKinds(field);
  const row = await ctx.tx.get(`SELECT title, executor, verifier, company, executor_id, verifier_id, status, created_at,
    acceptance_state, acceptance_document_id,
    (SELECT e.evidence_attachment_id FROM task_events e WHERE e.task_id = tasks.id
      AND e.to_status = 'closed' AND e.from_status <> 'closed' ORDER BY e.at DESC, e.id DESC LIMIT 1) AS closure_evidence
    FROM tasks WHERE site_id = ? AND id = ?`, ctx.site, recordId);
  if (!row) return null;
  const factAt = iso(row.created_at);
  return {
    recordId, field, title: row.title, original: row[field], factAt, status: row.status,
    evidence: { closure: row.status === 'closed' ? row.closure_evidence : null, acceptance: row.acceptance_document_id,
      acceptanceState: row.acceptance_state },
    accounts: {
      executor: await accountEvidence(ctx, row.executor_id, factAt),
      verifier: await accountEvidence(ctx, row.verifier_id, factAt),
    },
    ...await latestAssignment(ctx, recordId, field),
  };
}

const normalizeLabel = value => value.normalize('NFKC').toLowerCase();
const activeRole = `a.role = ? AND a.revoked_at IS NULL AND a.valid_from <= ? AND a.valid_to > ?`;

function targetQuery(ctx, field, kind) {
  if (kind === 'person') {
    return {
      sql: `SELECT r.id, r.name, r.revision, r.created_at, a.id AS authority_id, a.revision AS authority_revision,
        a.valid_from, a.valid_to FROM registry_people r JOIN registry_authority_roles a
        ON a.site_id = r.site_id AND a.person_id = r.id AND ${activeRole}
        WHERE r.site_id = ? AND r.archived_at IS NULL`,
      params: [field, ctx.at, ctx.at, ctx.site],
    };
  }
  return {
    sql: `SELECT r.id, r.name, r.revision, r.created_at FROM ${register[kind]} r WHERE r.site_id = ? AND r.archived_at IS NULL`,
    params: [ctx.site],
  };
}

function snapshot(row, kind, field) {
  const authority = kind === 'person' ? {
    id: row.authority_id, revision: row.authority_revision, role: field,
    validFrom: iso(row.valid_from), validTo: iso(row.valid_to),
  } : null;
  return { kind, id: row.id, name: row.name, revision: row.revision, role: field, authority, registeredAt: iso(row.created_at) };
}

async function findTarget(ctx, field, decision) {
  const { sql, params } = targetQuery(ctx, field, decision.kind);
  const authority = decision.kind === 'person' ? ' AND a.id = ?' : '';
  const row = await ctx.tx.get(sql + ' AND r.id = ?' + authority, ...params, decision.targetId,
    ...(authority ? [decision.authorityId] : []));
  return row ? snapshot(row, decision.kind, field) : null;
}

async function candidates(ctx, field, label, exact = true) {
  const kinds = assignmentKinds(field);
  if (exact && !label?.trim()) return { total: 0, records: [] };
  const key = normalizeLabel(label.trim());
  const value = exact ? key : '%' + key.replaceAll(/[!%_]/g, character => '!' + character) + '%';
  const predicate = exact ? ' AND r.search_name = ?' : " AND r.search_name LIKE ? ESCAPE '!'";
  const records = [];
  let total = 0;
  for (const kind of kinds) {
    const { sql, params } = targetQuery(ctx, field, kind);
    const count = await ctx.tx.get(`SELECT CAST(COUNT(*) AS INTEGER) AS total FROM (${sql + predicate}) eligible`, ...params, value);
    total += count.total;
    const rows = await ctx.tx.all(sql + predicate + ' ORDER BY r.search_name, r.id LIMIT 50', ...params, value);
    records.push(...rows.map(row => snapshot(row, kind, field)));
  }
  return { total, records };
}

export async function searchTaskAssignmentTargets(db, siteId, { field, q }, user) {
  requireUser(user);
  const site = uuid(siteId, 'siteId');
  await authorize(db, site, user, readers);
  const label = q ? text(q, 'q') : '';
  return candidates({ tx: db, site, at: new Date().toISOString() }, field, label, false);
}

function validateDecision(input, { field }) {
  const kinds = assignmentKinds(field);
  const keys = ['action', 'reason'];
  validateInput(input, input?.action === 'link'
    ? [...keys, 'kind', 'targetId', 'targetRevision', 'authorityId', 'authorityRevision'] : keys);
  const reason = text(input.reason, 'reason', { max: 2000 });
  if (input.action === 'unresolved') return { action: 'unresolved', reason };
  if (input.action !== 'link' || !kinds.includes(input.kind)) invalid('Choose an explicit assignment decision and target type.');
  const { kind, targetRevision, authorityRevision } = input;
  const targetId = uuid(input.targetId, 'targetId');
  if (!Number.isSafeInteger(targetRevision) || targetRevision < 1) invalid('Target revision is required.');
  if (kind === 'person') {
    const authorityId = uuid(input.authorityId, 'authorityId');
    if (!Number.isSafeInteger(authorityRevision) || authorityRevision < 1) invalid('Authority revision is required.');
    return { action: 'link', reason, kind, targetId, targetRevision, authorityId, authorityRevision };
  }
  if (Object.hasOwn(input, 'authorityId') || Object.hasOwn(input, 'authorityRevision')) invalid('Authority applies to a person only.');
  return { action: 'link', reason, kind, targetId, targetRevision };
}

async function prepare(ctx, decision, source) {
  if (decision.action === 'unresolved') return null;
  const target = await findTarget(ctx, source.field, decision);
  if (!target) {
    fail(404, 'TASK_ASSIGNMENT_TARGET_NOT_FOUND', 'An eligible active target was not found on this site.');
  }
  if (target.revision !== decision.targetRevision || target.authority?.revision !== decision.authorityRevision) {
    fail(409, 'TASK_ASSIGNMENT_TARGET_CHANGED', 'The selected assignment target or active role changed.');
  }
  return target;
}

function people(account, assignment) {
  return [account?.atCreation?.personId, account?.current?.personId,
    assignment?.kind === 'person' ? assignment.id : null].filter(Boolean);
}

async function equivalent(ctx, source, proposed) {
  const { recordId, accounts } = source;
  const current = async field => proposed.get(field) ?? (await latestAssignment(ctx, recordId, field)).link?.snapshot;
  const executor = people(accounts.executor, await current('executor'));
  const verifier = people(accounts.verifier, await current('verifier'));
  return Boolean(accounts.executor && accounts.executor.id === accounts.verifier?.id)
    || executor.some(id => verifier.includes(id));
}

async function validatePrepared(ctx, items) {
  const tasks = new Map();
  for (const { recordId, field, source, target } of items) {
    if (field === 'company' || !target) continue;
    if (!tasks.has(recordId)) tasks.set(recordId, { source, proposed: new Map() });
    tasks.get(recordId).proposed.set(field, target);
  }
  for (const { source, proposed } of tasks.values()) {
    if (await equivalent(ctx, source, proposed)) {
      fail(409, 'SEPARATE_PEOPLE_REQUIRED', 'Executor and verifier must identify different people.');
    }
  }
}

async function closeAssignment({ tx, site, at }, { recordId, field }, version, action) {
  await tx.run(`UPDATE task_assignment_links SET valid_to = ?, end_action = ?
    WHERE site_id = ? AND task_id = ? AND field = ? AND version = ? AND valid_to IS NULL`,
  at, action, site, recordId, field, version);
}

const references = target => ['person', 'team', 'company'].map(kind => target.kind === kind ? target.id : null)
  .concat(target.authority?.id ?? null);

async function apply(ctx, item, batchId, source, decision, target) {
  const { tx, site, at } = ctx;
  const { recordId, field } = item;
  if (!same(await findTarget(ctx, field, decision), target)) {
    return { status: 'conflicting', code: 'TASK_ASSIGNMENT_TARGET_CHANGED' };
  }
  if (field !== 'company' && await equivalent(ctx, source, new Map([[field, target]]))) {
    return { status: 'conflicting', code: 'SEPARATE_PEOPLE_REQUIRED' };
  }
  if (source.link && source.link.originalLabel === source.original && same(source.link.snapshot, target)
      && same(source.link.references, references(target))) return { status: 'matched' };
  if (source.link) await closeAssignment(ctx, item, source.version, 'superseded');
  const version = source.version + 1;
  await tx.run(`INSERT INTO task_assignment_links (site_id, task_id, field, version,
    person_id, team_id, company_id, authority_role_id, original_label, snapshot, valid_from, batch_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  site, recordId, field, version, ...references(target), source.original, JSON.stringify(target), at, batchId);
  return { status: 'applied', version, target, originalLabel: source.original, validFrom: at };
}

async function compensate(ctx, item, batchId, _reason, applied) {
  const { version, link } = await latestAssignment(ctx, item.recordId, item.field);
  if (version !== applied.version || link?.batchId !== batchId || link.validFrom !== applied.validFrom
      || link.originalLabel !== applied.originalLabel || !same(link.snapshot, applied.target)
      || !same(link.references, references(applied.target))) {
    return { status: 'conflicting', code: 'TASK_ASSIGNMENT_SUPERSEDED' };
  }
  await closeAssignment(ctx, item, version, 'compensated');
  return { status: 'compensated', validTo: ctx.at };
}

export const taskAssignmentReconciliation = createReconciliation('tasks', {
  authorize, lockSources, source, batchReaders: readers,
  candidates: (ctx, item) => candidates(ctx, item.field, item.original),
  validateDecision, prepare, validatePrepared, apply, compensate,
});

export async function withTaskAssignmentHistory(db, task, user, role) {
  if (role === DEMO_ROLE || !await moduleAllowed(db, task.site_id, user, 'registry')) return task;
  const rows = await db.all(`SELECT l.field, l.version, l.original_label, l.snapshot, l.valid_from, l.valid_to, l.end_action, l.batch_id,
      CASE WHEN l.valid_to IS NULL AND a.enabled AND COALESCE(p.archived_at, c.archived_at, t.archived_at) IS NULL
        THEN TRUE ELSE FALSE END AS current,
      COALESCE(p.archived_at, c.archived_at, t.archived_at) AS archived_at
    FROM task_assignment_links l
    LEFT JOIN reconciliation_adoptions a ON l.site_id = a.site_id AND l.module = a.module
    LEFT JOIN registry_people p ON l.site_id = p.site_id AND l.person_id = p.id
    LEFT JOIN registry_companies c ON l.site_id = c.site_id AND l.company_id = c.id
    LEFT JOIN registry_teams t ON l.site_id = t.site_id AND l.team_id = t.id
    WHERE l.site_id = ? AND l.task_id = ? ORDER BY l.field, l.version DESC`, task.site_id, task.id);
  return { ...task, ...(rows.length ? { assignment_history: rows.map(row => ({
    ...row, snapshot: JSON.parse(row.snapshot), current: Boolean(row.current),
  })) } : {}) };
}
