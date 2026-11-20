import { requireModule } from './module-access.mjs';
import { randomUUID } from 'node:crypto';
import { RepositoryError, getSite, requireRole } from './repository.mjs';
import { getSiteProgressItem } from './site-progress.mjs';

const fail = (status, message, code = 'VALIDATION_ERROR') => { throw new RepositoryError(status, message, code); };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const requireUser = user => { if (!user?.id) fail(401, 'Authentication required.', 'UNAUTHENTICATED'); };
function validId(value, field) {
  if (typeof value !== 'string' || !uuid.test(value)) fail(400, `${field} must be a UUID.`);
  return value.toLowerCase();
}
function nonempty(value, field) {
  if (typeof value !== 'string' || !value.trim()) fail(400, `${field} is required.`);
  return value.trim();
}
function numeric(value, field) {
  if (!(typeof value === 'number' || (typeof value === 'string' && /^[+-]?\d+(?:\.\d+)?$/.test(value))) || !Number.isFinite(Number(value))) {
    fail(400, `${field} must be a finite number.`);
  }
  return Number(value);
}
function entries(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) {
    fail(400, 'steps must be an array of 1 to 100 entries.');
  }
  return value;
}
async function getType(db, id) {
  const row = await db.get('SELECT * FROM progress_types WHERE id = ?', id);
  if (!row) fail(404, 'Progress type not found.', 'PROGRESS_TYPE_NOT_FOUND');
  return { ...row, steps: (await db.all('SELECT * FROM progress_type_steps WHERE progress_type_id = ? ORDER BY position', id))
    .map(step => ({ ...step, weight: Number(step.weight) })) };
}
// Site-row locking serializes type deletion, assignment and step writes on both drivers.
async function lockSite(tx, siteId, user, roles) {
  await requireRole(tx, siteId, user, roles);
  await requireModule(tx, siteId, user, 'progress');
  await tx.run('UPDATE sites SET id = id WHERE id = ?', siteId);
}
async function lockedItem(tx, itemId, user, roles) {
  const id = validId(itemId, 'item_id');
  const row = await tx.get('SELECT site_id FROM site_progress_items WHERE id = ?', id);
  if (!row) fail(404, 'Site progress item not found.', 'SITE_PROGRESS_ITEM_NOT_FOUND');
  await lockSite(tx, row.site_id, user, roles);
  const current = await tx.get('SELECT * FROM site_progress_items WHERE id = ?', id);
  if (!current) fail(404, 'Site progress item not found.', 'SITE_PROGRESS_ITEM_NOT_FOUND');
  return current;
}

export async function listProgressTypes(db, { siteId } = {}) {
  const site = validId(siteId, 'site_id');
  await getSite(db, site);
  // As with the other read repositories, site membership is enforced by the HTTP route.
  const rows = await db.all('SELECT * FROM progress_types WHERE site_id = ? ORDER BY code, id', site);
  const steps = await db.all(`SELECT s.* FROM progress_type_steps s JOIN progress_types t ON t.id = s.progress_type_id
    WHERE t.site_id = ? ORDER BY s.position`, site);
  return rows.map(row => ({ ...row, steps: steps.filter(step => step.progress_type_id === row.id)
    .map(step => ({ ...step, weight: Number(step.weight) })) }));
}

