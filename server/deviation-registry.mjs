import { recordDeviationRegistryEvent } from './deviations.mjs';
import { moduleAllowed, requireModule } from './module-access.mjs';
import { fail, invalid, requireUser, text, uuid, validateInput } from './place-asset-scope.mjs';
import { createReconciliation } from './reconciliation.mjs';
import { requireRole } from './repository.mjs';

const readers = ['owner', 'editor', 'verifier', 'viewer'];
const fields = new Map([
  ['author', ['person']],
  ['assigned_to', ['person', 'team']],
  ['causing_company', ['company']],
  ['resolving_company', ['company']],
]);
const register = { person: 'registry_people', team: 'registry_teams', company: 'registry_companies' };
const kinds = field => {
  if (!fields.has(field)) invalid('Unknown deviation registry field.');
  return fields.get(field);
};
const iso = value => value instanceof Date ? value.toISOString() : value;
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

async function authorize(db, site, user, roles) {
  await requireRole(db, site, user, roles);
  if (!await db.get('SELECT 1 FROM users WHERE id = ? AND disabled_at IS NULL AND NOT demo_sandbox', user.id)) {
    fail(403, 'FORBIDDEN', 'Deviation reconciliation requires an active site account.');
  }
  await requireModule(db, site, user, 'deviations');
  await requireModule(db, site, user, 'registry');
}

const sourceProjection = `d.author, d.assigned_to, d.causing_company, d.resolving_company, d.attribution_state,
  d.source_system, d.source_export_date, d.source_id, d.source_entity_key_id,
  (SELECT k.identity_state FROM planning_import_keys k WHERE k.site_id = d.site_id
    AND k.family = 'deviations' AND k.target_id = d.id) AS import_identity_state,
  (SELECT r.revision FROM deviation_registry_source_revisions r WHERE r.site_id = d.site_id
    AND r.deviation_id = d.id AND r.field = 'author') AS author_revision,
  (SELECT r.revision FROM deviation_registry_source_revisions r WHERE r.site_id = d.site_id
    AND r.deviation_id = d.id AND r.field = 'assigned_to') AS assigned_to_revision,
  (SELECT CAST(MAX(e.id) AS TEXT) FROM deviation_events e WHERE e.deviation_id = d.id AND e.action = 'attribution') AS attribution_revision`;

function provenance(row, field) {
  if (kinds(field).includes('company')) {
    return { kind: 'attribution', attributionState: row.attribution_state, attributionRevision: row.attribution_revision };
  }
  // Tracked exports and trusted legacy ingestion keys can exist without a planning key.
  const identityState = row.import_identity_state
    ?? (row.source_id || row.source_entity_key_id ? 'resolved' : 'unresolved');
  return { kind: 'import', sourceSystem: row.source_system, exportDate: row.source_export_date, sourceId: row.source_id,
    entityKey: row.source_entity_key_id, identityState, revision: row[`${field}_revision`] ?? 0 };
}

const canLink = (original, evidence) => Boolean(original?.trim()
  && evidence.attributionState !== 'disputed'
  && (evidence.kind !== 'import' || (evidence.identityState != null && evidence.identityState !== 'unresolved')));

const fromLinks = `FROM deviation_registry_links l JOIN reconciliation_items i
    ON i.site_id = l.site_id AND i.module = l.module AND i.batch_id = l.batch_id
      AND i.record_id = l.deviation_id AND i.field = l.field
  LEFT JOIN registry_people p ON p.site_id = l.site_id AND p.id = l.person_id
  LEFT JOIN registry_teams t ON t.site_id = l.site_id AND t.id = l.team_id
  LEFT JOIN registry_companies c ON c.site_id = l.site_id AND c.id = l.company_id`;
const archivedAt = 'COALESCE(p.archived_at, t.archived_at, c.archived_at)';

function sameEvidence(row, field, link) {
  if (row[field] !== link.original_label) return false;
  const current = provenance(row, field);
  const saved = JSON.parse(link.source_snapshot).provenance;
  // Older receipts stored a null state even when their source ID or ingestion key was trusted.
  if (saved.identityState === null && row.import_identity_state === null && current.identityState === 'resolved') {
    saved.identityState = current.identityState;
  }
  return same(current, saved);
}

