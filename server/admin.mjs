import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { closeDb, openDb } from './db.mjs';
import { demoteDemoOwners } from './demo-sandbox.mjs';
import { DEMO_ROLE, RepositoryError } from './repository.mjs';
import { normalizeEmail } from './signup.mjs';

export const INVITATION_PERMISSION = 'invitations.manage';

export async function canManageInvitations(db, userId) {
  return Boolean(await db.get(`SELECT p.user_id FROM user_permissions p JOIN users u ON u.id = p.user_id
    WHERE p.user_id = ? AND p.permission = ? AND p.revoked_at IS NULL AND NOT u.demo_sandbox`, userId, INVITATION_PERMISSION));
}

export async function changePermission(db, action, permission, address) {
  if (!['grant', 'revoke'].includes(action) || permission !== INVITATION_PERMISSION) {
    throw new RepositoryError(400, 'Usage: npm run admin -- grant|revoke invitations.manage <email>', 'INVALID_COMMAND');
  }
  const email = normalizeEmail(address);
  const state = await db.transaction(async tx => {
    // Serialize grants and revocations for this user, including when no grant exists.
    const user = await tx.get('UPDATE users SET id = id WHERE lower(email) = ? RETURNING id, demo_sandbox', email);
    const at = new Date().toISOString();
    // A NULL grantor/audit actor identifies the trusted server CLI.
    if (!user) {
      await tx.run(`INSERT INTO auth_events (id, event, outcome, detail_json, created_at)
        VALUES (?, ?, 'failure', ?, ?)`, randomUUID(), `permission_${action}`,
      JSON.stringify({ permission, source: 'cli', code: 'USER_NOT_FOUND' }), at);
      return null;
    }
    if (action === 'grant' && user.demo_sandbox) {
      throw new RepositoryError(403, 'Demo accounts cannot manage invitations.', 'FORBIDDEN');
    }
    const result = action === 'grant'
      ? await tx.run(`INSERT INTO user_permissions (user_id, permission, granted_at) VALUES (?, ?, ?)
        ON CONFLICT (user_id, permission) WHERE revoked_at IS NULL DO NOTHING`, user.id, permission, at)
      : await tx.run(`UPDATE user_permissions SET revoked_at = ?
        WHERE user_id = ? AND permission = ? AND revoked_at IS NULL`, at, user.id, permission);
    const state = { user_id: user.id, permission, active: action === 'grant', changed: Boolean(result.rowCount) };
    await tx.run(`INSERT INTO auth_events (id, event, outcome, detail_json, created_at)
      VALUES (?, ?, 'success', ?, ?)`, randomUUID(), `permission_${action}`, JSON.stringify({ ...state, source: 'cli' }), at);
    return state;
  });
  if (!state) throw new RepositoryError(404, 'User not found.', 'USER_NOT_FOUND');
  return state;
}

export async function markDemoSite(db, code) {
  const site = await db.get('UPDATE sites SET demo_sandbox = TRUE WHERE code = ? RETURNING id', code);
  if (!site) throw new RepositoryError(404, 'Site code does not exist.', 'SITE_NOT_FOUND');
  return { site_id: site.id, demo_sandbox: true };
}

export async function assignDemoUser(db, address, siteCode) {
  const email = normalizeEmail(address);
  return db.transaction(async tx => {
    const user = await tx.get('UPDATE users SET demo_sandbox = TRUE WHERE lower(email) = ? RETURNING id', email);
    if (!user) throw new RepositoryError(404, 'User not found.', 'USER_NOT_FOUND');
    if (siteCode !== undefined) {
      const site = await tx.get('SELECT id FROM sites WHERE code = ? AND demo_sandbox', siteCode);
      if (!site) throw new RepositoryError(400, 'The demo_user role requires a sandbox site.', 'DEMO_SCOPE_INVALID');
      await tx.run(`INSERT INTO site_members (site_id, user_id, role) VALUES (?, ?, ?)
        ON CONFLICT (site_id, user_id) DO UPDATE SET role = excluded.role`, site.id, user.id, DEMO_ROLE);
    } else if (!await tx.get(`SELECT s.id FROM sites s JOIN site_members m ON m.site_id = s.id
      WHERE m.user_id = ? AND s.demo_sandbox AND m.role IN ('owner', 'demo_user') LIMIT 1`, user.id)) {
      throw new RepositoryError(400, 'An owner or demo membership in the sandbox, or a sandbox site code, is required.', 'DEMO_SCOPE_INVALID');
    }
    await demoteDemoOwners(tx, user.id);
    return { user_id: user.id, role: DEMO_ROLE };
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let db;
  try {
    const [action, ...args] = process.argv.slice(2);
    let run;
    if (['grant', 'revoke'].includes(action) && args.length === 2) run = db => changePermission(db, action, ...args);
    if (action === 'demo-site' && args.length === 1) run = db => markDemoSite(db, ...args);
    if (action === 'demo-user' && [1, 2].includes(args.length)) run = db => assignDemoUser(db, ...args);
    if (!run) throw new RepositoryError(400,
      'Usage: npm run admin -- grant|revoke invitations.manage <email> | demo-site <site-code> | demo-user <email> [site-code]',
      'INVALID_COMMAND');
    db = await openDb();
    console.log(JSON.stringify(await run(db)));
  } catch (error) {
    console.error(error instanceof RepositoryError ? error.message : 'Administrative command failed.');
    process.exitCode = 1;
  } finally {
    if (db) await closeDb(db).catch(() => { console.error('Unable to close database.'); process.exitCode = 1; });
  }
}
