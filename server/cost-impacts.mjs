import { moduleAllowed, requireModule } from './module-access.mjs';
import { randomUUID } from 'node:crypto';
import { RepositoryError, getSite, requireRole, WRITE_ROLES } from './repository.mjs';

const fail = (status, message, code) => { throw new RepositoryError(status, message, code); };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const transitions = { open: ['notification_sent', 'closed'], notification_sent: ['submitted'], submitted: ['closed'], closed: [] };
const results = ['settled', 'dropped', 'rejected'];
const statuses = Object.keys(transitions);

function validId(value, field) {
  if (typeof value !== 'string' || !uuid.test(value)) fail(400, `${field} must be a UUID.`, 'VALIDATION_ERROR');
  return value.toLowerCase();
}

function requireUser(user) {
  if (!user?.id) fail(401, 'Authentication required.', 'UNAUTHENTICATED');
}

function amount(value, field) {
  if (value == null) return null;
  // Decimal strings reach PostgreSQL NUMERIC without a lossy Number conversion.
  if ((typeof value === 'number' && Number.isFinite(value)) ||
      (typeof value === 'string' && /^[+-]?\d+(?:\.\d+)?$/.test(value) && Number.isFinite(Number(value)))) return value;
  fail(400, `${field} must be a finite number, decimal string or null.`, 'VALIDATION_ERROR');
}

export async function listCostImpacts(db, { siteId, status } = {}) {
  const site = validId(siteId, 'site_id'), clauses = ['site_id = ?'], values = [site];
  if (status != null) {
    if (!statuses.includes(status)) fail(400, 'Unknown cost impact status.', 'VALIDATION_ERROR');
    clauses.push('status = ?'); values.push(status);
  }
  await getSite(db, site);
  return db.all(`SELECT * FROM cost_impacts WHERE ${clauses.join(' AND ')} ORDER BY created_at, id`, ...values);
}

export async function getCostImpact(db, id, user) {
  const row = typeof id === 'string' && uuid.test(id)
    ? await db.get('SELECT * FROM cost_impacts WHERE id = ?', id.toLowerCase()) : null;
  if (!row) fail(404, 'Cost impact not found.', 'COST_IMPACT_NOT_FOUND');
  const showDeviations = !user || await moduleAllowed(db, row.site_id, user, 'deviations');
  return { ...row, deviations: showDeviations ? await db.all(`SELECT d.* FROM deviations d
    JOIN cost_impact_deviations link ON link.deviation_id = d.id
    WHERE link.cost_impact_id = ? ORDER BY d.id`, row.id) : [] };
}

export async function createCostImpact(db, input, user) {
  requireUser(user);
  const site = validId(input?.site_id, 'site_id');
  if (typeof input.title !== 'string' || !input.title.trim()) fail(400, 'title is required.', 'VALIDATION_ERROR');
  if ((input.status !== undefined && input.status !== 'open') || input.result != null || input.closed_at != null) {
    fail(400, 'New cost impacts must be open without a closure result or timestamp.', 'VALIDATION_ERROR');
  }
  if (!Array.isArray(input.deviation_ids) || !input.deviation_ids.length) {
    fail(400, 'At least one deviation_id is required.', 'VALIDATION_ERROR');
  }
  const deviationIds = [...new Set(input.deviation_ids.map(id => validId(id, 'deviation_id')))];
  const claim = amount(input.claim_amount, 'claim_amount'), settlement = amount(input.settlement_amount, 'settlement_amount');
  return db.transaction(async tx => {
    await requireRole(tx, site, user, WRITE_ROLES);
    await requireModule(tx, site, user, 'impacts');
    for (const id of deviationIds) {
      const deviation = await tx.get('SELECT site_id FROM deviations WHERE id = ?', id);
      if (!deviation) fail(404, 'Deviation not found.', 'DEVIATION_NOT_FOUND');
      if (deviation.site_id !== site) fail(409, 'All deviations must belong to the claim site.', 'COST_IMPACT_SITE_MISMATCH');
    }
    const id = randomUUID();
    await tx.run(`INSERT INTO cost_impacts
      (id, site_id, title, status, claim_amount, settlement_amount, created_by, created_at)
      VALUES (?, ?, ?, 'open', ?, ?, ?, ?)`, id, site, input.title.trim(), claim, settlement, user.id, new Date().toISOString());
    for (const deviationId of deviationIds) await tx.run(
      'INSERT INTO cost_impact_deviations (cost_impact_id, deviation_id) VALUES (?, ?)', id, deviationId);
    return getCostImpact(tx, id, user);
  });
}

export async function transitionCostImpact(db, id, input, user) {
  requireUser(user);
  return db.transaction(async tx => {
    const row = await getCostImpact(tx, id);
    await requireRole(tx, row.site_id, user, ['owner', 'verifier']);
    await requireModule(tx, row.site_id, user, 'impacts');
    const to = input?.to;
    if (!statuses.includes(to)) fail(400, 'Unknown cost impact status.', 'VALIDATION_ERROR');
    if (!transitions[row.status].includes(to)) fail(409, 'Cost impact transition is not allowed.', 'INVALID_TRANSITION');
    if (to === 'closed' ? !results.includes(input.result) : input.result != null) {
      fail(400, 'A valid result is required only when closing a cost impact.', 'VALIDATION_ERROR');
    }
    const claim = input.claim_amount === undefined ? row.claim_amount : amount(input.claim_amount, 'claim_amount');
    const settlement = input.settlement_amount === undefined ? row.settlement_amount : amount(input.settlement_amount, 'settlement_amount');
    // The status predicate prevents two concurrent transitions from overwriting each other.
    const updated = await tx.run(`UPDATE cost_impacts SET status = ?, result = ?, closed_at = ?,
      claim_amount = ?, settlement_amount = ? WHERE id = ? AND status = ?`,
    to, to === 'closed' ? input.result : null, to === 'closed' ? new Date().toISOString() : null,
    claim, settlement, row.id, row.status);
    if (updated.rowCount !== 1) fail(409, 'Cost impact changed concurrently.', 'COST_IMPACT_CONFLICT');
    return getCostImpact(tx, row.id, user);
  });
}
