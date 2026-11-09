import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createUser, parseArgs, readPassword } from '../server/create-user.mjs';
import { verifyPassword } from '../server/auth.mjs';
import { openDb } from '../server/db.mjs';
import { createSite } from '../server/repository.mjs';
import { SqliteStorage } from '../server/storage/sqlite.mjs';
import { applyMigration } from '../server/migrations/index.mjs';
import { openTestDb } from './helpers/db.mjs';

const input = { email: 'person@example.invalid', name: 'Synthetic person', password: 'Synthetic-only-passphrase!' };

async function fixture(t) {
  const database = await openTestDb();
  t.after(database.close);
  return database.db;
}

test('createUser normalizes identity, stores a verifiable versioned hash and preserves the migration ledger', async t => {
  const db = await fixture(t);
  const before = await db.all('SELECT * FROM schema_migrations ORDER BY version');
  const count = await db.get('SELECT count(*) AS count FROM schema_migrations');
  const user = await createUser(db, { ...input, email: ' PERSON@EXAMPLE.INVALID ', name: ' Synthetic person ' });
  t.assert.deepStrictEqual(user, { id: user.id, email: input.email, name: input.name });
  const stored = await db.get('SELECT * FROM users WHERE id = ?', user.id);
  t.assert.strictEqual(stored.password_algo, 'scrypt');
  t.assert.match(stored.password_hash, /^scrypt\$16384\$8\$1\$/);
  t.assert.strictEqual(await verifyPassword(input.password, stored.password_hash), true);
  t.assert.strictEqual(await verifyPassword('Wrong password', stored.password_hash), false);
  t.assert.deepStrictEqual(await db.get('SELECT count(*) AS count FROM schema_migrations'), count);
  t.assert.deepStrictEqual(await db.all('SELECT * FROM schema_migrations ORDER BY version'), before);
});

test('createUser rejects duplicates including existing mixed-case email without writes', async t => {
  const db = await fixture(t);
  await createUser(db, input);
  for (const existingEmail of [input.email, 'Person@Example.Invalid']) {
    await db.run('UPDATE users SET email = ?', existingEmail);
    const before = await db.all('SELECT * FROM users');
    await t.assert.rejects(() => createUser(db, input), { message: 'A user with this email already exists.', exitCode: 1 });
    t.assert.deepStrictEqual(await db.all('SELECT * FROM users'), before);
  }
});

test('createUser assigns each supported role to the requested site', async t => {
  const db = await fixture(t);
  const site = await createSite(db, { code: 'SYNTH', name: 'Synthetic site' });
  for (const role of ['owner', 'editor', 'verifier', 'viewer']) {
    const user = await createUser(db, { ...input, email: `${role}@example.invalid`, siteCode: site.code, role });
    t.assert.deepStrictEqual({ ...await db.get('SELECT * FROM site_members WHERE user_id = ?', user.id) },
      { site_id: site.id, user_id: user.id, role });
  }
});

test('createUser leaves no user for a missing site or a failed membership write', async t => {
  const db = await fixture(t);
  await t.assert.rejects(() => createUser(db, { ...input, siteCode: 'MISSING', role: 'editor' }), /Site code does not exist/);
  t.assert.deepStrictEqual(await db.all('SELECT * FROM users'), []);
  const site = await createSite(db, { code: 'SYNTH', name: 'Synthetic site' });
  const failing = { transaction: fn => db.transaction(tx => fn({ ...tx, run: (sql, ...params) => {
    if (sql.includes('INSERT INTO site_members')) throw new Error('Synthetic membership failure');
    return tx.run(sql, ...params);
  } })) };
  await t.assert.rejects(() => createUser(failing, { ...input, siteCode: site.code, role: 'editor' }), /Synthetic membership failure/);
  t.assert.deepStrictEqual(await db.all('SELECT * FROM users'), []);
});

