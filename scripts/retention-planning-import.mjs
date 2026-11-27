import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { loadPolicy, purge } from '../server/import-retention.mjs';

const CONFIRM = 'planning_import_retention';

// No migrations or schema creation: this command operates only on an existing database.
async function openDatabase({ dryRun }) {
  const driver = process.env.DB_DRIVER || 'sqlite';
  if (driver === 'pg') {
    const { PgStorage } = await import('../server/storage/pg.mjs');
    return new PgStorage(undefined, { schema: 'app' });
  }
  if (driver !== 'sqlite') throw new Error('Unknown DB_DRIVER.');
  const path = process.env.DATA_DIR || './data/app.db';
  await access(path);
  const { SqliteStorage } = await import('../server/storage/sqlite.mjs');
  return new SqliteStorage(path, { readOnly: dryRun });
}

function referenceDate(from, now) {
  if (from === undefined) return now;
  const reference = new Date(`${from}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !Number.isFinite(reference.getTime()) || reference.toISOString().slice(0, 10) !== from) {
    throw new Error('--from must be a valid date in YYYY-MM-DD format.');
  }
  return reference;
}

const counts = ({ expired, deletable, excluded }) => `expired=${expired} deletable=${deletable} excluded=${excluded}`;

export async function main(argv = process.argv.slice(2), {
  open = openDatabase, readPolicy = loadPolicy, now = new Date(),
  write = line => console.log(line), error = line => console.error(line),
} = {}) {
  let flags, reference;
  try {
    ({ values: flags } = parseArgs({ args: argv, options: {
      apply: { type: 'boolean' }, 'dry-run': { type: 'boolean' }, from: { type: 'string' },
      confirm: { type: 'string' }, json: { type: 'boolean' },
    } }));
    if (flags.apply && flags['dry-run']) throw new Error('--apply and --dry-run are mutually exclusive.');
    // Accept the confirmation token used by older invocations.
    if (flags.confirm !== undefined && (!flags.apply || flags.confirm !== CONFIRM)) {
      throw new Error('--confirm planning_import_retention can only be used with --apply.');
    }
    reference = referenceDate(flags.from, now);
  } catch (cause) { error(cause.message); return 2; }

  const dryRun = !flags.apply;
  let db;
  try {
    const policy = await readPolicy(undefined, { now: reference });
    const timestamp = new Date(reference).toISOString();
    db = await open({ dryRun });
    const result = await purge(db, { now: reference, policy, dryRun });
    write(`${dryRun ? 'Dry-run' : 'Apply'} reference=${timestamp} scanned=${result.scanned} ${counts({ ...result, excluded: result.excluded.length })} bytesFreed=${result.bytesFreed}`);
    const { active, expired, malformed } = result.exceptionCounts;
    write(`Exceptions: active=${active} expired=${expired} malformed=${malformed}`);
    for (const [family, summary] of Object.entries(result.byFamily)) {
      const windows = Object.entries(summary.windows);
      const days = windows.map(([windowDays]) => windowDays).join(',') || summary.baseDays;
      write(`${family} windowDays=${days} ${counts(summary)}`);
      if (windows.length > 1) for (const [windowDays, totals] of windows) {
        write(`  windowDays=${windowDays} ${counts(totals)}`);
      }
    }
    for (const item of result.excluded) write(`excluded id=${item.id} reason=${item.reason}`);
    if (flags.json) write(JSON.stringify({ reference: timestamp, ...result }));
    return 0;
  } catch (cause) { error(cause.message); return 1; }
  finally { if (db) await db.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main();
}
