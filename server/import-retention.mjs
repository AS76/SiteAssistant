import { readFile } from 'node:fs/promises';
import { FAMILIES } from './planning-import.mjs';

const DAY = 86_400_000;
export const DEFAULT_POLICY = Object.freeze({
  default_days: 90,
  max_days: 90,
  family_overrides: Object.freeze({ employees: 30, work_days: 30 }),
  site_overrides: Object.freeze({}),
  exceptions: Object.freeze([]),
});
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const invalid = message => { throw new Error(`Invalid import retention policy: ${message}`); };
function instant(value) {
  if (!(value instanceof Date) && (typeof value !== 'string' || !/(?:Z|[+-]\d\d:\d\d)$/.test(value))) {
    throw new Error('Retention timestamps require an explicit time zone.');
  }
  const result = new Date(value).getTime();
  if (!Number.isFinite(result)) throw new Error('Invalid retention timestamp.');
  return result;
}
function untilInstant(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\d$/.test(value)) invalid('exception until must be YYYY-MM-DD.');
  const result = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(result) || new Date(result).toISOString().slice(0, 10) !== value) invalid('invalid exception until date.');
  return result;
}
function keys(value, allowed, label) {
  if (!object(value)) invalid(`${label} must be an object.`);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) invalid(`unknown ${label} field: ${key}.`);
}

export function validatePolicy(input = DEFAULT_POLICY, { now = new Date() } = {}) {
  instant(now);
  keys(input, Object.keys(DEFAULT_POLICY), 'policy');
  const policy = structuredClone({ ...DEFAULT_POLICY, ...input });
  if (!Number.isInteger(policy.max_days) || policy.max_days < 1 || policy.max_days > 90) invalid('max_days must be an integer from 1 to 90.');
  const days = (value, label) => {
    if (!Number.isInteger(value) || value < 1 || value > policy.max_days) invalid(`${label} must be an integer from 1 to max_days.`);
  };
  days(policy.default_days, 'default_days');
  keys(policy.family_overrides, Object.keys(FAMILIES), 'family_overrides');
  for (const [family, value] of Object.entries(policy.family_overrides)) days(value, `family_overrides.${family}`);
  if (!object(policy.site_overrides)) invalid('site_overrides must be an object.');
  for (const [site, override] of Object.entries(policy.site_overrides)) {
    if (!uuid(site)) invalid('site_overrides requires site UUIDs.');
    keys(override, ['days', 'reason'], 'site override');
    days(override.days, 'site override days');
    if (!nonempty(override.reason)) invalid('site override requires a reason.');
  }
  const siteOverrides = {};
  for (const [site, override] of Object.entries(policy.site_overrides)) {
    if (Object.hasOwn(siteOverrides, site.toLowerCase())) invalid('duplicate site UUID.');
    siteOverrides[site.toLowerCase()] = override;
  }
  policy.site_overrides = siteOverrides;
  if (!Array.isArray(policy.exceptions)) invalid('exceptions must be an array.');
  for (const exception of policy.exceptions) {
    keys(exception, ['site_id', 'family', 'until', 'reason', 'approved_by'], 'exception');
    if (!uuid(exception.site_id)) invalid('exception requires a site UUID.');
    if (Object.hasOwn(exception, 'family') && !Object.hasOwn(FAMILIES, exception.family)) invalid('exception family must be known when present.');
    if (!nonempty(exception.reason) || !nonempty(exception.approved_by)) invalid('exception requires reason and approved_by.');
    untilInstant(exception.until);
    exception.site_id = exception.site_id.toLowerCase();
  }
  return policy;
}

export async function loadPolicy(path = new URL('../config/import-retention.json', import.meta.url), options) {
  let input;
  try { input = JSON.parse(await readFile(path, 'utf8')); }
  catch (error) {
    if (error instanceof SyntaxError) {
      throw new SyntaxError('Invalid import retention policy: expected valid JSON.', { cause: error });
    }
    if (error.code !== 'ENOENT') throw error;
  }
  return validatePolicy(input, options);
}

function familySummary(policy, family) {
  const override = Object.hasOwn(policy.family_overrides, family) ? policy.family_overrides[family] : policy.default_days;
  return { baseDays: Math.min(policy.default_days, override), expired: 0, deletable: 0, excluded: 0, windows: {} };
}

// Only payload-bearing receipts are candidates. History and identity bindings remain intact.
export async function purge(db, { now = new Date(), policy = DEFAULT_POLICY, dryRun = true } = {}) {
  if (typeof dryRun !== 'boolean') throw new Error('dryRun must be a boolean.');
  const time = instant(now);
  const validated = validatePolicy(policy, { now });
  const activeExceptions = validated.exceptions.filter(item => untilInstant(item.until) > time);
  const exceptionCounts = {
    active: activeExceptions.length,
    expired: validated.exceptions.length - activeExceptions.length,
    malformed: 0,
  };
  return db.transaction(async tx => {
    const rows = await tx.all(`SELECT id, site_id, family, created_at, octet_length(file_data) AS bytes
      FROM planning_import_runs WHERE file_data IS NOT NULL ORDER BY id`);
    const families = new Set(Object.keys(FAMILIES));
    for (const row of rows) families.add(row.family);
    const byFamily = Object.fromEntries(Array.from(families, family => [family, familySummary(validated, family)]));
    const result = { scanned: rows.length, expired: 0, deletable: 0, excluded: [], bytesFreed: 0, exceptionCounts, byFamily };
    const candidates = [];
    for (const row of rows) {
      const site = row.site_id.toLowerCase();
      const family = byFamily[row.family];
      const days = Math.min(family.baseDays, validated.site_overrides[site]?.days ?? validated.default_days);
      const window = family.windows[days] ??= { expired: 0, deletable: 0, excluded: 0 };
      if (time - instant(row.created_at) <= days * DAY) continue;
      result.expired++;
      family.expired++;
      window.expired++;
      const exceptions = activeExceptions.filter(item => item.site_id === site
        && (!Object.hasOwn(item, 'family') || item.family === row.family));
      if (exceptions.length) {
        family.excluded++;
        window.excluded++;
        result.excluded.push({ id: row.id, reason: exceptions.map(item => item.reason).join('; ') });
      } else {
        family.deletable++;
        window.deletable++;
        candidates.push(row);
      }
    }
    result.deletable = candidates.length;
    if (!dryRun) for (const row of candidates) {
      // The null guard also prevents concurrent purges from counting the same bytes twice.
      const updated = await tx.all(`UPDATE planning_import_runs SET file_data = NULL
        WHERE id = ? AND file_data IS NOT NULL RETURNING id`, row.id);
      if (updated.length) result.bytesFreed += Number(row.bytes);
    }
    return result;
  });
}
