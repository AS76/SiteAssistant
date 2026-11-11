import { randomUUID } from 'node:crypto';
import { RepositoryError, requireRole } from './repository.mjs';

export const MODULES = Object.freeze([
  'overview', 'tasks', 'deviations', 'diary', 'progress', 'bookings', 'wbs', 'impacts',
  'tools', 'certifications', 'hse', 'sites',
]);
const alwaysAllowed = new Set(['sites', 'overview']);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const invalid = () => { throw new RepositoryError(400, 'Invalid member module access.', 'ACCESS_INVALID'); };
const isAllowed = value => value !== false && value !== 0;

export async function moduleAllowed(db, siteId, user, module) {
  if (!user?.id || !MODULES.includes(module)) return false;
  const row = await db.get(`SELECT m.role, a.allowed FROM site_members m
    LEFT JOIN member_module_access a ON a.site_id = m.site_id AND a.user_id = m.user_id AND a.module = ?
    WHERE m.site_id = ? AND m.user_id = ?`, module, siteId.toLowerCase(), user.id);
  return Boolean(row && (row.role === 'owner' || alwaysAllowed.has(module) || isAllowed(row.allowed)));
}

export async function requireModule(db, siteId, user, module) {
  if (!await moduleAllowed(db, siteId, user, module)) {
    throw new RepositoryError(403, 'Module is not available.', 'MODULE_FORBIDDEN');
  }
}

export async function listModuleAccess(db, { siteId }, user) {
  if (typeof siteId !== 'string' || !uuid.test(siteId)) invalid();
  const site = siteId.toLowerCase();
  await requireRole(db, site, user);
  const members = await db.all(`SELECT u.id AS user_id, u.email, u.name, m.role FROM site_members m
    JOIN users u ON u.id = m.user_id WHERE m.site_id = ? ORDER BY u.id`, site);
  const rows = await db.all('SELECT user_id, module, allowed FROM member_module_access WHERE site_id = ?', site);
  return { members: members.map(member => ({ ...member, modules: Object.fromEntries(MODULES.map(module => {
    const row = rows.find(row => row.user_id === member.user_id && row.module === module);
    return [module, member.role === 'owner' || alwaysAllowed.has(module) || isAllowed(row?.allowed)];
  })) })) };
}

export async function saveModuleAccess(db, { siteId, memberId, module, allowed }, user) {
  if (typeof siteId !== 'string' || !uuid.test(siteId)) invalid();
  const site = siteId.toLowerCase();
  return db.transaction(async tx => {
    await requireRole(tx, site, user, ['owner']);
    // Share the site lock with role changes, so membership is stable during the upsert.
    await requireRole(tx, site, user, ['owner']);
    if (typeof memberId !== 'string' || !uuid.test(memberId) || !MODULES.includes(module) || typeof allowed !== 'boolean') invalid();
    const member = memberId.toLowerCase();
    const membership = await tx.get('SELECT role FROM site_members WHERE site_id = ? AND user_id = ?', site, member);
    if (!membership || (!allowed && (alwaysAllowed.has(module) || membership.role === 'owner'))) invalid();
    const now = new Date().toISOString();
    await tx.run(`INSERT INTO member_module_access (id, site_id, user_id, module, allowed, created_at, updated_at)
      VALUES (?, ?, ?, ?, ${allowed ? 'TRUE' : 'FALSE'}, ?, ?) ON CONFLICT (site_id, user_id, module)
      DO UPDATE SET allowed = excluded.allowed, updated_at = excluded.updated_at`,
    randomUUID(), site, member, module, now, now);
    return { site_id: site, user_id: member, module, allowed };
  });
}