async function latestLink({ tx, site }, { recordId, field }) {
  return tx.get(`SELECT l.*, i.source_snapshot, ${archivedAt} AS archived_at ${fromLinks}
    WHERE l.site_id = ? AND l.deviation_id = ? AND l.field = ? ORDER BY l.version DESC LIMIT 1`, site, recordId, field);
}

async function source(ctx, { recordId, field }) {
  kinds(field);
  const row = await ctx.tx.get(`SELECT d.title, ${sourceProjection} FROM deviations d WHERE d.site_id = ? AND d.id = ?`,
    ctx.site, recordId);
  if (!row) return null;
  const link = await latestLink(ctx, { recordId, field });
  const open = Boolean(link && !link.valid_to);
  const evidence = provenance(row, field);
  return {
    recordId, field, title: row.title, original: row[field], provenance: evidence, linkable: canLink(row[field], evidence),
    version: link?.version ?? 0, open,
    link: open && !link.archived_at && sameEvidence(row, field, link) ? JSON.parse(link.snapshot) : null,
  };
}

const normalized = value => value.normalize('NFKC').toLowerCase();
const targetQuery = kind => `SELECT id, name, revision FROM ${register[kind]} WHERE site_id = ? AND archived_at IS NULL`;
const snapshot = (row, kind) => ({ kind, id: row.id, name: row.name, revision: row.revision });

async function candidates({ tx, site }, field, label, exact) {
  const key = normalized(label.trim());
  const records = [];
  let total = 0;
  if (exact && !key) return { total, records };
  const predicate = exact ? 'search_name = ?' : "search_name LIKE ? ESCAPE '!'";
  const query = exact ? key : '%' + key.replaceAll(/[!%_]/g, match => '!' + match) + '%';
  for (const kind of kinds(field)) {
    const sql = targetQuery(kind) + ' AND ' + predicate;
    const count = await tx.get(`SELECT CAST(COUNT(*) AS INTEGER) AS total FROM (${sql}) eligible`, site, query);
    total += count.total;
    const rows = await tx.all(sql + ' ORDER BY search_name, id LIMIT 50', site, query);
    records.push(...rows.map(row => snapshot(row, kind)));
  }
  return { total, records };
}

export async function searchDeviationRegistryTargets(db, siteId, { field, q }, user) {
  requireUser(user);
  const site = uuid(siteId, 'siteId');
  await authorize(db, site, user, readers);
  return candidates({ tx: db, site }, field, q ? text(q, 'q') : '', false);
}

function validateDecision(input, { field }) {
  const allowed = kinds(field);
  const keys = ['action', 'reason'];
  validateInput(input, input?.action === 'link' ? [...keys, 'kind', 'targetId', 'targetRevision'] : keys);
  const reason = text(input.reason, 'reason', { max: 2000 });
  if (input.action === 'unresolved') return { action: 'unresolved', reason };
  if (input.action !== 'link' || !allowed.includes(input.kind)) invalid('Choose an explicit decision and target type.');
  const targetId = uuid(input.targetId, 'targetId');
  if (!Number.isSafeInteger(input.targetRevision) || input.targetRevision < 1) invalid('Target revision is required.');
  return { action: 'link', reason, kind: input.kind, targetId, targetRevision: input.targetRevision };
}

async function findTarget({ tx, site }, { kind, targetId }) {
  const row = await tx.get(targetQuery(kind) + ' AND id = ?', site, targetId);
  return row ? snapshot(row, kind) : null;
}

async function prepare(ctx, decision, occurrence) {
  if (decision.action === 'unresolved') return null;
  if (!occurrence.linkable) {
    fail(409, 'DEVIATION_REGISTRY_UNRESOLVED', 'An empty occurrence, unresolved import identity or disputed attribution cannot be linked.');
  }
  const target = await findTarget(ctx, decision);
  if (!target) fail(404, 'DEVIATION_REGISTRY_TARGET_NOT_FOUND', 'An eligible active target was not found on this site.');
  if (target.revision !== decision.targetRevision) {
    fail(409, 'DEVIATION_REGISTRY_TARGET_CHANGED', 'The selected registry target has changed.');
  }
  return target;
}

