import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { closeDb, openDb } from './db.mjs';
import { RepositoryError } from './repository.mjs';
import { normalizeEmail } from './signup.mjs';

export const INVITATION_PERMISSION = 'invitations.manage';

export async function canManageInvitations(db, userId) {
  return Boolean(await db.get(`SELECT user_id FROM user_permissions
    WHERE user_id = ? AND permission = ? AND revoked_at IS NULL`, userId, INVITATION_PERMISSION));
}

export async function changePermission(db, action, permission, address) {
  if (!['grant', 'revoke'].includes(action) || permission !== INVITATION_PERMISSION) {
    throw new RepositoryError(400, 'Usage: npm run admin -- grant|revoke invitations.manage <email>', 'INVALID_COMMAND');
  }
  const email = normalizeEmail(address);
  const state = await db.transaction(async tx => {
    // Serialize grants and revocations for this user, including when no grant exists.
    const user = await tx.get('UPDATE users SET id = id WHERE lower(email) = ? RETURNING id', email);
    const at = new Date().toISOString();
    // A NULL grantor/audit actor identifies the trusted server CLI.
    if (!user) {
      await tx.run(`INSERT INTO auth_events (id, event, outcome, detail_json, created_at)
        VALUES (?, ?, 'failure', ?, ?)`, randomUUID(), `permission_${action}`,
      JSON.stringify({ permission, source: 'cli', code: 'USER_NOT_FOUND' }), at);
      return null;
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let db;
  try {
    if (process.argv.length !== 5) throw new RepositoryError(400, 'Usage: npm run admin -- grant|revoke invitations.manage <email>', 'INVALID_COMMAND');
    db = await openDb();
    console.log(JSON.stringify(await changePermission(db, ...process.argv.slice(2))));
  } catch (error) {
    console.error(error instanceof RepositoryError ? error.message : 'Unable to change permission.');
    process.exitCode = 1;
  } finally {
    if (db) await closeDb(db).catch(() => { console.error('Unable to close database.'); process.exitCode = 1; });
  }
}
