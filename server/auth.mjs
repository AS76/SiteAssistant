import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { RepositoryError } from './repository.mjs';

const derive = promisify(scrypt);
const N = 16384, r = 8, p = 1;
export const SESSION_TTL = 7 * 24 * 60 * 60 * 1000;
export const tokenHash = token => createHash('sha256').update(token).digest('hex');
const unauthorized = () => new RepositoryError(401, 'A valid session is required.', 'AUTH_REQUIRED');
export const publicUser = user => ({ id: user.id, email: user.email, name: user.name });

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

export function createLoginLimiter({ now = Date.now } = {}) {
  const attempts = new Map();
  const window = 15 * 60 * 1000;
  return {
    reset: () => attempts.clear(),
    attempt(ip, email) {
      const at = now();
      // Opportunistic cleanup avoids retaining inactive keys indefinitely.
      for (const [key, times] of attempts) {
        const recent = times.filter(time => time > at - window);
        if (recent.length) attempts.set(key, recent); else attempts.delete(key);
      }
      const key = `${ip}|${email}`;
      const times = attempts.get(key) || [];
      if (times.length >= 10) {
        const error = new RepositoryError(429, 'Too many login attempts.', 'RATE_LIMITED');
        error.retryAfter = Math.max(1, Math.ceil((times[0] + window - at) / 1000));
        throw error;
      }
      times.push(at);
      attempts.set(key, times);
    },
  };
}

export async function login(db, input, { ip = '', userAgent = '', limiter }) {
  const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
  if (!email || email.length > 254 || typeof input.password !== 'string' ||
      !input.password || input.password.length > 1024) {
    throw new RepositoryError(400, 'Valid email and password are required.', 'VALIDATION_ERROR');
  }
  limiter.attempt(ip, email);
  const user = await db.get('SELECT * FROM users WHERE lower(email) = ?', email);
  // Unknown accounts still incur one scrypt calculation, without creating a user.
  const encoded = user?.password_algo === 'scrypt' ? user.password_hash
    : `scrypt$${N}$${r}$${p}$${'0'.repeat(32)}$${'0'.repeat(128)}`;
  const valid = await verifyPassword(input.password, encoded);
  if (!valid || !user || user.disabled_at) {
    throw new RepositoryError(401, 'Invalid email or password.', 'INVALID_CREDENTIALS');
  }
  const token = randomBytes(32).toString('base64url');
  const at = new Date();
  await db.transaction(async tx => {
    // A reset may finish while scrypt runs: serialize session creation with
    // password writers so an old credential cannot resurrect a revoked login.
    const current = await tx.get(`UPDATE users SET id = id
      WHERE id = ? AND password_hash = ? AND disabled_at IS NULL RETURNING id`, user.id, user.password_hash);
    if (!current) throw new RepositoryError(401, 'Invalid email or password.', 'INVALID_CREDENTIALS');
    await tx.run(`INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at, user_agent, ip)
      VALUES (?, ?, ?, ?, ?, ?, ?)`, randomUUID(), user.id, tokenHash(token), at.toISOString(),
    new Date(at.getTime() + SESSION_TTL).toISOString(), userAgent.slice(0, 1000), ip);
  });
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

export async function authenticate(db, cookie = '') {
  const tokens = cookie.split(';').map(part => part.trim()).filter(part => part.startsWith('sa_session='));
  if (tokens.length !== 1) throw unauthorized();
  const token = tokens[0].slice('sa_session='.length);
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw unauthorized();
  const row = await db.get(`SELECT u.id, u.email, u.name, u.password_change_required, s.id AS session_id
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ? AND u.disabled_at IS NULL`,
  tokenHash(token), new Date().toISOString());
  if (!row) throw unauthorized();
  return row;
}

export async function memberships(db, userId) {
  return await db.all('SELECT site_id, role FROM site_members WHERE user_id = ? ORDER BY site_id', userId);
}
