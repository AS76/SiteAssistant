import { randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { hashPassword, tokenHash, verifyPassword } from './auth.mjs';
import { DEMO_ROLE, RepositoryError } from './repository.mjs';
import { deliver, signupNotifyEmail, welcomeEmail, resetEmail } from './auth-mail.mjs';
import { recordAuthEvent } from './auth-events.mjs';
import { isDemoSandbox } from './demo-sandbox.mjs';

export const RESET_TTL = 30 * 60 * 1000;
export const RESET_PATH = '/api/auth/reset';
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
export async function requestSignup(db, email, { mailer, ownerEmail, publicUrl, language = null }) {
  await db.transaction(async tx => {
    // Disabled identities are also reserved: self-service cannot reactivate them.
    if (await tx.get('SELECT id FROM users WHERE lower(email) = ?', email)) return;
    const token = randomBytes(32).toString('base64url');
    const result = await tx.run(`INSERT INTO signup_requests
      (id, email, decision_token_hash, status, requested_at, language)
      VALUES (?, ?, ?, 'pending', ?, ?) ON CONFLICT DO NOTHING`,
    randomUUID(), email, tokenHash(token), new Date().toISOString(), language);
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

export async function decideSignup(db, token, decision, { mailer, demoSandbox = isDemoSandbox() }) {
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
      const user = await tx.get(`INSERT INTO users
        (id, email, name, password_hash, password_algo, created_at, password_change_required, demo_sandbox)
        VALUES (?, ?, ?, ?, 'scrypt', ?, true, ?) ON CONFLICT DO NOTHING RETURNING id`,
      randomUUID(), row.email, row.email, await hashPassword(password), at.toISOString(), demoSandbox);
      if (!user) throw gone();
      let sitesAssigned = 0;
      if (demoSandbox) {
        const assigned = await tx.run(`INSERT INTO site_members (site_id, user_id, role)
          SELECT id, ?, ? FROM sites WHERE demo_sandbox
          ON CONFLICT (site_id, user_id) DO NOTHING`, user.id, DEMO_ROLE);
        sitesAssigned = assigned.rowCount;
      }
      await recordAuthEvent(tx, 'signup.approved', {
        userId: user.id, at: at.toISOString(), detail: { sites_assigned: sitesAssigned },
      });
      await deliver(mailer, { to: row.email, ...welcomeEmail({ password, language: row.language }) });
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
    await tx.run('DELETE FROM password_resets WHERE user_id = ?', user.id);
  });
}

const resetGone = () => new RepositoryError(410, 'This reset link is invalid, expired or has already been used.', 'RESET_LINK_EXPIRED');

async function auditReset(tx, userId, event, at) {
  await tx.run(`INSERT INTO auth_events (id, user_id, event, outcome, detail_json, created_at)
    VALUES (?, ?, ?, 'success', '{}', ?)`, randomUUID(), userId, event, at);
}

export async function forgotPassword(db, email, { mailer, publicUrl, language }) {
  await db.transaction(async tx => {
    const user = await tx.get('UPDATE users SET id = id WHERE lower(email) = ? AND disabled_at IS NULL RETURNING id', email);
    if (!user) return;
    const token = randomBytes(32).toString('base64url');
    const at = new Date();
    await tx.run(`INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES (?, ?, ?)
      ON CONFLICT (user_id) DO UPDATE SET token_hash = excluded.token_hash, expires_at = excluded.expires_at`,
    user.id, tokenHash(token), new Date(at.getTime() + RESET_TTL).toISOString());
    const url = new URL(RESET_PATH, publicUrl);
    url.searchParams.set('token', token);
    if (language === 'it') url.searchParams.set('lang', 'it');
    await auditReset(tx, user.id, 'password_reset.requested', at.toISOString());
    await deliver(mailer, { to: email, ...resetEmail({ resetUrl: url.href, language }) });
  });
}

export async function readPasswordReset(db, token) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw resetGone();
  const row = await db.get(`SELECT r.user_id FROM password_resets r JOIN users u ON u.id = r.user_id
    WHERE r.token_hash = ? AND r.expires_at > ? AND u.disabled_at IS NULL`, tokenHash(token), new Date().toISOString());
  if (!row) throw resetGone();
  return row;
}

export async function confirmPasswordReset(db, token, password, confirmation) {
  const { user_id: userId } = await readPasswordReset(db, token);
  if (typeof password !== 'string' || [...password].length < 12 || password.length > 1024 || password !== confirmation) {
    throw new RepositoryError(400, 'Enter the same password in both fields, using 12 to 1024 characters.', 'RESET_PASSWORD_INVALID');
  }
  const encoded = await hashPassword(password);
  await db.transaction(async tx => {
    // Lock the account before consuming the token, in the same order as other password writers.
    const user = await tx.get('UPDATE users SET id = id WHERE id = ? AND disabled_at IS NULL RETURNING id', userId);
    if (!user) throw resetGone();
    const at = new Date().toISOString();
    const consumed = await tx.run('DELETE FROM password_resets WHERE user_id = ? AND token_hash = ? AND expires_at > ?', userId, tokenHash(token), at);
    if (!consumed.rowCount) throw resetGone();
    await tx.run("UPDATE users SET password_hash = ?, password_algo = 'scrypt', password_change_required = false WHERE id = ?", encoded, userId);
    await tx.run('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', at, userId);
    await auditReset(tx, userId, 'password_reset.completed', at);
  });
}

const escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export function decisionPage(message, review) {
  const buttonStyle = 'font:inherit;padding:12px 20px;border:1px solid #126c57;border-radius:8px;cursor:pointer';
  const form = review ? `<dl><dt>Indirizzo email</dt><dd>${escapeHtml(review.email)}</dd><dt>Data e ora della richiesta (UTC)</dt><dd><time datetime="${escapeHtml(new Date(review.requested_at).toISOString())}">${escapeHtml(new Date(review.requested_at).toISOString())}</time></dd></dl><form method="post" action="/api/auth/request/decide"><input type="hidden" name="token" value="${escapeHtml(review.token)}"><div style="display:flex;flex-wrap:wrap;gap:12px"><button type="submit" name="decision" value="approve" style="${buttonStyle};background:#126c57;color:white">Approva</button><button type="submit" name="decision" value="reject" style="${buttonStyle};background:white;color:#126c57">Rifiuta</button></div></form>` : '';
  return `<!doctype html><html lang="${review ? 'it' : 'en'}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SiteAssistant</title><body style="background:#d1e7c0;color:#142c30;font-family:Arial,sans-serif;padding:24px"><main style="max-width:560px;margin:auto;background:white;padding:28px;border-radius:12px;overflow-wrap:anywhere"><h1 style="color:#126c57">SiteAssistant</h1><p>${escapeHtml(message)}</p>${form}</main></body></html>`;
}

export function resetPage(language, state, token) {
  const lang = language === 'it' ? 'it' : 'en';
  const copy = lang === 'it' ? {
    title: 'Reimposta la password', password: 'Nuova password', confirmation: 'Conferma la nuova password',
    rule: 'Usa da 12 a 1024 caratteri.', invalid: 'Inserisci la stessa password in entrambi i campi, usando da 12 a 1024 caratteri.',
    expired: 'Il link non è valido, è scaduto o è già stato usato. Richiedi un nuovo link dalla pagina di accesso.',
    done: 'Password aggiornata. Torna alla pagina di accesso per entrare con la nuova password.',
    limited: 'Troppi tentativi. Riprova più tardi.',
  } : {
    title: 'Reset your password', password: 'New password', confirmation: 'Confirm new password',
    rule: 'Use 12 to 1024 characters.', invalid: 'Enter the same password in both fields, using 12 to 1024 characters.',
    expired: 'This link is invalid, expired or has already been used. Request a new link from the sign-in page.',
    done: 'Password updated. Return to the sign-in page to use your new password.',
    limited: 'Too many attempts. Try again later.',
  };
  const form = state === 'ready' || state === 'invalid' ? `<p id="password-rule">${copy.rule}</p><form method="post" action="${RESET_PATH}"><input type="hidden" name="token" value="${escapeHtml(token)}"><input type="hidden" name="lang" value="${lang}"><label>${copy.password}<input type="password" name="password" required minlength="12" maxlength="1024" autocomplete="new-password" aria-describedby="password-rule"></label><label>${copy.confirmation}<input type="password" name="confirmation" required minlength="12" maxlength="1024" autocomplete="new-password"></label><button type="submit">${copy.title}</button></form>` : '';
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SiteAssistant | ${copy.title}</title><style>body{background:#d1e7c0;color:#142c30;font:1rem system-ui;margin:0;padding:1rem}main{max-width:32rem;margin:auto;background:white;padding:1.25rem;border-radius:.75rem}label{display:block;margin:1rem 0}input,button{box-sizing:border-box;min-height:44px;padding:.5rem;font:inherit}input[type=password]{display:block;width:100%}button{background:#126c57;color:white;border:0;border-radius:.5rem;padding-inline:1rem}</style></head><body><main><p>SiteAssistant</p><h1>${copy.title}</h1>${copy[state] ? `<p role="${state === 'done' ? 'status' : 'alert'}">${copy[state]}</p>` : ''}${form}</main></body></html>`;
}
