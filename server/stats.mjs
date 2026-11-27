import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { SqliteStorage, PgStorage } from './storage/index.mjs';

const datePattern = /^(?!0000)\d{4}-\d{2}-\d{2}$/;
const dayMs = 24 * 60 * 60 * 1000;
const usage = 'Usage: node server/stats.mjs --from YYYY-MM-DD --to YYYY-MM-DD';

function parseDate(value) {
  if (!datePattern.test(value ?? '')) throw new Error(usage);
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new Error(usage);
  return date;
}

function parseRange(args) {
  let values;
  try {
    ({ values } = parseArgs({ args, options: {
      from: { type: 'string' }, to: { type: 'string' },
    } }));
  } catch {
    throw new Error(usage);
  }
  const from = parseDate(values.from);
  const to = parseDate(values.to);
  if (to < from) throw new Error(usage);
  return { from, to };
}

export async function accessStats(db, { from, to }) {
  const end = new Date(to.getTime() + dayMs).toISOString();
  // The last four-digit year has no following day in SQLite's timestamp format.
  const upperBound = end.startsWith('+') ? '<=' : '<';
  const upperTimestamp = end.startsWith('+') ? '9999-12-31T23:59:59.999Z' : end;
  const rows = await db.all(`SELECT a.event, a.user_id, a.created_at, u.email
    FROM auth_events a LEFT JOIN users u ON u.id = a.user_id
    WHERE a.event IN ('login.success', 'login.failure') AND a.created_at >= ? AND a.created_at ${upperBound} ?
    ORDER BY a.created_at, a.id`, from.toISOString(), upperTimestamp);

  let total = 0, failures = 0;
  const byDay = new Map(), byUser = new Map();
  for (const row of rows) {
    if (row.event === 'login.failure') {
      failures++;
      continue;
    }
    total++;
    const timestamp = new Date(row.created_at).toISOString();
    const day = timestamp.slice(0, 10);
    byDay.set(day, (byDay.get(day) ?? 0) + 1);
    if (row.user_id !== null) byUser.set(row.user_id, { user_id: row.user_id, email: row.email, last_access: timestamp });
  }
  return {
    total_accesses: total,
    distinct_users: byUser.size,
    accesses_by_day: Object.fromEntries(byDay),
    last_access_by_user: [...byUser.values()].sort((a, b) => a.user_id.localeCompare(b.user_id)),
    failures,
  };
}

async function main() {
  let range;
  try {
    range = parseRange(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
    return;
  }

  let db;
  try {
    const driver = process.env.DB_DRIVER || 'sqlite';
    if (driver === 'sqlite') db = new SqliteStorage(process.env.DATA_DIR || './data/app.db', { readOnly: true });
    else if (driver === 'pg') db = new PgStorage(undefined, { schema: 'app' });
    else throw new Error('Unsupported database driver.');
    console.log(JSON.stringify(await accessStats(db, range), null, 2));
  } catch {
    console.error('Unable to read authentication statistics from the configured database.');
    process.exitCode = 1;
  } finally {
    if (db) await db.close().catch(() => { console.error('Unable to close database.'); process.exitCode = 1; });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
