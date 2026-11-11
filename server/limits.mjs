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
