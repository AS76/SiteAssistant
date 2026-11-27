import { randomUUID } from 'node:crypto';
import { normalizeIp } from './limits.mjs';

export function truncateIp(address) {
  const ip = normalizeIp(address);
  if (!ip) return null;
  if (!ip.includes(':')) return `${ip.slice(0, ip.lastIndexOf('.'))}.0`;

  const [left, right] = ip.split('::');
  const leading = left ? left.split(':') : [];
  const trailing = right ? right.split(':') : [];
  const groups = [...leading, ...Array(8 - leading.length - trailing.length).fill('0'), ...trailing];
  const prefix = new URL(`http://[${groups.slice(0, 3).join(':')}::]`).hostname.slice(1, -1);
  return `${prefix}/48`;
}

export async function recordAuthEvent(db, event, {
  userId = null, at = new Date().toISOString(), ip, userAgent = '', outcome = 'success', detail = {},
} = {}) {
  await db.run(`INSERT INTO auth_events (id, user_id, event, outcome, ip, user_agent, detail_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, randomUUID(), userId, event, outcome, truncateIp(ip),
  userAgent.slice(0, 1000), JSON.stringify(detail), at);
}

export function recordLoginFailure(db, reason, { userId, ip, userAgent, at, method }) {
  return recordAuthEvent(db, 'login.failure', {
    userId, ip, userAgent, at, outcome: 'failure', detail: { method, reason },
  });
}
