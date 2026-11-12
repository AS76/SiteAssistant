import { randomUUID } from 'node:crypto';
import { RepositoryError, requireRole } from './repository.mjs';

const entityTypes = ['hse_event', 'certification', 'tool'];
const actions = ['create', 'update', 'delete'];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const metadata = new Set(['id', 'site_id', 'created_at', 'updated_at', 'deleted_at']);
const invalid = message => { throw new RepositoryError(400, message, 'AUDIT_INVALID'); };

function validId(value, field) {
  if (typeof value !== 'string' || !uuid.test(value)) invalid(`${field} must be a UUID.`);
  return value.toLowerCase();
}

// Internal append primitive: callers supply the same transaction as the domain write.
// Snapshots contain persisted columns only, never joined personnel or derived status.
export async function appendAuditEvent(tx, { entityType, action, before, after, actor, at = new Date().toISOString() }) {
  if (!entityTypes.includes(entityType) || !actions.includes(action)) invalid('Invalid audit event.');
  const snapshot = row => JSON.parse(JSON.stringify({ ...row, deleted_at: row.deleted_at ?? null }));
  const row = snapshot(action === 'delete' ? before : after);
  let changes;
  if (action === 'update') {
    const previous = snapshot(before);
    changes = Object.fromEntries(Object.entries(row)
      .filter(([key, value]) => !metadata.has(key) && value !== previous[key])
      .map(([key, value]) => [key, { from: previous[key], to: value }]));
  } else {
    changes = action === 'create'
      ? Object.fromEntries(Object.entries(row).filter(([, value]) => value !== null))
      : row;
  }
  await tx.run(`INSERT INTO audit_events (id, site_id, entity_type, entity_id, action, at, actor, changes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, randomUUID(), row.site_id, entityType, row.id, action,
  at, actor, JSON.stringify(changes));
}

async function filters(db, { siteId, entityType, entityId }, user) {
  if (!user?.id) throw new RepositoryError(401, 'Authentication required.', 'UNAUTHENTICATED');
  const site = validId(siteId, 'site_id');
  // Deliberately no module gate: audit access is a site permission.
  await requireRole(db, site, user, ['owner', 'verifier']);
  const clauses = ['site_id = ?'], values = [site];
  if (entityType != null && entityType !== '') {
    if (!entityTypes.includes(entityType)) invalid('Invalid entity_type.');
    clauses.push('entity_type = ?'); values.push(entityType);
  }
  if (entityId != null && entityId !== '') {
    clauses.push('entity_id = ?'); values.push(validId(entityId, 'entity_id'));
  }
  return { where: clauses.join(' AND '), values };
}

export async function listAuditEvents(db, input = {}, user) {
  const { where, values } = await filters(db, input, user);
  return await db.all(`SELECT * FROM audit_events WHERE ${where} ORDER BY at DESC, id DESC LIMIT ? OFFSET ?`,
    ...values, input.limit ?? 50, input.offset ?? 0);
}

export async function countAuditEvents(db, input = {}, user) {
  const { where, values } = await filters(db, input, user);
  return Number((await db.get(`SELECT COUNT(*) AS total FROM audit_events WHERE ${where}`, ...values)).total);
}
