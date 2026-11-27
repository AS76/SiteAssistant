import { isIP } from 'node:net';

export function normalizeIp(address) {
  const version = isIP(address);
  if (version === 4) return address;
  if (version !== 6 || address.includes('%')) return null;
  const normalized = new URL(`http://[${address}]`).hostname.slice(1, -1);
  const mapped = /^::ffff:([\da-f]+):([\da-f]+)$/i.exec(normalized);
  if (!mapped) return normalized;
  const [high, low] = mapped.slice(1).map(part => parseInt(part, 16));
  return [high >> 8, high & 255, low >> 8, low & 255].join('.');
}

export function createClientIpResolver(trustedProxyIps = '') {
  const trusted = new Set(trustedProxyIps.split(',').map(ip => ip.trim()).filter(Boolean).map(ip => {
    const normalized = normalizeIp(ip);
    if (!normalized) throw new TypeError('TRUSTED_PROXY_IPS must contain comma-separated IP addresses.');
    return normalized;
  }));
  return request => {
    const peer = normalizeIp(request.socket?.remoteAddress) ?? '';
    const forwarded = request.headers['x-forwarded-for'];
    if (!trusted.has(peer) || typeof forwarded !== 'string') return peer;
    // Walk from the socket toward the client, stopping at the first untrusted hop.
    const hops = forwarded.split(',');
    for (let index = hops.length - 1; index >= 0; index--) {
      const hop = normalizeIp(hops[index].trim());
      if (!hop) return peer;
      if (!trusted.has(hop)) return hop;
    }
    return peer;
  };
}

export function createRateLimiter({ windowMs = 60000, max, now = Date.now } = {}) {
  if (!Number.isSafeInteger(windowMs) || windowMs < 1 || !Number.isSafeInteger(max) || max < 1) {
    throw new TypeError('Rate limit and window must be positive safe integers.');
  }
  const buckets = new Map();
  let lastSweep;
  return {
    attempt(key) {
      const at = now(), cutoff = at - windowMs;
      // Retire idle keys without keeping a timer alive or scanning on every request.
      if (lastSweep === undefined || at - lastSweep >= windowMs) {
        for (const [key, hits] of buckets) {
          if (hits.at(-1) <= cutoff) buckets.delete(key);
        }
        lastSweep = at;
      }
      const hits = (buckets.get(key) || []).filter(hit => hit > cutoff);
      if (hits.length >= max) {
        buckets.set(key, hits);
        return { allowed: false, retryAfter: Math.max(1, Math.ceil((hits[0] + windowMs - at) / 1000)), remaining: 0 };
      }
      hits.push(at);
      buckets.set(key, hits);
      return { allowed: true, retryAfter: 0, remaining: max - hits.length };
    },
    reset() { buckets.clear(); lastSweep = undefined; },
  };
}