test('createUser rejects invalid identity, short passwords and incomplete or invalid roles', async t => {
  const db = await fixture(t);
  for (const change of [
    { email: 'missing-at' }, { email: '@example.invalid' }, { email: `${'a'.repeat(245)}@example.invalid` },
    { name: ' ' }, { name: 'x'.repeat(201) }, { password: 'short' }, { password: '😀'.repeat(6) },
    { siteCode: 'SYNTH' }, { role: 'owner' }, { siteCode: '', role: 'owner' }, { siteCode: 'SYNTH', role: 'admin' },
  ]) {
    await t.assert.rejects(() => createUser(db, { ...input, ...change }), { exitCode: 2 });
  }
  t.assert.deepStrictEqual(await db.all('SELECT * FROM users'), []);
  await createUser(db, { ...input, password: 'x'.repeat(12) });
});

const args = ['--email', input.email, '--name', input.name];

test('CLI parser requires values and paired site/role, rejects password argv and repeated or unknown flags', t => {
  t.assert.deepStrictEqual(parseArgs([...args, '--password-stdin', '--site', 'SYNTH', '--role', 'viewer']),
    { email: input.email, name: input.name, passwordStdin: true, siteCode: 'SYNTH', role: 'viewer' });
  for (const invalid of [[], ['--email', input.email], ['--name', input.name], [...args, '--site', 'SYNTH'],
    [...args, '--role', 'editor'], [...args, '--role', 'admin', '--site', 'SYNTH'], [...args, '--site'],
    [...args, '--site', '--role', 'viewer'], [...args, '--email', input.email], [...args, '--password'],
    [...args, '--password=value'], [...args, '--unknown'], [...args, '--password-stdin', '--password-stdin']]) {
    t.assert.throws(() => parseArgs(invalid), { exitCode: 2 });
  }
});

async function cliFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'siteassistant-create-user-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'app.db');
  const run = (argv, password = input.password) => {
    // Deliberately inherit no database URL, remote configuration or Node flags.
    const result = spawnSync(process.execPath, ['server/create-user.mjs', ...argv], {
      cwd: new URL('..', import.meta.url), input: `${password}\n`, encoding: 'utf8', timeout: 10000,
      env: { DB_DRIVER: 'sqlite', DATA_DIR: path, NODE_ENV: 'test', NODE_NO_WARNINGS: '1' },
    });
    t.assert.ifError(result.error);
    t.assert.strictEqual(result.signal, null);
    t.assert.ok(!`${result.stdout}${result.stderr}`.includes(password));
    return result;
  };
  return { path, run };
}

test('CLI child creates on SQLite, reports migrations once, preserves the ledger and never prints passwords', async t => {
  const { path, run } = await cliFixture(t);
  const first = run([...args, '--password-stdin']);
  t.assert.strictEqual(first.status, 0);
  t.assert.match(first.stdout, /^Created user person@example\.invalid \([a-f0-9-]{36}\)\n$/);
  t.assert.strictEqual(first.stderr, 'migrations applied\n');
  let db = await openDb(path, { driver: 'sqlite' });
  const before = await db.all('SELECT * FROM schema_migrations ORDER BY version');
  const stored = await db.get('SELECT * FROM users');
  t.assert.strictEqual(await verifyPassword(input.password, stored.password_hash), true);
  await createSite(db, { code: 'SYNTH', name: 'Synthetic site' });
  await db.close();
  const duplicate = run([...args, '--password-stdin']);
  t.assert.strictEqual(duplicate.status, 1);
  t.assert.strictEqual(duplicate.stdout, '');
  t.assert.strictEqual(duplicate.stderr, 'A user with this email already exists.\n');
  const assigned = run(['--email', ' ROLE@EXAMPLE.INVALID ', '--name', input.name, '--password-stdin', '--site', 'SYNTH', '--role', 'editor']);
  t.assert.strictEqual(assigned.status, 0);
  t.assert.match(assigned.stdout, /^Created user role@example\.invalid \([a-f0-9-]{36}\)\nRole editor on site SYNTH\n$/);
  t.assert.strictEqual(assigned.stderr, '');
  db = await openDb(path, { driver: 'sqlite' });
  try {
    t.assert.deepStrictEqual(await db.all('SELECT * FROM schema_migrations ORDER BY version'), before);
    t.assert.strictEqual((await db.all('SELECT * FROM users')).length, 2);
    t.assert.strictEqual((await db.get('SELECT role FROM site_members')).role, 'editor');
  } finally { await db.close(); }
});

