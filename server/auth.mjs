import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { RepositoryError } from './repository.mjs';
import { recordAuthEvent, recordLoginFailure, truncateIp } from './auth-events.mjs';

const derive = promisify(scrypt);
const N = 16384, r = 8, p = 1;
export const SESSION_TTL = 7 * 24 * 60 * 60 * 1000;
export const tokenHash = token => createHash('sha256').update(token).digest('hex');
const unauthorized = () => new RepositoryError(401, 'A valid session is required.', 'AUTH_REQUIRED');
export const publicUser = user => ({
  id: user.id, email: user.email, name: user.name, language: user.language, shared_demo: Boolean(user.shared_demo),
  ...(user.demo_sandbox ? { demo_sandbox: true } : {}),
});

export async function updateLanguage(db, userId, language) {
  const supported = ['it', 'en'];
  if (!supported.includes(language)) {
    throw new RepositoryError(400, 'Language must be it or en.', 'VALIDATION_ERROR');
  }
  const user = await db.get(`UPDATE users SET language = ?
    WHERE id = ? AND disabled_at IS NULL AND NOT shared_demo AND language IS DISTINCT FROM ?
    RETURNING id, email, name, language, shared_demo, demo_sandbox`, language, userId, language)
    ?? await db.get('SELECT id, email, name, language, shared_demo, demo_sandbox FROM users WHERE id = ? AND disabled_at IS NULL', userId);
  if (!user) throw unauthorized();
  if (user.shared_demo) throw new RepositoryError(409, 'Shared demo accounts cannot save a language preference.', 'SHARED_DEMO_PREFERENCE');
  return publicUser(user);
}

export async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = await derive(password, salt, 64, { N, r, p });
  return `scrypt$${N}$${r}$${p}$${salt}$${hash.toString('hex')}`;
}

export async function verifyPassword(password, encoded) {
  const parts = typeof encoded === 'string' ? encoded.split('$') : [];
  // This format's parameters are versioned in the prefix; reject unknown versions.
  if (parts.length !== 6 || parts[0] !== 'scrypt' || parts[1] !== String(N) ||
      parts[2] !== String(r) || parts[3] !== String(p) ||
      !/^[a-f0-9]{32}$/.test(parts[4]) || !/^[a-f0-9]{128}$/.test(parts[5])) return false;
  const actual = await derive(password, parts[4], 64, { N, r, p });
  return timingSafeEqual(actual, Buffer.from(parts[5], 'hex'));
}

export function assertAuthBypassAllowed(authBypassUser = process.env.AUTH_BYPASS_USER || '', production = false) {
  const environmentNames = [process.env.NODE_ENV, process.env.APP_ENV, process.env.RAILWAY_ENVIRONMENT_NAME, process.env.RAILWAY_ENVIRONMENT];
  if (authBypassUser.trim() && (production || environmentNames.some(name =>
    ['production', 'demo', 'staging'].includes(name?.trim().toLowerCase())))) {
    throw new Error('AUTH_BYPASS_USER is disabled in production, demo and staging.');
  }
}

export function createLoginLimiter({ now = Date.now } = {}) {
  const failures = new Map();
  const windowMs = 15 * 60 * 1000;
  let lastSweep;
  function rememberFailure(key, max, at, userId) {
    const recent = (failures.get(key)?.times || []).filter(time => time > at - windowMs);
    failures.set(key, { times: [...recent.slice(1 - max), at], userId });
  }
  return {
    check(ip, email) {
      const at = now(), cutoff = at - windowMs;
      // Retire idle keys without scanning the map on each login.
      if (lastSweep === undefined || at - lastSweep >= windowMs) {
        for (const [key, { times }] of failures) {
          if (times.at(-1) <= cutoff) failures.delete(key);
        }
        lastSweep = at;
      }
      const account = failures.get(`account:${email}`);
      const address = failures.get(`ip:${ip}`);
      const oldest = Math.max(account?.times.at(-10) ?? -Infinity, address?.times.at(-50) ?? -Infinity);
      if (oldest > cutoff) {
        const retryAfter = Math.max(1, Math.ceil((oldest + windowMs - at) / 1000));
        const minutes = Math.max(1, Math.ceil(retryAfter / 60));
        const error = new RepositoryError(429, `Troppi tentativi di accesso. Riprova tra ${minutes} minuti.`, 'RATE_LIMITED');
        error.retryAfter = retryAfter;
        if (account?.times.at(-1) > cutoff) error.auditUserId = account.userId;
        throw error;
      }
    },
    fail(ip, email, userId) {
      const at = now();
      rememberFailure(`account:${email}`, 10, at, userId);
      rememberFailure(`ip:${ip}`, 50, at);
    },
    succeed(_ip, email) { failures.delete(`account:${email}`); },
  };
}

const pendingLogins = new WeakMap();
async function withLoginTurn(limiter, key, run) {
  let pending = pendingLogins.get(limiter);
  if (!pending) pendingLogins.set(limiter, pending = new Map());
  const previous = pending.get(key);
  const { promise, resolve } = Promise.withResolvers();
  pending.set(key, promise);
  try {
    // Each check sees the recorded outcome of the previous login for this key.
    await previous;
    return await run();
  } finally {
    if (pending.get(key) === promise) pending.delete(key);
    resolve();
  }
}

