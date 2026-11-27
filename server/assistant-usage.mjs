import { randomUUID } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import defaultPrices from '../config/assistant-prices.json' with { type: 'json' };
import { RepositoryError, requireRole } from './repository.mjs';

const NANOUSD_PER_USD = 1_000_000_000;
const THRESHOLDS = Object.freeze({ warning: 10, critical: 18, blocked: 25 });
// A crashed process must not hold the site indefinitely. The chat timeout is at most 60 s.
const PENDING_MAX_AGE_MS = 65_000;

const nanosPerToken = price => Math.round(price * NANOUSD_PER_USD);
const validPrice = price => typeof price === 'number' && price >= 0 &&
  Number.isSafeInteger(nanosPerToken(price)) && nanosPerToken(price) / NANOUSD_PER_USD === price;

export function assistantPrices(raw = process.env.ASSISTANT_PRICES_USD_PER_TOKEN) {
  try {
    const overrides = raw === undefined ? {} : JSON.parse(raw);
    if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides) ||
        Object.values(overrides).some(price => !validPrice(price?.input) || !validPrice(price?.output))) {
      throw new Error('Expected input and output prices per model.');
    }
    return new Map(Object.entries({ ...defaultPrices, ...overrides }));
  } catch {
    throw new RepositoryError(503, 'Assistant pricing configuration is invalid.', 'ASSISTANT_NOT_CONFIGURED');
  }
}

function monthBounds(now) {
  const year = now.getUTCFullYear(), month = now.getUTCMonth();
  return [new Date(Date.UTC(year, month, 1)).toISOString(), new Date(Date.UTC(year, month + 1, 1)).toISOString()];
}

export function assistantUsageStatus(costNanousd) {
  for (const status of ['blocked', 'critical', 'warning']) {
    if (costNanousd >= THRESHOLDS[status] * NANOUSD_PER_USD) return status;
  }
  return 'normal';
}

async function monthlyUsage(db, siteId, now) {
  const [start, end] = monthBounds(now);
  const row = await db.get(`SELECT SUM(cost_nanousd) AS cost, COUNT(*) AS requests,
      COUNT(cost_nanousd) AS priced_requests
    FROM assistant_usage WHERE site_id = ? AND requested_at >= ? AND requested_at < ?`, siteId, start, end);
  const requests = Number(row.requests);
  return {
    month: start.slice(0, 7),
    estimated_cost_usd: requests && row.cost == null ? null : Number(row.cost) / NANOUSD_PER_USD,
    requests,
    unpriced_requests: requests - Number(row.priced_requests),
    status: assistantUsageStatus(Number(row.cost)),
    thresholds_usd: THRESHOLDS,
  };
}

export async function getAssistantUsage(db, { siteId, user, now = new Date() }) {
  if (!user?.id) throw new RepositoryError(401, 'Authentication required.', 'UNAUTHENTICATED');
  if (typeof siteId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(siteId)) {
    throw new RepositoryError(400, 'site_id must be a UUID.', 'VALIDATION_ERROR');
  }
  siteId = siteId.toLowerCase();
  await requireRole(db, siteId, user, ['owner']);
  return await monthlyUsage(db, siteId, now);
}

export async function assertAssistantBudget(db, siteId, now = new Date()) {
  if ((await monthlyUsage(db, siteId, now)).status === 'blocked') {
    throw new RepositoryError(429, 'Monthly assistant limit reached. Try again next month.', 'ASSISTANT_BUDGET_EXCEEDED');
  }
}

export async function beginAssistantUsage(db, { siteId, userId, model, signal }) {
  const id = randomUUID();
  while (true) {
    signal.throwIfAborted();
    const admitted = await db.transaction(async tx => {
      const now = new Date();
      // Serialize admission across connections without holding a transaction during the network call.
      await tx.run(`UPDATE assistant_usage SET reason = 'provider_response_unavailable'
        WHERE site_id = ? AND reason = 'provider_pending' AND requested_at <= ?`,
      siteId, new Date(now.getTime() - PENDING_MAX_AGE_MS).toISOString());
      const { rowCount } = await tx.run(`INSERT INTO assistant_usage
        (id, site_id, user_id, requested_at, model, reason) VALUES (?, ?, ?, ?, ?, 'provider_pending')
        ON CONFLICT (site_id) WHERE reason = 'provider_pending' DO NOTHING`,
      id, siteId, userId, now.toISOString(), model);
      if (!rowCount) return false;
      // Read after acquiring the slot so a preceding call's committed cost is included.
      await assertAssistantBudget(tx, siteId, now);
      signal.throwIfAborted();
      return true;
    });
    if (admitted) return id;
    await wait(200, undefined, { signal });
  }
}

const validTokens = count => Number.isSafeInteger(count) && count >= 0;

export async function finishAssistantUsage(db, id, { payload, requestedModel, prices, failure }) {
  const model = typeof payload?.model === 'string' && payload.model ? payload.model : requestedModel;
  const usage = payload?.usage;
  const hasTokens = validTokens(usage?.prompt_tokens) && validTokens(usage?.completion_tokens);
  const input = hasTokens ? usage.prompt_tokens : null;
  const output = hasTokens ? usage.completion_tokens : null;
  const price = prices.get(model) ?? prices.get(requestedModel);
  const estimate = hasTokens && price ? input * nanosPerToken(price.input) + output * nanosPerToken(price.output) : null;
  const cost = Number.isSafeInteger(estimate) ? estimate : null;
  const reason = failure ?? (usage == null ? 'usage_missing' : !hasTokens ? 'usage_invalid'
    : !price ? 'price_missing' : cost === null ? 'cost_out_of_range' : null);
  await db.run(`UPDATE assistant_usage
    SET model = ?, input_tokens = ?, output_tokens = ?, cost_nanousd = ?, reason = ? WHERE id = ?`,
  model, input, output, cost, reason, id);
}
