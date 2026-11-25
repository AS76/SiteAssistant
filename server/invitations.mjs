import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createSession, hashPassword, tokenHash } from './auth.mjs';
import { deliver, invitationEmail, MailNotConfiguredError } from './auth-mail.mjs';
import { canManageInvitations, INVITATION_PERMISSION } from './admin.mjs';
import { DEMO_ROLE, RepositoryError, ROLES } from './repository.mjs';
import { normalizeEmail } from './signup.mjs';

export const ACTIVATION_PATH = '/attiva';
const invitationTtl = 72 * 60 * 60 * 1000;
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const idPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const metadata = 'id, email, created_at, expires_at, locale, delivery_status, delivery_attempts, delivered_at, last_delivery_error';
const pending = 'used_at IS NULL AND revoked_at IS NULL';
const notFound = () => new RepositoryError(404, 'Pending invitation not found.', 'INVITATION_NOT_FOUND');
const forbidden = () => new RepositoryError(403, 'Invitation management permission is required.', 'FORBIDDEN');

const copy = {
  en: {
    title: 'Activate account', heading: 'Choose your password', hint: 'Use 12 to 1024 characters.',
    password: 'Password', confirmation: 'Confirm password',
    javascript: 'Enable JavaScript to activate your account.',
    INVITATION_UNAVAILABLE: 'Ask your administrator for a new invitation.',
    INVITATION_PASSWORD_INVALID: 'Enter the same password in both fields, using 12 to 1024 characters.',
    FORBIDDEN: 'Open the invitation link to activate your account.',
    RATE_LIMITED: 'Too many attempts. Try again later.',
    INVALID_FORM: 'The form is invalid. Open the invitation link and try again.',
    INTERNAL_ERROR: 'Activation is temporarily unavailable. Try again later.',
  },
  it: {
    title: 'Attiva account', heading: 'Scegli la password', hint: 'Usa da 12 a 1024 caratteri.',
    password: 'Password', confirmation: 'Conferma password',
    javascript: 'Attiva JavaScript per attivare il tuo account.',
    INVITATION_UNAVAILABLE: 'Chiedi un nuovo invito all’amministratore.',
    INVITATION_PASSWORD_INVALID: 'Inserisci la stessa password in entrambi i campi, usando da 12 a 1024 caratteri.',
    FORBIDDEN: 'Apri il link di invito per attivare l’account.',
    RATE_LIMITED: 'Troppi tentativi. Riprova più tardi.',
    INVALID_FORM: 'Il modulo non è valido. Apri il link di invito e riprova.',
    INTERNAL_ERROR: 'L’attivazione non è disponibile al momento. Riprova più tardi.',
  },
};

export function invitationMessage(locale, code) {
  const strings = locale === 'it' ? copy.it : copy.en;
  return strings[code] ?? strings.INTERNAL_ERROR;
}

function gone(locale = 'en') {
  const code = 'INVITATION_UNAVAILABLE';
  return Object.assign(new RepositoryError(410, invitationMessage(locale, code), code), { locale });
}

async function auditInvitation(tx, actor, event, id, at, { outcome = 'success', ...detail } = {}) {
  await tx.run(`INSERT INTO auth_events (id, user_id, event, outcome, detail_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`, randomUUID(), actor, event, outcome,
  JSON.stringify({ invitation_id: id, ...(actor === null ? { source: 'cli' } : {}), ...detail }), at);
}

function normalizeLocale(value) {
  const locale = typeof value === 'string' ? value.trim().toLowerCase() : value;
  if (locale === undefined || locale === null || locale === '') return 'en';
  if (locale === 'it' || locale === 'en') return locale;
  throw new RepositoryError(400, 'Locale must be it or en.', 'INVITATION_LOCALE_INVALID');
}

function deliveryUrl(mailer, publicUrl) {
  if (typeof mailer !== 'function') throw new MailNotConfiguredError();
  mailer.assertConfigured?.();
  const url = new URL(ACTIVATION_PATH, publicUrl);
  if (url.protocol !== 'https:') throw new Error('Invitations require an HTTPS public URL.');
  return url;
}

