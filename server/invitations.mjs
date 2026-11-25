import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createSession, hashPassword, tokenHash } from './auth.mjs';
import { deliver, invitationEmail } from './auth-mail.mjs';
import { RepositoryError } from './repository.mjs';

export const ACTIVATION_PATH = '/attiva';
const invitationTtl = 72 * 60 * 60 * 1000;
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const idPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const gone = () => new RepositoryError(410, 'Chiedi un nuovo invito all’amministratore.', 'INVITATION_UNAVAILABLE');
const notFound = () => new RepositoryError(404, 'Pending invitation not found.', 'INVITATION_NOT_FOUND');

async function auditInvitation(tx, userId, event, invitationId, at) {
  await tx.run(`INSERT INTO auth_events (id, user_id, event, outcome, detail_json, created_at)
    VALUES (?, ?, ?, 'success', ?, ?)`, randomUUID(), userId, event, JSON.stringify({ invitation_id: invitationId }), at);
}

export async function createInvitation(db, email, adminId, { mailer, publicUrl }) {
  mailer.assertConfigured?.();
  const token = randomBytes(32).toString('base64url');
  const url = new URL(ACTIVATION_PATH, publicUrl);
  if (url.protocol !== 'https:') throw new Error('Invitations require an HTTPS public URL.');
  url.searchParams.set('token', token);
  const id = randomUUID();
  return db.transaction(async tx => {
    const now = new Date();
    const at = now.toISOString();
    const expiresAt = new Date(now.getTime() + invitationTtl).toISOString();
    // Retire the expired row so it releases the partial unique index.
    const expired = await tx.get(`UPDATE invitations SET revoked_at = ?
      WHERE email = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at <= ? RETURNING id`, at, email, at);
    const result = await tx.run(`INSERT INTO invitations (id, email, token_hash, created_by, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (email) WHERE used_at IS NULL AND revoked_at IS NULL DO NOTHING`,
    id, email, tokenHash(token), adminId, at, expiresAt);
    // The insert can wait for concurrent activation. Check the account after it.
    // Disabled identities are reserved, as in the access-request flow.
    if (await tx.get('SELECT id FROM users WHERE lower(email) = ?', email)) {
      throw new RepositoryError(409, 'An account already exists for this email.', 'ACCOUNT_EXISTS');
    }
    if (!result.rowCount) throw new RepositoryError(409, 'Revoke the pending invitation before inviting again.', 'INVITATION_EXISTS');
    if (expired) await auditInvitation(tx, adminId, 'invitation_revoked', expired.id, at);
    await auditInvitation(tx, adminId, 'invitation_created', id, at);
    await deliver(mailer, { to: email, ...invitationEmail({ activationUrl: url.href }) });
    return { id, email, created_at: at, expires_at: expiresAt };
  });
}

export async function readInvitation(db, token) {
  if (typeof token !== 'string' || !tokenPattern.test(token)) throw gone();
  const hash = tokenHash(token);
  const row = await db.get('SELECT email, token_hash, expires_at, used_at, revoked_at FROM invitations WHERE token_hash = ?', hash);
  const stored = row?.token_hash ?? '0'.repeat(64);
  const matches = timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(stored, 'hex'));
  if (!matches || !row || row.used_at || row.revoked_at || Date.parse(row.expires_at) <= Date.now()) throw gone();
  return row;
}

export async function activateInvitation(db, invitation, password, confirmation, { ip, userAgent }) {
  // Invited accounts have no temporary credential. Existing accounts keep theirs.
  if (typeof password !== 'string' || [...password].length < 12 || password.length > 1024 || password !== confirmation) {
    throw new RepositoryError(400, 'Inserisci la stessa password in entrambi i campi, usando da 12 a 1024 caratteri.', 'INVITATION_PASSWORD_INVALID');
  }
  const encoded = await hashPassword(password);
  return db.transaction(async tx => {
    const at = new Date();
    const timestamp = at.toISOString();
    // Elect one winner across processes and serialize activation with revocation.
    const row = await tx.get(`UPDATE invitations SET used_at = ?
      WHERE token_hash = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?
      RETURNING id, email, expires_at`, timestamp, invitation.token_hash, timestamp);
    if (!row || Date.parse(row.expires_at) <= Date.now()) throw gone();
    const user = await tx.get(`INSERT INTO users (id, email, name, password_hash, password_algo, created_at)
      VALUES (?, ?, ?, ?, 'scrypt', ?) ON CONFLICT DO NOTHING
      RETURNING id, email, name, language, shared_demo`, randomUUID(), row.email, row.email, encoded, timestamp);
    if (!user) throw gone();
    await tx.run(`UPDATE invitations SET revoked_at = ?
      WHERE email = ? AND used_at IS NULL AND revoked_at IS NULL`, timestamp, row.email);
    await auditInvitation(tx, user.id, 'invitation_used', row.id, timestamp);
    return createSession(tx, user, { ip, userAgent, at });
  });
}

export async function revokeInvitation(db, id, adminId, attemptAccount) {
  if (!idPattern.test(id)) throw notFound();
  id = id.toLowerCase();
  const invitation = await db.get('SELECT email FROM invitations WHERE id = ?', id);
  if (!invitation) throw notFound();
  attemptAccount(invitation.email);
  return db.transaction(async tx => {
    const at = new Date().toISOString();
    const result = await tx.run(`UPDATE invitations SET revoked_at = ?
      WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL`, at, id);
    if (!result.rowCount) throw notFound();
    await auditInvitation(tx, adminId, 'invitation_revoked', id, at);
    return { id, revoked_at: at };
  });
}

export function activationPage({ token, message = '' } = {}) {
  // Only a validated base64url value can be echoed into the form.
  const form = tokenPattern.test(token ?? '') ? `<p>Usa da 12 a 1024 caratteri.</p>
    <form method="post" action="/api/auth/activate">
      <input type="hidden" name="token" value="${token}">
      <label>Password<input type="password" name="password" autocomplete="new-password" required minlength="12" maxlength="1024"></label>
      <label>Conferma password<input type="password" name="confirmation" autocomplete="new-password" required minlength="12" maxlength="1024"></label>
      <button type="submit">Attiva account</button>
    </form>` : '';
  return `<!doctype html>
    <html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>SiteAssistant | Attiva account</title>
    <style>body{background:#d1e7c0;color:#142c30;font:1rem system-ui;padding:1rem}main{max-width:32rem;margin:auto;background:white;padding:1.25rem;border-radius:.75rem}label{display:block;margin:1rem 0}input,button{box-sizing:border-box;min-height:44px;padding:.5rem;font:inherit}input[type=password]{display:block;width:100%}button{background:#126c57;color:white;border:0;border-radius:.5rem;padding-inline:1rem}</style>
    </head><body><main><p>SiteAssistant</p><h1>Scegli la password</h1>
    ${message ? `<p role="alert">${message}</p>` : ''}${form}</main></body></html>`;
}
