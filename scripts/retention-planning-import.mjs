import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadPolicy, purge } from '../server/import-retention.mjs';

const CONFIRM = 'planning_import_retention';

// No migrations or schema creation: this command operates only on an existing database.
async function openDatabase() {
  const driver = process.env.DB_DRIVER || 'sqlite';
  if (driver === 'pg') {
    const { PgStorage } = await import('../server/storage/pg.mjs');
    return new PgStorage(undefined, { schema: 'app' });
  }
  if (driver !== 'sqlite') throw new Error('Unknown DB_DRIVER.');
  const path = process.env.DATA_DIR || './data/app.db';
  await access(path);
  const { SqliteStorage } = await import('../server/storage/sqlite.mjs');
  return new SqliteStorage(path);
}

export async function main(argv = process.argv.slice(2), {
  open = openDatabase, readPolicy = loadPolicy, now = new Date(),
  write = line => console.log(line), error = line => console.error(line),
} = {}) {
  let apply = false, dryRun = false, confirm, json = false;
  try {
    for (let i = 0; i < argv.length; i++) {
      switch (argv[i]) {
        case '--apply': apply = true; break;
        case '--dry-run': dryRun = true; break;
        case '--confirm': confirm = argv[++i]; break;
        case '--json': json = true; break;
        default: throw new Error('Unknown argument. Use [--dry-run | --apply --confirm planning_import_retention] [--json].');
      }
    }
    if (apply && confirm !== CONFIRM) throw new Error('--apply requires --confirm planning_import_retention.');
    if (apply && dryRun) throw new Error('--apply and --dry-run are mutually exclusive.');
    if (!apply && confirm !== undefined) throw new Error('--confirm requires --apply.');
  } catch (cause) { error(cause.message); return 2; }

  let db;
  try {
    const policy = await readPolicy(undefined, { now });
    db = await open();
    const print = (label, result) => {
      write(`${label}: scanned=${result.scanned} expired=${result.expired} deletable=${result.deletable} excluded=${result.excluded.length} bytesFreed=${result.bytesFreed}`);
      write(`Exceptions: active=${result.exceptionCounts.active} expired=${result.exceptionCounts.expired} malformed=${result.exceptionCounts.malformed}`);
      for (const item of result.excluded) write(`excluded id=${item.id} reason=${item.reason}`);
    };
    const before = await purge(db, { now, policy, dryRun: true });
    print(apply ? 'Before apply (dry-run)' : 'Dry-run', before);
    const result = apply ? await purge(db, { now, policy, dryRun: false }) : before;
    if (apply) print('After apply', result);
    if (json) write(JSON.stringify(result));
    return 0;
  } catch (cause) { error(cause.message); return 1; }
  finally { if (db) await db.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main();
}