test('CLI child rejects invalid arguments, piped input without opt-in, short passwords and missing sites', async t => {
  const { path, run } = await cliFixture(t);
  for (const invalid of [[], args, [...args, '--site', 'SYNTH'], [...args, '--role', 'owner'],
    [...args, '--site'], [...args, '--password'], [...args, '--name'],
    [...args, '--site', 'SYNTH', '--role', 'invalid']]) {
    const result = run(invalid);
    t.assert.strictEqual(result.status, 2);
    t.assert.strictEqual(result.stdout, '');
  }
  const short = run([...args, '--password-stdin'], 'short-only');
  t.assert.strictEqual(short.status, 2);
  t.assert.strictEqual(short.stdout, '');
  const missing = run([...args, '--password-stdin', '--site', 'MISSING', '--role', 'viewer']);
  t.assert.strictEqual(missing.status, 1);
  t.assert.strictEqual(missing.stdout, '');
  t.assert.match(missing.stderr, /Site code does not exist/);
  const db = await openDb(path, { driver: 'sqlite' });
  try { t.assert.deepStrictEqual(await db.all('SELECT * FROM users'), []); }
  finally { await db.close(); }
});

test('CLI applies pending migrations normally and retains earlier ledger rows and site data', async t => {
  const { path, run } = await cliFixture(t);
  let db = new SqliteStorage(path);
  await db.exec('CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  for (const file of ['001_init.sql', '002_operational_day.sql', '003_idempotency_keys.sql', '004_physical_types.sql']) {
    await applyMigration(db, file, { driver: 'sqlite' });
    await db.run('INSERT INTO schema_migrations VALUES (?, ?)', file.slice(0, 3), '2026-01-01T00:00:00.000Z');
  }
  await createSite(db, { code: 'SYNTH', name: 'Synthetic site' });
  const before = await db.all('SELECT * FROM schema_migrations ORDER BY version');
  const sites = await db.all('SELECT * FROM sites');
  await db.close();
  const result = run([...args, '--password-stdin', '--site', 'SYNTH', '--role', 'owner']);
  t.assert.strictEqual(result.status, 0);
  t.assert.strictEqual(result.stderr, 'migrations applied\n');
  db = await openDb(path, { driver: 'sqlite' });
  try {
    const after = await db.all('SELECT * FROM schema_migrations ORDER BY version');
    t.assert.strictEqual(after.length, before.length + 1);
    t.assert.deepStrictEqual(after.slice(0, before.length), before);
    t.assert.deepStrictEqual(await db.all('SELECT * FROM sites'), sites);
  } finally { await db.close(); }
});

test('hidden TTY prompt restores raw mode on confirmation, Ctrl-C, SIGINT, EOF and read errors', async t => {
  for (const finish of ['enter', 'ctrl-c', 'signal', 'end', 'error']) {
    const stdin = new PassThrough();
    stdin.isTTY = true; stdin.isRaw = false;
    const modes = [];
    stdin.setRawMode = mode => { modes.push(mode); stdin.isRaw = mode; };
    const signals = new EventEmitter();
    let output = '';
    const promise = readPassword({}, { input: stdin, output: { write: text => { output += text; } }, signals });
    stdin.emit('keypress', input.password, {});
    if (finish === 'enter') {
      stdin.emit('keypress', '\r', { name: 'return' });
      t.assert.strictEqual(await promise, input.password);
    } else {
      const rejected = t.assert.rejects(() => promise, finish === 'ctrl-c' || finish === 'signal' ? { exitCode: 130 } : /input|read/);
      if (finish === 'ctrl-c') stdin.emit('keypress', '\x03', { ctrl: true, name: 'c' });
      if (finish === 'signal') signals.emit('SIGINT');
      if (finish === 'end') stdin.emit('end');
      if (finish === 'error') stdin.emit('error', new Error('Synthetic read failure'));
      await rejected;
    }
    t.assert.deepStrictEqual(modes, [true, false]);
    t.assert.strictEqual(stdin.isPaused(), true);
    t.assert.strictEqual(signals.listenerCount('SIGINT'), 0);
    t.assert.strictEqual(stdin.listenerCount('keypress'), 0);
    t.assert.strictEqual(output, 'Password: \n');
    stdin.destroy();
  }
});
