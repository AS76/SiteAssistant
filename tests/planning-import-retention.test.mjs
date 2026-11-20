import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { PGlite } from '@electric-sql/pglite';
import { SqliteStorage } from '../server/storage/sqlite.mjs';
import { PgStorage, translatePlaceholders } from '../server/storage/pg.mjs';
import { migrate } from '../server/migrations/index.mjs';
import { DEFAULT_POLICY, validatePolicy, loadPolicy, purge } from '../server/import-retention.mjs';
import { main } from '../scripts/retention-planning-import.mjs';

const NOW = new Date('2026-11-16T12:00:00.000Z');
const DAY = 86_400_000;
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const SITE = 'aaaaaaaa-0000-4000-8000-000000000001', OTHER_SITE = id(2), USER = id(3);
const policy = extra => ({ ...structuredClone(DEFAULT_POLICY), ...extra });
const exception = extra => ({ site_id: SITE, family: 'site_progress_items', until: '2027-03-31',
  reason: 'Synthetic approved investigation', approved_by: 'demo-reviewer', ...extra });
const protectedPolicy = () => policy({ exceptions: [exception()] });

async function fixture(t, { pg = false, path = ':memory:' } = {}) {
  let db;
  if (pg) {
    const engine = new PGlite();
    const executor = connection => ({
      all: async (sql, ...params) => (await connection.query(translatePlaceholders(sql), params)).rows,
      get: async (sql, ...params) => (await connection.query(translatePlaceholders(sql), params)).rows[0],
      run: async (sql, ...params) => ({ rowCount: (await connection.query(translatePlaceholders(sql), params)).affectedRows }),
      exec: async sql => { await connection.exec(sql); },
    });
    db = { ...executor(engine), transaction: fn => engine.transaction(tx => fn(executor(tx))), close: () => engine.close() };
  } else db = new SqliteStorage(path);
  t.after(() => db.close());
  if (!pg) await db.exec('PRAGMA foreign_keys = ON');
  await migrate(db, { driver: pg ? 'pg' : 'sqlite' });
  for (const site of [SITE, OTHER_SITE]) await db.run(
    'INSERT INTO sites (id, code, name, created_at) VALUES (?, ?, ?, ?)', site, site, 'Synthetic site', NOW.toISOString());
  await db.run(`INSERT INTO users (id, email, name, password_hash, password_algo, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`, USER, 'synthetic@example.invalid', 'Synthetic user', 'not-a-password', 'scrypt', NOW.toISOString());
  const runs = [
    { n: 10, family: 'employees', age: 31, bytes: 7 },
    { n: 11, family: 'work_days', age: 31, bytes: 9 },
    { n: 12, family: 'deviations', age: 91, bytes: 11 },
    { n: 13, family: 'site_progress_items', age: 91, bytes: 13 },
    { n: 14, family: 'deviations', age: 89, bytes: 15 },
    { n: 15, family: 'employees', age: 30, bytes: 17 },
    { n: 16, family: 'time_schedule', age: 90, bytes: 19 },
    { n: 17, family: 'daily_log', age: 91, bytes: null },
    { n: 18, family: 'site_progress_items', age: 91, bytes: 21, site: OTHER_SITE },
    { n: 19, family: 'daily_log', age: 91, bytes: 0 },
    { n: 20, family: 'employees', age: -1, bytes: 23 },
  ];
  for (const run of runs) {
    const buffer = run.bytes === null ? null : Buffer.alloc(run.bytes, 0xa5);
    await db.run(`INSERT INTO planning_import_runs
      (id, site_id, family, filename, file_sha256, file_data, created_by, created_at, counts_json, applied_keys_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, id(run.n), run.site || SITE, run.family,
    'synthetic.xlsx', createHash('sha256').update(buffer || '').digest('hex'), buffer, USER,
    new Date(NOW.getTime() - run.age * DAY).toISOString(), '{"added":1}', '["synthetic-key"]');
  }
  await db.run(`INSERT INTO planning_import_keys
    (site_id, family, import_key, target_id, identity_state, last_import_run_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, SITE, 'employees', 'synthetic-key', id(99), 'observed', id(10), NOW.toISOString(), NOW.toISOString());
  return db;
}

const normalized = value => JSON.parse(JSON.stringify(value));
const lengths = async db => normalized(await db.all('SELECT id, octet_length(file_data) AS bytes FROM planning_import_runs ORDER BY id'));
const metadata = async db => normalized(await db.all(`SELECT id, site_id, family, filename, file_sha256,
  created_by, created_at, counts_json, applied_keys_json FROM planning_import_runs ORDER BY id`));
const options = extra => ({ now: NOW, policy: protectedPolicy(), ...extra });

test('retention 1: policy defaults, family/site overrides, validation and missing file', async t => {
  assert.deepEqual(validatePolicy(undefined, { now: NOW }), DEFAULT_POLICY);
  assert.deepEqual(await loadPolicy(undefined, { now: NOW }), DEFAULT_POLICY);
  const directory = await mkdtemp(join(tmpdir(), 'siteassistant-retention-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  assert.deepEqual(await loadPolicy(join(directory, 'missing.json'), { now: NOW }), DEFAULT_POLICY);
  const file = join(directory, 'invalid.json');
  await writeFile(file, '{');
  await assert.rejects(() => loadPolicy(file, { now: NOW }), SyntaxError);
  for (const invalid of [
    { default_days: 91 }, { default_days: 0 }, { default_days: 1.5 }, { max_days: 91 },
    { family_overrides: { unknown: 30 } }, { family_overrides: { employees: 91 } },
    { site_overrides: { [SITE]: { days: 91, reason: 'Synthetic' } } },
    ...[{ approved_by: '' }, { reason: '' }, { until: undefined }, { until: '2027-02-30' },
      { until: '2027-01-01T00:00:00Z' }, { site_id: '' }, { family: 'unknown' }].map(extra => ({ exceptions: [exception(extra)] })),
    { exceptions: [{}] }, { unexpected: true },
  ]) assert.throws(() => validatePolicy(policy(invalid), { now: NOW }), /Invalid import retention policy/);
  const db = await fixture(t);
  assert.equal((await purge(db, options({ policy: policy({ family_overrides: { employees: 10, work_days: 30 } }) }))).expired, 7);
  const bySite = policy({ site_overrides: { [SITE]: { days: 20, reason: 'Synthetic shorter window' } } });
  assert.equal((await purge(db, options({ policy: bySite }))).expired, 9);
  const siteWindow = policy({ site_overrides: { [SITE]: { days: 90, reason: 'Synthetic site window' } } });
  assert.equal((await purge(db, options({ policy: siteWindow }))).expired, 6);
});

test('retention 2: expired/unprotected, protected with reason, recent and exact boundaries', async t => {
  const db = await fixture(t);
  assert.deepEqual(await purge(db, options()), {
    scanned: 10, expired: 6, deletable: 5,
    excluded: [{ id: id(13), reason: exception().reason }], bytesFreed: 0,
    exceptionCounts: { active: 1, expired: 0, malformed: 0 },
  });
  assert.deepEqual(await purge(db, options({ policy: policy({ exceptions: [exception({ site_id: SITE.toUpperCase() })] }) })),
    await purge(db, options()));
});

test('retention 3: expired includes excluded, deletable never includes protected receipts', async t => {
  const db = await fixture(t);
  const result = await purge(db, options());
  assert.equal(result.expired, result.deletable + result.excluded.length);
  assert.equal((await purge(db, options({ policy: policy() }))).deletable, result.deletable + 1);
  const elapsed = await purge(db, { ...options(), now: new Date('2027-03-31T00:00:00Z') });
  assert.equal(elapsed.excluded.length, 0);
  assert.equal(elapsed.deletable, elapsed.expired);
  assert.deepEqual(elapsed.exceptionCounts, { active: 0, expired: 1, malformed: 0 });
});

test('retention 4: dry-run default leaves every octet_length and metadata unchanged', async t => {
  const db = await fixture(t), before = await lengths(db), meta = await metadata(db);
  assert.equal((await purge(db, options())).bytesFreed, 0);
  assert.deepEqual(await lengths(db), before);
  assert.deepEqual(await metadata(db), meta);
  const lines = [];
  assert.equal(await main(['--json'], { now: NOW, open: async () => ({ transaction: fn => db.transaction(fn), close: async () => {} }),
    readPolicy: async () => protectedPolicy(), write: line => lines.push(line) }), 0);
  assert.match(lines[0], /Dry-run.*expired=6.*deletable=5.*excluded=1.*bytesFreed=0/);
  assert.match(lines[1], /Exceptions: active=1 expired=0 malformed=0/);
  assert.match(lines[2], /excluded.*Synthetic approved investigation/);
  assert.equal(JSON.parse(lines.at(-1)).bytesFreed, 0);
  assert.deepEqual(await lengths(db), before);
});

test('retention 5: confirmed apply clears only deletable bytes, preserves all metadata and bindings, rolls back failures', async t => {
  const db = await fixture(t), meta = await metadata(db);
  const keys = await db.all('SELECT * FROM planning_import_keys');
  const writes = [];
  const observed = { transaction: fn => db.transaction(tx => fn({ ...tx, all: (sql, ...params) => {
    if (/^UPDATE/.test(sql)) writes.push(sql);
    return tx.all(sql, ...params);
  } })) };
  const lines = [];
  assert.equal(await main(['--apply', '--confirm', 'planning_import_retention', '--json'], {
    now: NOW, open: async () => ({ ...observed, close: async () => {} }), readPolicy: async () => protectedPolicy(), write: line => lines.push(line),
  }), 0);
  assert.match(lines[0], /Before apply/);
  assert.match(lines[3], /After apply/);
  assert.equal(JSON.parse(lines.at(-1)).bytesFreed, 48);
  assert.equal(writes.length, 5);
  for (const sql of writes) assert.match(sql, /^UPDATE planning_import_runs SET file_data = NULL\s+WHERE id = \? AND file_data IS NOT NULL RETURNING id$/);
  assert.deepEqual((await lengths(db)).filter(row => row.bytes === null).map(row => row.id), [10, 11, 12, 17, 18, 19].map(id));
  assert.deepEqual(await metadata(db), meta);
  assert.deepEqual(await db.all('SELECT * FROM planning_import_keys'), keys);

  const rollbackDb = await fixture(t), before = await lengths(rollbackDb);
  await rollbackDb.exec(`CREATE TRIGGER retention_failure BEFORE UPDATE OF file_data ON planning_import_runs
    WHEN OLD.id = '${id(11)}' BEGIN SELECT RAISE(ABORT, 'Synthetic retention failure'); END`);
  await assert.rejects(() => purge(rollbackDb, options({ dryRun: false })), /Synthetic retention failure/);
  assert.deepEqual(await lengths(rollbackDb), before);
});

test('retention 6: second apply is idempotent with zero modified rows and bytes', async t => {
  const db = await fixture(t);
  await purge(db, options({ dryRun: false }));
  const before = await lengths(db);
  const again = await purge(db, options({ dryRun: false }));
  assert.equal(again.scanned, 5);
  assert.equal(again.deletable, 0);
  assert.equal(again.bytesFreed, 0);
  assert.equal(again.excluded.length, 1);
  assert.deepEqual(await lengths(db), before);
});

test('retention 7: unconfirmed/invalid CLI exits 2 before opening a database', async t => {
  const db = await fixture(t), before = await lengths(db);
  for (const argv of [['--apply'], ['--apply', '--confirm', 'wrong'], ['--apply', '--confirm'],
    ['--apply', '--dry-run', '--confirm', 'planning_import_retention'], ['--unknown']]) {
    let opened = false;
    assert.equal(await main(argv, { open: async () => { opened = true; return db; }, error: () => {} }), 2);
    assert.equal(opened, false);
    assert.deepEqual(await lengths(db), before);
  }
  await t.test('CLI process exposes exit code 2 without touching a SQLite file', async t => {
    const directory = await mkdtemp(join(tmpdir(), 'siteassistant-retention-cli-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const path = join(directory, 'synthetic.db');
    const stored = await fixture(t, { path }), bytes = await lengths(stored);
    const child = spawnSync(process.execPath, ['scripts/retention-planning-import.mjs', '--apply'], {
      encoding: 'utf8', env: { DB_DRIVER: 'sqlite', DATA_DIR: path },
    });
    if (child.error) throw child.error;
    assert.equal(child.status, 2, child.stderr);
    assert.match(child.stderr, /requires --confirm/);
    assert.deepEqual(await lengths(stored), bytes);
  });
});

test('retention 8: identical SQLite/PostgreSQL cases using in-memory PGlite without sockets', async t => {
  async function scenario(pg) {
    const db = await fixture(t, { pg });
    const before = await lengths(db);
    const dry = await purge(db, options());
    assert.deepEqual(await lengths(db), before);
    const familyOverride = await purge(db, options({ policy: policy({ family_overrides: { employees: 10, work_days: 30 } }) }));
    const siteOverride = await purge(db, options({ policy: policy({ site_overrides: { [SITE]: { days: 20, reason: 'Synthetic site window' } } }) }));
    const applied = await purge(db, options({ dryRun: false }));
    const again = await purge(db, options({ dryRun: false }));
    return { before, dry, familyOverride, siteOverride, applied, again, after: await lengths(db), metadata: await metadata(db),
      keys: normalized(await db.all('SELECT * FROM planning_import_keys')) };
  }
  assert.deepEqual(await scenario(true), await scenario(false));
});

test('retention 9: a 90-day site window cannot extend employees beyond 30 days, but an active exception protects', async t => {
  for (const protectedRun of [false, true]) await t.test(`active exception: ${protectedRun}`, async t => {
    const db = await fixture(t);
    await db.run('UPDATE planning_import_runs SET created_at = ? WHERE id = ?',
      new Date(NOW.getTime() - 45 * DAY).toISOString(), id(10));
    const before = await db.get('SELECT file_data FROM planning_import_runs WHERE id = ?', id(10));
    const selectedPolicy = policy({
      site_overrides: { [SITE]: { days: 90, reason: 'Synthetic site window' } },
      exceptions: protectedRun ? [exception({ family: 'employees' })] : [],
    });
    const dry = await purge(db, options({ policy: selectedPolicy }));
    assert.equal(dry.deletable, protectedRun ? 5 : 6);
    assert.deepEqual(dry.excluded, protectedRun ? [{ id: id(10), reason: exception().reason }] : []);
    const applied = await purge(db, options({ policy: selectedPolicy, dryRun: false }));
    assert.equal(applied.deletable, dry.deletable);
    assert.deepEqual(applied.excluded, dry.excluded);
    const after = await db.get('SELECT file_data FROM planning_import_runs WHERE id = ?', id(10));
    if (protectedRun) assert.deepEqual(after, before);
    else assert.equal(after.file_data, null);
  });
});

test('retention 10: the global default also bounds longer family and site windows', async t => {
  const db = await fixture(t);
  const result = await purge(db, options({ policy: policy({
    default_days: 20,
    family_overrides: { employees: 60, work_days: 60 },
    site_overrides: { [SITE]: { days: 90, reason: 'Synthetic site window' } },
  }) }));
  assert.equal(result.deletable, 9);
});

test('retention 11: elapsed and exact-until exceptions are valid, counted and do not protect; dry-run changes nothing', async t => {
  const db = await fixture(t);
  const selectedPolicy = policy({ exceptions: [
    exception({ until: '2026-11-01' }),
    exception({ family: 'employees', until: '2026-11-16' }),
    exception({ site_id: OTHER_SITE, family: 'daily_log' }),
  ] });
  const now = new Date('2026-11-16T00:00:00.000Z');
  assert.deepEqual(validatePolicy(selectedPolicy, { now }), selectedPolicy);
  const before = await db.all('SELECT * FROM planning_import_runs ORDER BY id');
  const dry = await purge(db, { now, policy: selectedPolicy });
  assert.equal(dry.deletable, 6);
  assert.deepEqual(dry.excluded, []);
  assert.deepEqual(dry.exceptionCounts, { active: 1, expired: 2, malformed: 0 });
  assert.equal(dry.bytesFreed, 0);
  assert.deepEqual(await db.all('SELECT * FROM planning_import_runs ORDER BY id'), before);
  const applied = await purge(db, { now, policy: selectedPolicy, dryRun: false });
  assert.equal(applied.deletable, dry.deletable);
  assert.deepEqual(applied.exceptionCounts, dry.exceptionCounts);
  assert.equal((await db.get('SELECT file_data FROM planning_import_runs WHERE id = ?', id(13))).file_data, null);
});

test('retention 12: omitting family protects every family in the site, without protecting another site', async t => {
  const db = await fixture(t);
  await db.run('UPDATE planning_import_runs SET created_at = ? WHERE id = ?',
    new Date(NOW.getTime() - 91 * DAY).toISOString(), id(16));
  const siteException = exception();
  delete siteException.family;
  const selectedPolicy = policy({ exceptions: [siteException] });
  assert.deepEqual(validatePolicy(selectedPolicy, { now: NOW }), selectedPolicy);
  const before = await db.all('SELECT * FROM planning_import_runs WHERE site_id = ? ORDER BY id', SITE);
  const result = await purge(db, options({ policy: selectedPolicy, dryRun: false }));
  assert.deepEqual(result.excluded.map(row => row.id), [10, 11, 12, 13, 16, 19].map(id));
  assert.equal(result.deletable, 1);
  assert.deepEqual(await db.all('SELECT * FROM planning_import_runs WHERE site_id = ? ORDER BY id', SITE), before);
  assert.equal((await db.get('SELECT file_data FROM planning_import_runs WHERE id = ?', id(18))).file_data, null);
});

test('retention 13: malformed exceptions fail validation before a transaction or any UPDATE', async t => {
  const db = await fixture(t);
  const before = await db.all('SELECT * FROM planning_import_runs ORDER BY id');
  let transactions = 0, updates = 0;
  const observed = { transaction: fn => {
    transactions++;
    return db.transaction(tx => fn({ ...tx, all: (sql, ...params) => {
      if (/^UPDATE/.test(sql)) updates++;
      return tx.all(sql, ...params);
    } }));
  } };
  for (const malformed of [{ reason: '' }, { reason: '   ' }, { approved_by: '' },
    { until: undefined }, { until: 'unreadable' }, { family: null }]) {
    const selectedPolicy = policy({ exceptions: [exception(malformed)] });
    assert.throws(() => validatePolicy(selectedPolicy, { now: NOW }), /Invalid import retention policy/);
    await assert.rejects(() => purge(observed, options({ policy: selectedPolicy, dryRun: false })), /Invalid import retention policy/);
  }
  assert.equal(transactions, 0);
  assert.equal(updates, 0);
  assert.deepEqual(await db.all('SELECT * FROM planning_import_runs ORDER BY id'), before);
});

test('retention 14: real PostgreSQL adapter preserves receipts, keys and progress through dry-run and idempotent purge', {
  skip: process.env.DB_DRIVER !== 'pg'
    ? 'Requires DB_DRIVER=pg and DATABASE_URL_TEST (local siteassistant_test).'
    : !process.env.DATABASE_URL_TEST && 'Requires DATABASE_URL_TEST (local siteassistant_test).',
}, async t => {
  // Never use the operational connection or the shared pg helper's startup side effects.
  const connectionString = process.env.DATABASE_URL_TEST;
  let url;
  try { url = new URL(connectionString); }
  catch { assert.fail('DATABASE_URL_TEST must be a local PostgreSQL URL for siteassistant_test.'); }
  assert.ok(['postgres:', 'postgresql:'].includes(url.protocol), 'PostgreSQL URL required');
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname), 'Only local PostgreSQL is allowed');
  assert.equal(decodeURIComponent(url.pathname), '/siteassistant_test');
  for (const key of ['host', 'hostaddr', 'port', 'database', 'dbname', 'service']) {
    assert.equal(url.searchParams.has(key), false, `Connection target override forbidden: ${key}`);
  }

  const schema = `retention_${randomUUID().replaceAll('-', '_')}`;
  const db = new PgStorage(connectionString, { schema });
  let schemaCreated = false;
  t.after(async () => {
    try {
      if (schemaCreated) await db.exec(`DROP SCHEMA "${schema}" CASCADE`);
    } finally { await db.close(); }
  });
  assert.equal((await db.get('SELECT current_database() AS name')).name, 'siteassistant_test');
  // CREATE without IF NOT EXISTS ensures cleanup can only drop a schema we own.
  await db.exec(`CREATE SCHEMA "${schema}"`);
  schemaCreated = true;
  assert.equal((await db.get('SELECT current_schema() AS name')).name, schema);
  assert.ok(await migrate(db, { driver: 'pg' }) > 0, 'Apply the full migration chain in the isolated schema');

  for (const site of [SITE, OTHER_SITE]) await db.run(
    'INSERT INTO sites (id, code, name, created_at) VALUES (?, ?, ?, ?)',
    site, site, 'Synthetic retention site', NOW.toISOString());
  await db.run(`INSERT INTO users (id, email, name, password_hash, password_algo, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`, USER, 'retention@example.invalid', 'Synthetic retention user',
  'not-a-password', 'scrypt', NOW.toISOString());
  const runs = [
    { n: 101, age: 91, bytes: 7, deletable: true },
    { n: 102, age: 92, bytes: 0, deletable: true },
    { n: 103, age: 93, bytes: 19, deletable: true },
    { n: 104, age: 91, bytes: 11, site: OTHER_SITE }, // Excluded by an active exception.
    { n: 105, age: 89, bytes: 13 },
    { n: 106, age: 90, bytes: 17 }, // Exactly at the retention boundary.
    { n: 107, age: 94, bytes: null }, // Previously purged receipt.
  ];
  for (const run of runs) {
    const site = run.site || SITE, key = `synthetic-progress-${run.n}`;
    const payload = run.bytes === null ? null : Buffer.from(
      Array.from({ length: run.bytes }, (_, index) => (index * 67 + run.n) % 256));
    await db.run(`INSERT INTO planning_import_runs
      (id, site_id, family, filename, file_sha256, file_data, created_by, created_at, counts_json, applied_keys_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, id(run.n), site, 'site_progress_items',
    run.n === 107 ? null : `synthetic-Δ-${run.n}.xlsx`,
    payload === null ? null : createHash('sha256').update(payload).digest('hex'), payload, USER,
    new Date(NOW.getTime() - run.age * DAY).toISOString(),
    `{ "added": 1, "synthetic_run": ${run.n} }`, `[ "${key}" ]`);
    await db.run(`INSERT INTO site_progress_items
      (id, site_id, description, source_row, progress_pct, planned_progress_pct, has_files, has_notes, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, id(run.n + 1000), site,
    `Synthetic progress ${run.n}`, run.n, run.n % 2 ? '25.5' : null, '75', false, null, NOW.toISOString());
    await db.run(`INSERT INTO planning_import_keys
      (site_id, family, import_key, target_id, identity_state, last_import_run_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, site, 'site_progress_items', key, id(run.n + 1000),
    run.n % 2 ? 'observed' : 'unresolved', id(run.n), NOW.toISOString(), NOW.toISOString());
  }

  const selectedPolicy = policy({ exceptions: [exception({ site_id: OTHER_SITE })] });
  const purgeOptions = { now: NOW, policy: selectedPolicy };
  const readState = async () => ({
    // TEXT JSON stays unparsed; timestamps stay at PostgreSQL precision. xmin also
    // detects no-op UPDATEs on the second purge, even if values remain identical.
    runs: await db.all(`SELECT id, site_id, family, filename, file_sha256, file_data,
      octet_length(file_data) AS file_data_length, created_by, created_at::text AS created_at,
      counts_json, applied_keys_json, xmin::text AS row_version FROM planning_import_runs ORDER BY id`),
    keys: await db.all(`SELECT *, row_to_json(planning_import_keys)::text AS stored_values
      FROM planning_import_keys ORDER BY site_id, family, import_key`),
    progress: await db.all(`SELECT *, row_to_json(site_progress_items)::text AS stored_values
      FROM site_progress_items ORDER BY id`),
  });
  const before = await readState();
  assert.equal(before.runs.length, runs.length);
  assert.equal(before.keys.length, runs.length);
  assert.equal(before.progress.length, runs.length);
  for (const [index, run] of runs.entries()) {
    assert.equal(before.runs[index].file_data_length, run.bytes);
    if (run.bytes !== null) assert.ok(Buffer.isBuffer(before.runs[index].file_data));
  }

  const dry = await purge(db, { ...purgeOptions, dryRun: true });
  assert.equal(dry.deletable, 3);
  assert.deepEqual(dry.excluded, [{ id: id(104), reason: exception().reason }]);
  assert.equal(dry.bytesFreed, 0);
  assert.deepEqual(await readState(), before, 'Dry-run preserves all fields and payloads');

  const applied = await purge(db, { ...purgeOptions, dryRun: false });
  const after = await readState();
  const deletable = new Set(runs.filter(run => run.deletable).map(run => id(run.n)));
  assert.equal(applied.deletable, deletable.size);
  assert.deepEqual(applied.excluded, dry.excluded);
  assert.equal(applied.bytesFreed, before.runs.filter(row => deletable.has(row.id))
    .reduce((sum, row) => sum + row.file_data_length, 0));
  assert.equal(after.runs.length, before.runs.length);
  for (const [index, previous] of before.runs.entries()) {
    const current = after.runs[index];
    for (const field of ['id', 'site_id', 'family', 'filename', 'file_sha256', 'created_by',
      'created_at', 'counts_json', 'applied_keys_json']) {
      assert.deepEqual(current[field] === null ? null : Buffer.from(current[field], 'utf8'),
        previous[field] === null ? null : Buffer.from(previous[field], 'utf8'), `${previous.id}: ${field} bytes`);
    }
    if (deletable.has(previous.id)) {
      assert.equal(current.file_data, null);
      assert.equal(current.file_data_length, null);
      assert.notEqual(current.row_version, previous.row_version, 'Real UPDATE reached the receipt');
    } else assert.deepEqual(current, previous, 'Excluded, unexpired and previously purged runs stay intact');
  }
  assert.equal(after.keys.length, before.keys.length);
  assert.deepEqual(after.keys, before.keys, 'All identity bindings stay intact');
  assert.equal(after.progress.length, before.progress.length);
  assert.deepEqual(after.progress, before.progress, 'All related application rows stay intact');

  const again = await purge(db, { ...purgeOptions, dryRun: false });
  const repeated = await readState();
  assert.equal(again.deletable, 0);
  assert.equal(again.bytesFreed, 0);
  assert.equal(repeated.runs.filter((row, index) => row.row_version !== after.runs[index].row_version).length, 0,
    'Second purge modifies zero rows');
  assert.deepEqual(repeated, after);
});