async function insertInvitation(tx, { email, created_by, locale, site_id, site_role }, hash, now) {
  const at = now.toISOString();
  const expiresAt = new Date(now.getTime() + invitationTtl).toISOString();
  const row = await tx.get(`INSERT INTO invitations (id, email, token_hash, created_by, created_at, expires_at, locale, site_id, site_role)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (email) WHERE ${pending} DO NOTHING RETURNING id`,
  randomUUID(), email, hash, created_by, at, expiresAt, locale, site_id, site_role);
  // The insert can wait for concurrent activation. Check the account after it.
  if (await tx.get('SELECT id FROM users WHERE lower(email) = ?', email)) {
    throw new RepositoryError(409, 'An account already exists for this email.', 'ACCOUNT_EXISTS');
  }
  if (!row) throw new RepositoryError(409, 'Revoke the pending invitation before inviting again.', 'INVITATION_EXISTS');
  return row.id;
}

async function sendInvitation(db, id, token, url, mailer, actor, { retryFrom } = {}) {
  const hash = tokenHash(token);
  const claimed = await db.transaction(async tx => {
    const at = new Date().toISOString();
    const row = await tx.get(`UPDATE invitations SET delivery_status = 'pending', delivery_attempts = delivery_attempts + 1,
      token_hash = ?, last_delivery_error = NULL
      WHERE id = ? AND ${pending} AND expires_at > ? AND ${retryFrom !== undefined
        ? "delivery_status = 'failed' AND delivery_attempts = ?"
        : "delivery_status = 'pending' AND delivery_attempts = 0 AND token_hash = ?"}
      RETURNING email, locale, delivery_attempts`, hash, id, at, retryFrom ?? hash);
    if (!row) throw new RepositoryError(409, 'Invitation is unavailable for delivery.', 'INVITATION_DELIVERY_CONFLICT');
    if (retryFrom !== undefined) await auditInvitation(tx, actor, 'invitation_retried', id, at, { attempt: row.delivery_attempts });
    return row;
  });

  url.searchParams.set('token', token);
  let errorCode = null;
  try {
    await deliver(mailer, { to: claimed.email, ...invitationEmail({ activationUrl: url.href, locale: claimed.locale }) });
  } catch (error) {
    errorCode = error instanceof MailNotConfiguredError ? 'MAIL_NOT_CONFIGURED' : 'MAIL_UNAVAILABLE';
  }
  return db.transaction(async tx => {
    const at = new Date().toISOString();
    const row = await tx.get(`UPDATE invitations SET delivery_status = ?, delivered_at = ?, last_delivery_error = ?
      WHERE id = ? AND token_hash = ? AND delivery_status = 'pending' AND delivery_attempts = ?
      RETURNING ${metadata}, revoked_at`, errorCode ? 'failed' : 'sent', errorCode ? null : at,
    errorCode, id, hash, claimed.delivery_attempts);
    if (!row) throw new Error('Invitation delivery outcome could not be recorded.');
    await auditInvitation(tx, actor, errorCode ? 'invitation_delivery_failed' : 'invitation_delivered', id, at,
      { outcome: errorCode ? 'failure' : 'success', attempt: claimed.delivery_attempts, ...(errorCode ? { code: errorCode } : {}) });
    return row;
  });
}

export async function createInvitation(db, email, actor, { mailer, publicUrl, locale, cantiere_id, role, demoSandbox = false }) {
  const url = deliveryUrl(mailer, publicUrl);
  locale = normalizeLocale(locale);
  const invalidSite = () => new RepositoryError(400, 'Supply a site UUID and a valid role together.', 'INVITATION_SITE_INVALID');
  if ((role !== undefined && !ROLES.includes(role)) ||
      (cantiere_id !== undefined && (typeof cantiere_id !== 'string' || !idPattern.test(cantiere_id)))) {
    throw invalidSite();
  }
  const siteId = cantiere_id?.toLowerCase() ?? null;
  const token = randomBytes(32).toString('base64url');
  const id = await db.transaction(async tx => {
    const now = new Date();
    const at = now.toISOString();
    const expired = await tx.get(`UPDATE invitations SET revoked_at = ?
      WHERE email = ? AND ${pending} AND expires_at <= ? RETURNING id`, at, email, at);
    if (!await canManageInvitations(tx, actor)) throw forbidden();
    const site = siteId && await tx.get(`SELECT s.demo_sandbox FROM sites s JOIN accessible_site_members m ON m.site_id = s.id
      WHERE s.id = ? AND m.user_id = ? AND m.role = 'owner'`, siteId, actor);
    if (siteId && !site) {
      if (role === undefined) throw invalidSite();
      throw new RepositoryError(403, 'Site owner authority is required.', 'FORBIDDEN');
    }
    const sandbox = siteId ? Boolean(site.demo_sandbox) : demoSandbox;
    const siteRole = role ?? (sandbox ? DEMO_ROLE : null);
    if ((siteRole === DEMO_ROLE && !sandbox) || (siteId && !siteRole) ||
        (!siteId && siteRole !== null && siteRole !== DEMO_ROLE)) throw invalidSite();
    const id = await insertInvitation(tx, {
      email, created_by: actor, locale, site_id: siteId, site_role: siteRole,
    }, tokenHash(token), now);
    if (expired) await auditInvitation(tx, actor, 'invitation_revoked', expired.id, at);
    await auditInvitation(tx, actor, 'invitation_created', id, at);
    return id;
  });
  return sendInvitation(db, id, token, url, mailer, actor);
}

