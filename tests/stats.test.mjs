import test from 'node:test';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { recordAuthEvent } from '../server/auth-events.mjs';
import { accessStats } from '../server/stats.mjs';
import { openSqliteTestDb } from './helpers/db.mjs';
import { database } from './helpers/procurement.mjs';

const run = promisify(execFile);
const root = new URL('../', import.meta.url);
const script = fileURLToPath(new URL('../server/stats.mjs', import.meta.url));
const from = '2026-01-02', to = '2026-01-04';
const first = '00000000-0000-4000-8000-000000000001';
const second = '00000000-0000-4000-8000-000000000002';
const expected = {
  total_accesses: 3,
  distinct_users: 2,
  accesses_by_day: { '2026-01-02': 2, '2026-01-04': 1 },
  last_access_by_user: [
    { user_id: first, email: 'synthetic@example.invalid', last_access: '2026-01-04T23:59:59.999Z' },
    { user_id: second, email: null, last_access: '2026-01-02T18:30:00.000Z' },
  ],
  failures: 2,
};

async function seedEvents(db) {
  await db.run(`INSERT INTO users (id, email, name, password_hash, password_algo, created_at)
    VALUES (?, ?, ?, 'unused', 'scrypt', ?)`,
    first, 'synthetic@example.invalid', 'Synthetic stats user', '2026-01-01T00:00:00.000Z');
  const events = [
    ['login.success', first, '2026-01-01T23:59:59.999Z'],
    ['login.success', first, '2026-01-02T00:00:00.000Z'],
    ['login.success', second, '2026-01-02T18:30:00.000Z'],
    ['login.failure', null, '2026-01-02T21:00:00.000Z'],
    ['login.failure', randomUUID(), '2026-01-03T21:00:00.000Z'],
    ['session.expired', first, '2026-01-03T10:00:00.000Z'],
    ['webauthn.authentication', first, '2026-01-04T23:59:59.999Z'],
    ['login.success', first, '2026-01-04T23:59:59.999Z'],
    ['login.success', second, '2026-01-05T00:00:00.000Z'],
    ['login.failure', null, '2026-01-05T00:00:00.000Z'],
  ];
  for (const [event, userId, at] of events) {
    await recordAuthEvent(db, event, { userId, at, outcome: event === 'login.failure' ? 'failure' : 'success' });
  }
}

function cli(path, start = from, end = to) {
  return run(process.execPath, [script, '--from', start, '--to', end],
    { env: { ...process.env, DB_DRIVER: 'sqlite', DATA_DIR: path } });
}

test('package.json exposes stats through npm run stats', async t => {
  const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
  t.assert.strictEqual(manifest.scripts.stats, 'node server/stats.mjs');
});

test('stats CLI reports successful access, last access per user and failures for inclusive UTC dates', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'siteassistant-stats-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'stats.db');
  const fixture = await openSqliteTestDb(path);
  try { await seedEvents(fixture.db); }
  finally { await fixture.close(); }
  const before = await stat(path);
  const direct = await cli(path);
  t.assert.deepStrictEqual(JSON.parse(direct.stdout), expected);
  const npm = await run('npm', ['run', 'stats', '--', '--from', from, '--to', to], {
    cwd: root,
    env: { ...process.env, DB_DRIVER: 'sqlite', DATA_DIR: path },
  });
  t.assert.strictEqual(npm.stdout.slice(-direct.stdout.length), direct.stdout);
  t.assert.strictEqual((await stat(path)).mtimeMs, before.mtimeMs);
  t.assert.deepStrictEqual(JSON.parse((await cli(path, '2026-01-06', '2026-01-06')).stdout), {
    total_accesses: 0, distinct_users: 0, accesses_by_day: {}, last_access_by_user: [], failures: 0,
  });
});

test('stats CLI rejects invalid ranges and leaves missing databases untouched', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'siteassistant-stats-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'missing.db');
  await t.assert.rejects(() => cli(path, '2026-02-30', '2026-03-01'), { code: 1, stderr: /Usage: / });
  await t.assert.rejects(() => cli(path, to, from), { code: 1, stderr: /Usage: / });
  await t.assert.rejects(() => cli(path), { code: 1, stderr: /Unable to read authentication statistics/ });
  await t.assert.rejects(() => stat(path), { code: 'ENOENT' });
});

test('stats produce the same report under PostgreSQL semantics in PGlite', async t => {
  const db = await database(t, 'pg');
  await seedEvents(db);
  t.assert.deepStrictEqual(await accessStats(db, { from: new Date(from), to: new Date(to) }), expected);
});
