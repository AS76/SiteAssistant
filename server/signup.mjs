import { randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { hashPassword, tokenHash, verifyPassword } from './auth.mjs';
import { RepositoryError } from './repository.mjs';
import { MailNotConfiguredError, MailDeliveryError, signupNotifyEmail, welcomeEmail, resetEmail } from './auth-mail.mjs';

export const DECISION_TTL = 72 * 60 * 60 * 1000;
const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
export const temporaryPassword = () => Array.from({ length: 16 }, () => alphabet[randomInt(alphabet.length)]).join('');
const invalid = message => new RepositoryError(400, message, 'VALIDATION_ERROR');
const gone = () => new RepositoryError(410, 'This decision link is invalid, expired or has already been used.', 'LINK_EXPIRED');
const credentials = () => new RepositoryError(401, 'Invalid current password.', 'INVALID_CREDENTIALS');
export function normalizeEmail(value) {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (email.length > 254 || !/^[^\s@<>\x00-\x1f\x7f]+@[^\s@<>\x00-\x1f\x7f]+\.[^\s@<>\x00-\x1f\x7f]+$/.test(email)) throw invalid('A valid email is required.');
  return email;
}
async function deliver(mailer, message) {
  try { await mailer(message); }
  catch (error) {
    if (error instanceof MailNotConfiguredError) throw error;
    throw new MailDeliveryError();
  }
}

export async function requestSignup(db, email, { mailer, ownerEmail, publicUrl }) {
  await db.transaction(async tx => {
    // Disabled identities are also reserved: self-service cannot reactivate them.
    if (await tx.get('SELECT id FROM users WHERE lower(email) = ?', email)) return;
    const token = randomBytes(32).toString('base64url');
    const result = await tx.run(`INSERT INTO signup_requests
      (id, email, decision_token_hash, status, requested_at)
      VALUES (?, ?, ?, 'pending', ?) ON CONFLICT DO NOTHING`,
    randomUUID(), email, tokenHash(token), new Date().toISOString());
    if (!result.rowCount) return;
    const url = new URL('/api/auth/request/decide', publicUrl);
    url.searchParams.set('token', token);
    await deliver(mailer, { to: ownerEmail, ...signupNotifyEmail({ email, reviewUrl: url.href }) });
  });
}

// Read-only validation shared by the review page and the transactional decision.
export async function readSignupRequest(db, token, at = new Date()) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw gone();
  const hash = tokenHash(token);
  const row = await db.get('SELECT * FROM signup_requests WHERE decision_token_hash = ?', hash);
  const stored = row?.decision_token_hash || '0'.repeat(64);
  const valid = timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(stored, 'hex'));
  if (!valid || !row || row.status !== 'pending' || Date.parse(row.requested_at) <= at.getTime() - DECISION_TTL) throw gone();
  return row;
}

export async function decideSignup(db, token, decision, { mailer }) {
  if (!['approve', 'reject'].includes(decision)) throw invalid('Decision must be approve or reject.');
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw gone();
  return await db.transaction(async tx => {
    const at = new Date(), cutoff = new Date(at.getTime() - DECISION_TTL).toISOString();
    const row = await readSignupRequest(tx, token, at);
    // Conditional update locks the row and elects one winner across processes.
    const result = await tx.run(`UPDATE signup_requests SET status = ?, decided_at = ?
      WHERE id = ? AND status = 'pending' AND requested_at > ?`,
    decision === 'approve' ? 'approved' : 'rejected', at.toISOString(), row.id, cutoff);
    if (!result.rowCount) throw gone();
    if (decision === 'approve') {
      const password = temporaryPassword();
      const created = await tx.run(`INSERT INTO users
        (id, email, name, password_hash, password_algo, created_at, password_change_required)
        VALUES (?, ?, ?, ?, 'scrypt', ?, true) ON CONFLICT DO NOTHING`,
      randomUUID(), row.email, row.email, await hashPassword(password), at.toISOString());
      if (!created.rowCount) throw gone();
      await deliver(mailer, { to: row.email, ...welcomeEmail({ password }) });
    }
    return decision;
  });
}

export async function changePassword(db, user, input) {
  if (typeof input.current_password !== 'string' || input.current_password.length > 1024 ||
      typeof input.new_password !== 'string' || [...input.new_password].length < 12 || input.new_password.length > 1024 ||
      input.new_password === input.current_password) throw invalid('Use a different password with 12 to 1024 characters.');
  await db.transaction(async tx => {
    // Serialize password writers and recheck session validity after obtaining the lock.
    const current = await tx.get('UPDATE users SET id = id WHERE id = ? AND disabled_at IS NULL RETURNING *', user.id);
    if (!current || !await tx.get(`SELECT id FROM sessions WHERE id = ? AND user_id = ?
      AND revoked_at IS NULL AND expires_at > ?`, user.session_id, user.id, new Date().toISOString())) {
      throw new RepositoryError(401, 'A valid session is required.', 'AUTH_REQUIRED');
    }
    if (current.password_algo !== 'scrypt' || !await verifyPassword(input.current_password, current.password_hash)) throw credentials();
    await tx.run("UPDATE users SET password_hash = ?, password_algo = 'scrypt', password_change_required = false WHERE id = ?", await hashPassword(input.new_password), user.id);
    await tx.run('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND id <> ? AND revoked_at IS NULL', new Date().toISOString(), user.id, user.session_id);
  });
}

export async function forgotPassword(db, email, { mailer }) {
  await db.transaction(async tx => {
    const user = await tx.get('UPDATE users SET id = id WHERE lower(email) = ? AND disabled_at IS NULL RETURNING *', email);
    if (!user) return;
    const password = temporaryPassword();
    await tx.run("UPDATE users SET password_hash = ?, password_algo = 'scrypt', password_change_required = true WHERE id = ?", await hashPassword(password), user.id);
    await tx.run('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', new Date().toISOString(), user.id);
    await deliver(mailer, { to: email, ...resetEmail({ password }) });
  });
}

const escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export function decisionPage(message, review) {
  const buttonStyle = 'font:inherit;padding:12px 20px;border:1px solid #126c57;border-radius:8px;cursor:pointer';
  const form = review ? `<dl><dt>Indirizzo email</dt><dd>${escapeHtml(review.email)}</dd><dt>Data e ora della richiesta (UTC)</dt><dd><time datetime="${escapeHtml(new Date(review.requested_at).toISOString())}">${escapeHtml(new Date(review.requested_at).toISOString())}</time></dd></dl><form method="post" action="/api/auth/request/decide"><input type="hidden" name="token" value="${escapeHtml(review.token)}"><div style="display:flex;flex-wrap:wrap;gap:12px"><button type="submit" name="decision" value="approve" style="${buttonStyle};background:#126c57;color:white">Approva</button><button type="submit" name="decision" value="reject" style="${buttonStyle};background:white;color:#126c57">Rifiuta</button></div></form>` : '';
  return `<!doctype html><html lang="${review ? 'it' : 'en'}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SiteAssistant</title><body style="background:#d1e7c0;color:#142c30;font-family:Arial,sans-serif;padding:24px"><main style="max-width:560px;margin:auto;background:white;padding:28px;border-radius:12px;overflow-wrap:anywhere"><h1 style="color:#126c57">SiteAssistant</h1><p>${escapeHtml(message)}</p>${form}</main></body></html>`;
}