async function validateApply(ctx, items) {
  for (const item of items) {
    if (!item.outcome && !same(await findTarget(ctx, item.decision), item.target)) {
      item.outcome = { status: 'conflicting', code: 'DEVIATION_REGISTRY_TARGET_CHANGED' };
    }
  }
}

async function closeLink({ tx, site, at }, { recordId, field }, version, action) {
  await tx.run(`UPDATE deviation_registry_links SET valid_to = ?, end_action = ?
    WHERE site_id = ? AND deviation_id = ? AND field = ? AND version = ? AND valid_to IS NULL`,
  at, action, site, recordId, field, version);
}

const references = target => ['person', 'team', 'company'].map(kind => kind === target.kind ? target.id : null);

async function apply(ctx, item, batchId, occurrence, _decision, target) {
  const { tx, site, at, user } = ctx;
  if (same(occurrence.link, target)) return { status: 'matched' };
  if (occurrence.open) await closeLink(ctx, item, occurrence.version, 'superseded');
  const version = occurrence.version + 1;
  await tx.run(`INSERT INTO deviation_registry_links (site_id, deviation_id, field, version,
    person_id, team_id, company_id, original_label, snapshot, valid_from, batch_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  site, item.recordId, item.field, version, ...references(target), occurrence.original, JSON.stringify(target), at, batchId);
  await recordDeviationRegistryEvent(tx, item, user, at, 'registry_link');
  return { status: 'applied', version, target, originalLabel: occurrence.original, validFrom: at };
}

async function compensate(ctx, item, batchId, _reason, applied) {
  const link = await latestLink(ctx, item);
  if (!link || link.valid_to || link.version !== applied.version || link.batch_id !== batchId
      || iso(link.valid_from) !== applied.validFrom || link.original_label !== applied.originalLabel
      || !same(JSON.parse(link.snapshot), applied.target)
      || !same([link.person_id, link.team_id, link.company_id], references(applied.target))) {
    return { status: 'conflicting', code: 'DEVIATION_REGISTRY_SUPERSEDED' };
  }
  await closeLink(ctx, item, link.version, 'compensated');
  await recordDeviationRegistryEvent(ctx.tx, item, ctx.user, ctx.at, 'registry_rollback');
  return { status: 'compensated', validTo: ctx.at };
}

export const deviationRegistryReconciliation = createReconciliation('deviations', {
  authorize, source, batchReaders: readers,
  candidates: (ctx, item) => candidates(ctx, item.field, item.original ?? '', true),
  validateDecision, prepare, validateApply, apply, compensate,
});

export async function withDeviationRegistryHistory(db, deviation, user, role) {
  if (!readers.includes(role) || !await moduleAllowed(db, deviation.site_id, user, 'registry')) return deviation;
  const rows = await db.all(`SELECT l.field, l.version, l.original_label, l.snapshot, l.valid_from, l.valid_to,
      l.end_action, l.batch_id, i.source_snapshot, ${archivedAt} AS archived_at, a.enabled, ${sourceProjection}
    ${fromLinks}
    JOIN deviations d ON d.site_id = l.site_id AND d.id = l.deviation_id
    JOIN reconciliation_adoptions a ON a.site_id = l.site_id AND a.module = l.module
    WHERE l.site_id = ? AND l.deviation_id = ? ORDER BY l.field, l.version DESC`, deviation.site_id, deviation.id);
  const registry_history = rows.map(row => ({
    field: row.field, version: row.version, original_label: row.original_label, snapshot: JSON.parse(row.snapshot),
    valid_from: iso(row.valid_from), valid_to: iso(row.valid_to), end_action: row.end_action,
    batch_id: row.batch_id, archived_at: iso(row.archived_at),
    current: Boolean(row.enabled && !row.valid_to && !row.archived_at && sameEvidence(row, row.field, row)),
  }));
  return { ...deviation, registry_history };
}
