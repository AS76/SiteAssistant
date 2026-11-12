import { stat } from 'node:fs/promises';
import { SqliteStorage, PgStorage } from './storage/index.mjs';
import { getSite, WRITE_ROLES } from './repository.mjs';

const normaliseName = name => name.trim().replace(/\s+/gu, ' ').toLowerCase();
const assignments = [['executor', 'executor_id', WRITE_ROLES], ['verifier', 'verifier_id', ['owner', 'verifier']]];

// Counts describe unlinked assignment fields, so a task can contribute twice.
// Existing links, name snapshots, submission identity and task history stay untouched.
export async function recogniseResponsibles(db, siteId, { apply = false } = {}) {
  return await db.transaction(async tx => {
    await getSite(tx, siteId);
    const members = await tx.all(`SELECT u.id AS user_id, u.name, m.role FROM site_members m
      JOIN users u ON u.id = m.user_id WHERE m.site_id = ? AND u.disabled_at IS NULL
      ORDER BY u.id`, siteId);
    const names = new Map();
    for (const member of members) {
      const key = normaliseName(member.name);
      if (!names.has(key)) names.set(key, []);
      names.get(key).push(member);
    }
    const tasks = await tx.all(`SELECT id, executor, verifier, executor_id, verifier_id FROM tasks
      WHERE site_id = ? AND (executor_id IS NULL OR verifier_id IS NULL) ORDER BY id`, siteId);
    const result = { matched: 0, unmatched: 0, ambiguous: 0, linked: 0, ambiguities: [] };
    for (const task of tasks) {
      const pending = [];
      for (const [field, column, roles] of assignments) {
        if (task[column] !== null) continue;
        const candidates = names.get(normaliseName(task[field])) || [];
        if (candidates.length > 1) {
          result.ambiguous++;
          result.ambiguities.push({ task_id: task.id, field, name: task[field], candidates, reason: 'multiple_members' });
        } else if (candidates.length === 1 && roles.includes(candidates[0].role)) {
          pending.push({ field, column, member: candidates[0] });
        } else result.unmatched++;
      }
      const executorId = task.executor_id ?? pending.find(item => item.field === 'executor')?.member.user_id;
      const verifierId = task.verifier_id ?? pending.find(item => item.field === 'verifier')?.member.user_id;
      if (executorId && executorId === verifierId) {
        for (const item of pending) {
          result.ambiguous++;
          result.ambiguities.push({ task_id: task.id, field: item.field, name: task[item.field],
            candidates: [item.member], reason: 'same_person' });
        }
        continue;
      }
      result.matched += pending.length;
      if (apply && pending.length) {
        // Compare-and-set protects both name snapshots and already linked identities.
        const linkedColumns = ['executor_id', 'verifier_id'];
        const { rowCount } = await tx.run(`UPDATE tasks SET ${pending.map(item => `${item.column} = ?`).join(', ')}
          WHERE id = ? AND executor = ? AND verifier = ?
          AND ${linkedColumns.map(column => task[column] === null ? `${column} IS NULL` : `${column} = ?`).join(' AND ')}`,
        ...pending.map(item => item.member.user_id), task.id, task.executor, task.verifier,
        ...linkedColumns.filter(column => task[column] !== null).map(column => task[column]));
        result.linked += rowCount * pending.length;
      }
    }
    return result;
  });
}

export function parseArgs(args) {
  const options = { apply: false };
  let hasApply = false;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--apply' && !hasApply) { options.apply = true; hasApply = true; }
    else if (args[index] === '--site' && options.siteId === undefined && args[index + 1] && !args[index + 1].startsWith('--')) {
      options.siteId = args[++index].trim();
    } else throw new Error('Usage: node server/recognise-responsibles.mjs --site <site_id> [--apply]');
  }
  if (!options.siteId) throw new Error('--site is required.');
  return options;
}

export function formatSummary(result, { apply = false } = {}) {
  return [apply ? 'Apply (assignment fields)' : 'Dry run (assignment fields; no changes)',
    `matched: ${result.matched}`, `unmatched: ${result.unmatched}`, `ambiguous: ${result.ambiguous}`,
    ...(apply ? [`linked: ${result.linked}`] : []),
    ...result.ambiguities.map(item => `Ambiguous: ${JSON.stringify(item)}`)].join('\n') + '\n';
}

async function openRecognitionDb() {
  // Open existing storage directly: this manual operation never runs migrations.
  const driver = process.env.DB_DRIVER || 'sqlite';
  if (driver === 'pg') return new PgStorage(process.env.DATABASE_URL, { schema: 'app' });
  if (driver !== 'sqlite') throw new Error('Unsupported database driver.');
  const path = process.env.DATA_DIR || './data/app.db';
  if (!(await stat(path)).isFile()) throw new Error('An existing database file is required.');
  const db = new SqliteStorage(path);
  await db.exec('PRAGMA foreign_keys = ON;');
  return db;
}

export async function runCli(args, { openStorage = openRecognitionDb, stdout = process.stdout, stderr = process.stderr } = {}) {
  let options, db, exitCode = 0;
  try { options = parseArgs(args); }
  catch (error) { stderr.write(`${error.message}\n`); return 2; }
  try {
    db = await openStorage();
    stdout.write(formatSummary(await recogniseResponsibles(db, options.siteId, options), options));
  } catch (error) {
    stderr.write(error.code === 'SITE_NOT_FOUND' ? 'Site not found.\n' : 'Unable to recognise responsibles.\n');
    exitCode = 1;
  } finally {
    if (db) {
      try { await db.close(); }
      catch { stderr.write('Unable to close database.\n'); exitCode = 1; }
    }
  }
  return exitCode;
}

if (import.meta.main) process.exitCode = await runCli(process.argv.slice(2));