export async function readInvitation(db, token) {
  if (typeof token !== 'string' || !tokenPattern.test(token)) throw gone();
  const row = await db.get('SELECT email, token_hash, expires_at, used_at, revoked_at, locale FROM invitations WHERE token_hash = ?', tokenHash(token));
  if (!row || row.used_at || row.revoked_at || Date.parse(row.expires_at) <= Date.now()) throw gone(row?.locale);
  return row;
}

export async function activateInvitation(db, invitation, password, confirmation, { ip, userAgent }) {
  if (typeof password !== 'string' || [...password].length < 12 || password.length > 1024 || password !== confirmation) {
    const code = 'INVITATION_PASSWORD_INVALID';
    throw new RepositoryError(400, invitationMessage(invitation.locale, code), code);
  }
  const encoded = await hashPassword(password);
  return db.transaction(async tx => {
    const at = new Date();
    const timestamp = at.toISOString();
    const row = await tx.get(`UPDATE invitations SET used_at = ?
      WHERE token_hash = ? AND ${pending} AND expires_at > ?
      RETURNING id, email, expires_at, locale, created_by, site_id, site_role`, timestamp, invitation.token_hash, timestamp);
    if (!row || Date.parse(row.expires_at) <= Date.now()) throw gone(invitation.locale);
    const user = await tx.get(`INSERT INTO users (id, email, name, password_hash, password_algo, created_at, language, demo_sandbox)
      VALUES (?, ?, ?, ?, 'scrypt', ?, ?, ?) ON CONFLICT DO NOTHING
      RETURNING id, email, name, language, shared_demo, demo_sandbox`, randomUUID(), row.email, row.email, encoded, timestamp, row.locale, row.site_role === DEMO_ROLE);
    if (!user) throw gone(row.locale);
    if (row.site_id) {
      // Membership edits also lock this site row. Recheck the original inviter's authority.
      await tx.run('UPDATE sites SET id = id WHERE id = ?', row.site_id);
      await tx.run(`INSERT INTO site_members (site_id, user_id, role)
        SELECT m.site_id, ?, ? FROM accessible_site_members m JOIN users u ON u.id = m.user_id
        JOIN user_permissions p ON p.user_id = u.id AND p.permission = ? AND p.revoked_at IS NULL
        WHERE m.site_id = ? AND m.user_id = ? AND m.role = 'owner' AND u.disabled_at IS NULL
          AND (NOT ? OR EXISTS (SELECT 1 FROM sites s WHERE s.id = m.site_id AND s.demo_sandbox))`,
      user.id, row.site_role, INVITATION_PERMISSION, row.site_id, row.created_by, row.site_role === DEMO_ROLE);
    }
    await auditInvitation(tx, user.id, 'invitation_used', row.id, timestamp);
    return createSession(tx, user, { ip, userAgent, at });
  });
}

function invitationSelector(value) {
  if (typeof value === 'string' && idPattern.test(value)) return ['id', value.toLowerCase()];
  return ['email', normalizeEmail(value)];
}

export async function revokeInvitation(db, value, actor, attemptAccount) {
  if (actor !== null && !idPattern.test(value)) throw notFound();
  const [field, target] = invitationSelector(value);
  const row = await db.get(`SELECT id, email FROM invitations WHERE ${field} = ? AND ${pending}`, target);
  if (!row) throw notFound();
  attemptAccount?.(row.email);
  return db.transaction(async tx => {
    const at = new Date().toISOString();
    const result = await tx.run(`UPDATE invitations SET revoked_at = ? WHERE id = ? AND ${pending}`, at, row.id);
    if (actor !== null && !await canManageInvitations(tx, actor)) throw forbidden();
    if (!result.rowCount) throw notFound();
    await auditInvitation(tx, actor, 'invitation_revoked', row.id, at);
    return { id: row.id, revoked_at: at };
  });
}