export async function createProgressType(db, input, user) {
  requireUser(user);
  const site = validId(input?.site_id, 'site_id');
  return db.transaction(async tx => {
    await lockSite(tx, site, user, ['owner']);
    const code = nonempty(input.code, 'code'), name = nonempty(input.name, 'name');
    const codes = new Set(), positions = new Set();
    const steps = entries(input.steps).map(step => {
      const code = nonempty(step?.code, 'step code'), weight = numeric(step?.weight, 'weight');
      const position = step?.position;
      if (!Number.isInteger(position) || position < -2147483648 || position > 2147483647) fail(400, 'position must be a SQL integer.');
      if (weight <= 0) fail(400, 'weight must be positive.');
      if (codes.has(code) || positions.has(position)) fail(400, 'Step codes and positions must be unique.');
      if (step.description != null && typeof step.description !== 'string') fail(400, 'description must be text or null.');
      codes.add(code); positions.add(position);
      return { code, weight, position, description: step.description ?? null };
    });
    if (await tx.get('SELECT id FROM progress_types WHERE site_id = ? AND code = ?', site, code)) {
      fail(409, 'Progress type code already exists in this site.', 'PROGRESS_TYPE_DUPLICATE');
    }
    // Weights are percentages of the item: they must add up to exactly 100.
    const totalWeight = steps.reduce((sum, step) => sum + step.weight, 0);
    if (Math.abs(totalWeight - 100) > 1e-9) {
      fail(400, `I pesi degli step devono sommare 100 (somma attuale: ${Number(totalWeight.toFixed(4))}).`, 'WEIGHTS_NOT_100');
    }
    const id = randomUUID();
    await tx.run('INSERT INTO progress_types (id, site_id, code, name, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      id, site, code, name, user.id, new Date().toISOString());
    for (const step of steps) await tx.run(`INSERT INTO progress_type_steps
      (id, progress_type_id, position, code, description, weight) VALUES (?, ?, ?, ?, ?, ?)`,
    randomUUID(), id, step.position, step.code, step.description, step.weight);
    return getType(tx, id);
  });
}

export async function assignProgressType(db, itemId, progressTypeId, user) {
  requireUser(user);
  return db.transaction(async tx => {
    const item = await lockedItem(tx, itemId, user, ['owner']);
    const typeId = progressTypeId === null ? null : validId(progressTypeId, 'progress_type_id');
    if (typeId !== null && (await getType(tx, typeId)).site_id !== item.site_id) {
      fail(400, 'Progress type must belong to the item site.', 'PROGRESS_TYPE_SITE_MISMATCH');
    }
    await tx.run('UPDATE site_progress_items SET progress_type_id = ? WHERE id = ?', typeId, item.id);
    return getSiteProgressItem(tx, item.id);
  });
}

export async function setStepProgress(db, itemId, steps, user) {
  requireUser(user);
  return db.transaction(async tx => {
    const item = await lockedItem(tx, itemId, user, ['editor', 'owner']);
    const values = entries(steps), seen = new Set();
    if (!item.progress_type_id) fail(400, 'Assign a progress type before writing steps.', 'PROGRESS_TYPE_NOT_ASSIGNED');
    const type = await getType(tx, item.progress_type_id);
    const validated = values.map(step => {
      const id = validId(step?.step_id, 'step_id'), percent = numeric(step?.percent, 'percent');
      if (!type.steps.some(candidate => candidate.id === id)) fail(400, 'Step is not in the assigned type.', 'STEP_NOT_IN_TYPE');
      if (percent < 0 || percent > 100) fail(400, 'percent must be between 0 and 100.');
      if (seen.has(id)) fail(400, 'Duplicate step_id.');
      seen.add(id);
      return { id, percent };
    });
    const at = new Date().toISOString();
    for (const step of validated) await tx.run(`INSERT INTO site_progress_item_steps
      (id, site_progress_item_id, progress_type_step_id, percent, updated_by, updated_at)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (site_progress_item_id, progress_type_step_id)
      DO UPDATE SET percent = excluded.percent, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    randomUUID(), item.id, step.id, step.percent, user.id, at);
    for (const step of validated) await tx.run(`INSERT INTO progress_entries
      (id, site_id, site_progress_item_id, progress_type_step_id, percent, recorded_at, recorded_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)`, randomUUID(), item.site_id, item.id, step.id, step.percent, at, user.id);
    return getSiteProgressItem(tx, item.id);
  });
}

export function effectiveProgress(row, aggregate) {
  // A type implies a computed value: no recorded state yet means zero, never the imported number.
  const computed = row.progress_type_id != null;
  return { progress_pct: computed ? (aggregate == null ? 0 : Number(aggregate))
    : row.progress_pct == null ? null : Number(row.progress_pct),
  progress_pct_source: computed ? 'computed' : 'imported' };
}

export async function deleteProgressType(db, inputId, user) {
  requireUser(user);
  const id = validId(inputId, 'progress_type_id');
  return db.transaction(async tx => {
    const type = await getType(tx, id);
    await lockSite(tx, type.site_id, user, ['owner']);
    await getType(tx, id);
    if (await tx.get('SELECT id FROM site_progress_items WHERE progress_type_id = ? LIMIT 1', id)) {
      fail(409, 'Progress type is assigned to an item.', 'PROGRESS_TYPE_IN_USE');
    }
    // Explicit deletion of an unused catalog type also removes its retained states.
    // Unassignment alone never deletes states.
    await tx.run(`DELETE FROM progress_entries WHERE progress_type_step_id IN
      (SELECT id FROM progress_type_steps WHERE progress_type_id = ?)`, id);
    await tx.run(`DELETE FROM site_progress_item_steps WHERE progress_type_step_id IN
      (SELECT id FROM progress_type_steps WHERE progress_type_id = ?)`, id);
    await tx.run('DELETE FROM progress_type_steps WHERE progress_type_id = ?', id);
    await tx.run('DELETE FROM progress_types WHERE id = ?', id);
    return { deleted: true };
  });
}