export async function login(db, input, { ip = '', userAgent = '', limiter }) {
  const email = typeof input?.email === 'string' ? input.email.trim().toLowerCase() : '';
  const password = input?.password;
  const validEmail = email && email.length <= 254 && !email.includes('\0');
  try {
    if (!validEmail || typeof password !== 'string' || !password || password.length > 1024) {
      throw new RepositoryError(400, 'Valid email and password are required.', 'VALIDATION_ERROR');
    }
    return await withLoginTurn(limiter, `ip:${ip}`, () =>
      withLoginTurn(limiter, `account:${email}`, () => verifyLogin(db, email, password, { ip, userAgent, limiter })));
  } catch (error) {
    const reason = { VALIDATION_ERROR: 'invalid_request', INVALID_CREDENTIALS: 'invalid_credentials', RATE_LIMITED: 'rate_limited' }[error.code];
    if (reason) {
      const userId = reason === 'invalid_request' && validEmail
        ? (await db.get('SELECT id FROM users WHERE lower(email) = ?', email))?.id : error.auditUserId;
      await recordLoginFailure(db, reason, { userId, ip, userAgent, method: 'password' });
    }
    throw error;
  }
}

async function verifyLogin(db, email, password, { ip, userAgent, limiter }) {
  limiter.check(ip, email);
  const user = await db.get('SELECT * FROM users WHERE lower(email) = ?', email);
  const invalid = () => {
    limiter.fail(ip, email, user?.id);
    const error = new RepositoryError(401, 'Invalid email or password.', 'INVALID_CREDENTIALS');
    error.auditUserId = user?.id;
    return error;
  };
  // Unknown accounts still incur one scrypt calculation, without creating a user.
  const encoded = user?.password_algo === 'scrypt' ? user.password_hash
    : `scrypt$${N}$${r}$${p}$${'0'.repeat(32)}$${'0'.repeat(128)}`;
  const valid = await verifyPassword(password, encoded);
  if (!valid || !user || user.disabled_at) throw invalid();
  const at = new Date();
  const result = await db.transaction(async tx => {
    // A reset may finish while scrypt runs: serialize session creation with
    // password writers so an old credential cannot resurrect a revoked login.
    const current = await tx.get(`UPDATE users SET id = id
      WHERE id = ? AND password_hash = ? AND disabled_at IS NULL RETURNING *`, user.id, user.password_hash);
    if (!current) throw invalid();
    return createSession(tx, current, { ip, userAgent, at, method: 'password' });
  });
  limiter.succeed(ip, email);
  return result;
}

export async function createSession(tx, user, { ip, userAgent = '', at, method, credentialId }) {
  const token = randomBytes(32).toString('base64url');
  const timestamp = at.toISOString();
  await tx.run(`INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at, user_agent, ip,
    auth_method, assurance, last_seen_at, credential_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  randomUUID(), user.id, tokenHash(token), timestamp, new Date(at.getTime() + SESSION_TTL).toISOString(),
  userAgent.slice(0, 1000), truncateIp(ip), credentialId ? 'webauthn' : null,
  credentialId ? 'passkey' : null, credentialId ? timestamp : null, credentialId ?? null);
  await recordAuthEvent(tx, 'login.success', { userId: user.id, at: timestamp, ip, userAgent, detail: { method } });
  return { token, user: publicUser(user) };
}

export function isSecureRequest(request, { production = false } = {}) {
  if (production === true || request.socket?.encrypted === true) return true;
  const peer = request.socket?.remoteAddress || '';
  // Traefik runs on the same host: trust only loopback. Widening this requires an explicit CIDR.
  const loopback = peer === '::1' || peer.toLowerCase() === '::ffff:127.0.0.1' ||
    /^127(?:\.(?:0|[1-9]\d{0,2})){3}$/.test(peer) && peer.split('.').every(part => Number(part) <= 255);
  const proto = request.headers?.['x-forwarded-proto'];
  return loopback && typeof proto === 'string' && proto.split(',')[0].trim().toLowerCase() === 'https';
}

export function sessionCookie(token, { production = process.env.NODE_ENV === 'production', secure = false, clear = false } = {}) {
  return `sa_session=${clear ? '' : token}; Path=/api; HttpOnly; SameSite=Lax; Max-Age=${clear ? 0 : SESSION_TTL / 1000}${production || secure ? '; Secure' : ''}`;
}

export async function authenticate(db, cookie = '', { ip, userAgent } = {}) {
  const tokens = cookie.split(';').map(part => part.trim()).filter(part => part.startsWith('sa_session='));
  if (tokens.length !== 1) throw unauthorized();
  const token = tokens[0].slice('sa_session='.length);
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw unauthorized();
  const at = new Date().toISOString();
  const hash = tokenHash(token);
  const row = await db.get(`SELECT u.*, s.id AS session_id
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ? AND u.disabled_at IS NULL`,
  hash, at);
  if (row) return row;

  const expired = await db.get(`SELECT id FROM sessions WHERE token_hash = ?
    AND revoked_at IS NULL AND expires_at <= ? AND expiry_logged_at IS NULL`, hash, at);
  if (expired) {
    await db.transaction(async tx => {
      const session = await tx.get(`UPDATE sessions SET expiry_logged_at = ? WHERE id = ?
        AND revoked_at IS NULL AND expires_at <= ? AND expiry_logged_at IS NULL RETURNING user_id`, at, expired.id, at);
      if (session) await recordAuthEvent(tx, 'session.expired', { userId: session.user_id, at, ip, userAgent });
    });
  }
  throw unauthorized();
}

export async function logout(db, user, { ip, userAgent }) {
  const at = new Date().toISOString();
  await db.transaction(async tx => {
    const session = await tx.get(`UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL
      RETURNING user_id`, at, user.session_id);
    if (session) await recordAuthEvent(tx, 'logout', { userId: session.user_id, at, ip, userAgent });
  });
}

export async function memberships(db, userId) {
  return await db.all('SELECT site_id, role FROM accessible_site_members WHERE user_id = ? ORDER BY site_id', userId);
}