export async function listInvitations(db) {
  return db.transaction(async tx => {
    const at = new Date().toISOString();
    await tx.run(`INSERT INTO auth_events (id, event, outcome, detail_json, created_at)
      VALUES (?, 'invitations_listed', 'success', ?, ?)`, randomUUID(), JSON.stringify({ source: 'cli' }), at);
    return tx.all(`SELECT ${metadata}, created_by, site_id, site_role
      FROM invitations WHERE ${pending} AND expires_at > ? ORDER BY created_at, id`, at);
  });
}

export async function retryInvitation(db, value, { mailer, publicUrl }) {
  const url = deliveryUrl(mailer, publicUrl);
  const [field, target] = invitationSelector(value);
  const row = await db.get(`SELECT id, delivery_attempts FROM invitations WHERE ${field} = ? AND ${pending}`, target);
  if (!row) throw notFound();
  return sendInvitation(db, row.id, randomBytes(32).toString('base64url'), url, mailer, null, { retryFrom: row.delivery_attempts });
}

export async function reissueInvitation(db, value, { mailer, publicUrl }) {
  const url = deliveryUrl(mailer, publicUrl);
  const [field, target] = invitationSelector(value);
  const current = await db.get(`SELECT id FROM invitations WHERE ${field} = ? AND ${pending}`, target);
  if (!current) throw notFound();
  const token = randomBytes(32).toString('base64url');
  const id = await db.transaction(async tx => {
    const now = new Date();
    const at = now.toISOString();
    const previous = await tx.get(`UPDATE invitations SET revoked_at = ?
      WHERE id = ? AND ${pending} RETURNING id, email, created_by, locale, site_id, site_role`, at, current.id);
    if (!previous) throw notFound();
    const id = await insertInvitation(tx, previous, tokenHash(token), now);
    await auditInvitation(tx, null, 'invitation_revoked', previous.id, at);
    await auditInvitation(tx, null, 'invitation_reissued', id, at, { previous_invitation_id: previous.id });
    return id;
  });
  return sendInvitation(db, id, token, url, mailer, null);
}

// Keep the bearer token in the original URL and in the submitted request only.
const activationScript = `const form = document.querySelector('form');
const alert = document.querySelector('[role="alert"]');
const button = form.querySelector('button');
form.addEventListener('submit', async event => {
  event.preventDefault();
  const body = new URLSearchParams(new FormData(form));
  body.set('token', new URL(location.href).searchParams.get('token') || '');
  button.disabled = true;
  try {
    const response = await fetch(form.action, { method: 'POST', body, redirect: 'manual' });
    if (response.type === 'opaqueredirect') {
      try { sessionStorage.setItem('sa-activated', '1'); } catch { /* Activation already succeeded. */ }
      location.replace('/');
      return;
    }
    const page = new DOMParser().parseFromString(await response.text(), 'text/html');
    alert.textContent = page.querySelector('[role="alert"]')?.textContent || alert.dataset.fallback;
    if (response.status === 410 || response.status === 403) form.hidden = true;
  } catch {
    alert.textContent = alert.dataset.fallback;
  } finally {
    button.disabled = false;
  }
});`;
export const activationScriptHash = createHash('sha256').update(activationScript).digest('base64');

export function activationPage({ locale = 'en', code, showForm = false } = {}) {
  locale = locale === 'it' ? 'it' : 'en';
  const strings = copy[locale];
  const form = showForm ? `<p>${strings.hint}</p>
    <noscript><p>${strings.javascript}</p></noscript>
    <form method="post" action="/api/auth/activate" novalidate>
      <label>${strings.password}<input type="password" name="password" autocomplete="new-password" required minlength="12" maxlength="1024"></label>
      <label>${strings.confirmation}<input type="password" name="confirmation" autocomplete="new-password" required minlength="12" maxlength="1024"></label>
      <button type="submit">${strings.title}</button>
    </form><script>${activationScript}</script>` : '';
  return `<!doctype html>
    <html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>SiteAssistant | ${strings.title}</title>
    <style>body{background:#d1e7c0;color:#142c30;font:1rem system-ui;padding:1rem}main{max-width:32rem;margin:auto;background:white;padding:1.25rem;border-radius:.75rem}label{display:block;margin:1rem 0}input,button{box-sizing:border-box;min-height:44px;padding:.5rem;font:inherit}input[type=password]{display:block;width:100%}button{background:#126c57;color:white;border:0;border-radius:.5rem;padding-inline:1rem}</style>
    </head><body><main><p>SiteAssistant</p><h1>${strings.heading}</h1>
    <p role="alert" data-fallback="${strings.INTERNAL_ERROR}">${code ? invitationMessage(locale, code) : ''}</p>${form}</main></body></html>`;
}
