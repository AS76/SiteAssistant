import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, rm, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { SqliteStorage } from '../server/storage/sqlite.mjs';
import { translatePlaceholders } from '../server/storage/pg.mjs';
import { openDb, closeDb } from '../server/db.mjs';
import { applyMigration, migrate } from '../server/migrations/index.mjs';
import { isPg, openTestDb } from './helpers/db.mjs';

import { assertSequence, assertUpgrade, observeMigrations, registry, verifyManifest, versions } from './helpers/migrations.mjs';
import { buildManifest, fixtureRoot, migrationRoot } from './helpers/migration-manifest.mjs';
import { assertCatalog, assertPg16, catalog, logicalCatalog, readSnapshot } from './helpers/migration-schema.mjs';
import { assertManifestPrefix, assertSnapshotWithoutTail, migrationBase } from './helpers/migration-base.mjs';

const base = migrationBase();

async function migrateAndCheckCatalog(db, driver, engine, { exact = true } = {}) {
  const baseline = await base?.snapshot(engine);
  let checkedBoundary = false;
  await assertUpgrade(db, { driver, async afterCommit(version) {
    if (baseline && version === base.boundary) {
      assertCatalog(await catalog(db, driver), baseline, `${engine} catalog at base migration ${version}`);
      checkedBoundary = true;
    }
  } });
  if (baseline && !checkedBoundary) throw new Error(`Missing catalog checkpoint at ${base.boundary}`);
  const actual = await catalog(db, driver);
  if (exact) assertCatalog(actual, await readSnapshot(engine), `${engine} final catalog`);
  return actual;
}

async function temporarySqlite(t) {
  const directory = await mkdtemp(join(tmpdir(), 'siteassistant-migrations-'));
  const path = join(directory, 'test.db');
  const db = new SqliteStorage(path);
  t.after(async () => { await db.close(); await rm(directory, { recursive: true, force: true }); });
  return { db, path };
}

async function assertMigrations(t, db, driver) {
  const before = await db.all('SELECT * FROM schema_migrations ORDER BY version');
  t.assert.deepStrictEqual(before.map(row => row.version), versions);
  for (const row of before) t.assert.ok(Number.isFinite(Date.parse(row.applied_at)));
  for (const table of ['sites', 'tasks', 'task_events', 'diary', 'idempotency_keys', 'users', 'sessions', 'password_resets', 'invitations', 'site_members', 'attachments', 'project_structure', 'wbs_import_sources', 'employees', 'work_days', 'hr_import_sources', 'site_progress_items', 'site_progress_import_sources', 'deviations', 'deviation_links', 'deviation_import_sources', 'deviation_exports', 'deviation_export_rows', 'deviation_events', 'time_bookings', 'cost_impacts', 'cost_impact_deviations', 'planning_import_runs', 'planning_import_keys', 'view_settings', 'tools', 'employee_certifications', 'import_mappings', 'dashboard_layouts', 'member_module_access', 'hse_events', 'purchase_orders', 'purchase_order_items', 'packages', 'package_items', 'shipments', 'shipment_packages', 'shipment_receipts', 'assistant_usage', 'demo_seed_records', 'demo_seed_environment']) {
    t.assert.deepStrictEqual(await db.all(`SELECT * FROM ${table}`), []);
  }
  for (const entity of ['people', 'companies', 'teams', 'affiliations', 'company_roles', 'team_memberships',
    'account_links', 'authority_roles', 'authority_delegations', 'authority_snapshots', 'history']) {
    t.assert.deepStrictEqual(await db.all(`SELECT * FROM registry_${entity}`), []);
  }
  for (const table of ['reconciliation_adoptions', 'reconciliation_batches', 'reconciliation_items', 'tool_company_links',
    'task_assignment_links', 'deviation_registry_links', 'deviation_registry_source_revisions']) {
    t.assert.deepStrictEqual(await db.all(`SELECT * FROM ${table}`), []);
  }
  const committed = [];
  t.assert.strictEqual(await migrate(observeMigrations(db, committed), { driver, demoSandbox: false }), 0);
  assertSequence(committed, []);
  t.assert.deepStrictEqual(await db.all('SELECT * FROM schema_migrations ORDER BY version'), before);
}

test('migrations initialize an empty temporary SQLite file and reopening is a no-op', async t => {
  const { db, path } = await temporarySqlite(t);
  const expected = await migrateAndCheckCatalog(db, 'sqlite', 'sqlite');
  await assertMigrations(t, db, 'sqlite');
  const reopened = await openDb(path, { driver: 'sqlite' });
  try { await assertMigrations(t, reopened, 'sqlite'); }
  finally { await closeDb(reopened); }
  const ordinary = await openDb(':memory:', { driver: 'sqlite' });
  try { assertCatalog(await catalog(ordinary, 'sqlite'), expected, 'SQLite openDb catalog'); }
  finally { await closeDb(ordinary); }
});

test('migrations adopt populated SQLite databases without changing existing records', async t => {
  const { db } = await temporarySqlite(t);
  await db.exec(await readFile(new URL('../server/migrations/sqlite/001_init.sql', import.meta.url), 'utf8'));
  await db.run(`INSERT INTO sites (id, code, name, created_at) VALUES (?, ?, ?, ?)`,
    'example-site', 'EXAMPLE', 'Example site', '2026-01-01T00:00:00.000Z');
  await db.run(`INSERT INTO diary (id, site_id, operational_date, shift, plan, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`, 'example-diary', 'example-site', '2026-01-01', 'night',
    'Example plan', '2026-01-02T03:00:00.000Z');
  const before = await db.all('SELECT * FROM sites');
  const diaryBefore = await db.get('SELECT * FROM diary');
  await assertUpgrade(db, { driver: 'sqlite' });
  t.assert.deepStrictEqual((await db.all('SELECT * FROM sites')).map(row => ({ ...row })),
    before.map(row => ({ ...row, jurisdiction: 'IT', time_zone: 'Europe/Rome', day_cutoff_time: '06:00',
      assistant_enabled: 0, assistant_timeout_ms: 20000, demo_sandbox: 0, jurisdiction_code: null, content_language: null })));
  t.assert.deepStrictEqual({ ...await db.get('SELECT * FROM diary') }, {
    ...diaryBefore, time_zone: 'Europe/Rome', day_cutoff_time: '06:00',
    author_id: null, recording_motivation: null, recorded_late: 0, updated_at: null, updated_by: null,
  });
  t.assert.deepStrictEqual((await db.all('SELECT version FROM schema_migrations ORDER BY version')).map(row => row.version), versions);
});

test('a failed migration rolls back its DDL and version, and can be retried', async t => {
  const { db } = await temporarySqlite(t);
  const failing = {
    exec: sql => db.exec(sql),
    transaction: fn => db.transaction(tx => fn({
      ...tx,
      exec: sql => tx.exec(`${sql}\nINVALID SQL;`),
    })),
  };
  const committed = [];
  await t.assert.rejects(() => migrate(observeMigrations(failing, committed), { driver: 'sqlite', demoSandbox: false }), /syntax/i);
  assertSequence(committed, []);
  t.assert.deepStrictEqual(await db.all('SELECT * FROM schema_migrations'), []);
  t.assert.strictEqual(await db.get("SELECT name FROM sqlite_master WHERE name = 'sites'"), undefined);
  await assertUpgrade(db, { driver: 'sqlite' });
  await assertMigrations(t, db, 'sqlite');
});

async function temporaryPGlite(t) {
  const pg = new PGlite();
  t.after(() => pg.close());
  await pg.exec('CREATE SCHEMA migration_test; SET search_path TO migration_test;');
  const adapt = connection => ({
    exec: sql => connection.exec(sql),
    get: async (sql, ...params) => (await connection.query(translatePlaceholders(sql), params)).rows[0],
    all: async (sql, ...params) => (await connection.query(translatePlaceholders(sql), params)).rows,
    run: (sql, ...params) => connection.query(translatePlaceholders(sql), params),
  });
  const db = { ...adapt(pg), transaction: fn => pg.transaction(tx => fn(adapt(tx))) };
  return { db, pg };
}

test('PostgreSQL migrations initialize an empty PGlite schema and repeat without changes', async t => {
  const { db, pg } = await temporaryPGlite(t);
  await assertUpgrade(db, { driver: 'pg' });
  const sqlite = await readSnapshot('sqlite');
  assertCatalog(logicalCatalog(await catalog(db, 'pg')), logicalCatalog(sqlite), 'SQLite/PGlite logical schema');
  await assertMigrations(t, db, 'pg');
  t.assert.strictEqual((await pg.query("SELECT table_schema FROM information_schema.tables WHERE table_name = 'schema_migrations'")).rows[0].table_schema, 'migration_test');
});

for (const [driver, open] of [['sqlite', temporarySqlite], ['pg', temporaryPGlite]]) {
  test(`${driver} 060, 061 and 062 append one migration each and keep existing labels and nulls`, async t => {
    const { db } = await open(t);
    const site = randomUUID(), tool = randomUUID(), task = randomUUID(), deviation = randomUUID();
    const at = '2026-01-01T00:00:00.000Z';
    let toolBefore, taskBefore, deviationBefore;
    const committed = [];
    const observed = observeMigrations(db, committed, async version => {
      if (version === '059') {
        await db.run('INSERT INTO sites (id, code, name, created_at) VALUES (?, ?, ?, ?)', site, 'EXAMPLE', 'Example site', at);
        await db.run(`INSERT INTO tools (id, site_id, name, company, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`, tool, site, 'Synthetic drill', 'Original  label', 'maintenance', at, at);
        toolBefore = await db.get('SELECT * FROM tools WHERE id = ?', tool);
      }
      if (version === '060') {
        await db.run(`INSERT INTO tasks (id, site_id, title, executor, verifier, status, created_at)
          VALUES (?, ?, ?, ?, ?, 'todo', ?)`, task, site, 'Synthetic task', 'Original  crew', 'Original reviewer', at);
        taskBefore = await db.get('SELECT * FROM tasks WHERE id = ?', task);
      }
      if (version === '061') {
        await db.run(`INSERT INTO deviations (id, site_id, title, author, assigned_to, causing_company, attribution_state, created_at)
          VALUES (?, ?, ?, ?, ?, ?, 'disputed', ?)`,
        deviation, site, 'Synthetic deviation', 'Original  author', 'Original  crew', 'Original  company', at);
        deviationBefore = await db.get('SELECT * FROM deviations WHERE id = ?', deviation);
      }
    });
    t.assert.strictEqual(await migrate(observed, { driver, demoSandbox: false }), versions.length);
    const index = committed.indexOf('059');
    t.assert.ok(index >= 0);
    t.assert.deepStrictEqual(committed.slice(index + 1), ['060', '061', '062']);
    t.assert.deepStrictEqual({ ...await db.get('SELECT * FROM tools WHERE id = ?', tool) }, { ...toolBefore });
    t.assert.deepStrictEqual({ ...await db.get('SELECT * FROM tasks WHERE id = ?', task) }, { ...taskBefore });
    t.assert.strictEqual(taskBefore.company, null);
    t.assert.deepStrictEqual({ ...await db.get('SELECT * FROM deviations WHERE id = ?', deviation) }, { ...deviationBefore });
    t.assert.strictEqual(deviationBefore.resolving_company, null);
    t.assert.deepStrictEqual(await db.all('SELECT * FROM tool_reconciliation_revisions'), []);
    t.assert.deepStrictEqual(await db.all('SELECT * FROM tool_company_links'), []);
    t.assert.deepStrictEqual(await db.all('SELECT * FROM task_assignment_links'), []);
    t.assert.deepStrictEqual(await db.all('SELECT * FROM deviation_registry_links'), []);
    t.assert.deepStrictEqual(await db.all('SELECT * FROM deviation_registry_source_revisions'), []);
    t.assert.strictEqual(await migrate(db, { driver, demoSandbox: false }), 0);
  });

  test(`${driver} 054 adopts the legacy demo seed table and direct replay preserves its rows`, async t => {
    const { db } = await open(t);
    const committed = [];
    let before;
    await migrate(observeMigrations(db, committed, async version => {
      if (version !== '053') return;
      await db.exec(`CREATE TABLE demo_seed_records (
        table_name TEXT NOT NULL, record_id TEXT NOT NULL, PRIMARY KEY (table_name, record_id)
      )`);
      await db.exec("INSERT INTO demo_seed_records VALUES ('sites', 'example-id'), ('tasks', 'example-id')");
      before = await db.all('SELECT * FROM demo_seed_records ORDER BY table_name, record_id');
    }), { driver, demoSandbox: false });
    assertSequence(committed, versions);
    t.assert.strictEqual(before.length, 2);
    const records = () => db.all('SELECT * FROM demo_seed_records ORDER BY table_name, record_id');
    t.assert.deepStrictEqual(await records(), before);
    await db.transaction(tx => applyMigration(tx, '054_demo_seed_records.sql', { driver }));
    t.assert.deepStrictEqual(await records(), before);
  });

  test(`${driver} 054 rejects incompatible demo seed tables and leaves the version unapplied`, async t => {
    const { db } = await open(t);
    const options = { driver, demoSandbox: false };
    const incompatible = /Migration 054: incompatible demo_seed_records schema/;
    await t.assert.rejects(migrate(observeMigrations(db, [], async version => {
      if (version !== '053') return;
      await db.exec('CREATE TABLE demo_seed_records (table_name TEXT NOT NULL)');
      await db.exec("INSERT INTO demo_seed_records VALUES ('sites')");
    }), options), incompatible);
    t.assert.strictEqual((await db.get('SELECT table_name FROM demo_seed_records')).table_name, 'sites');

    for (const definition of [
      'table_name TEXT NOT NULL, record_id INTEGER NOT NULL, PRIMARY KEY (table_name, record_id)',
      'table_name TEXT NOT NULL, record_id TEXT NOT NULL, PRIMARY KEY (record_id, table_name)',
    ]) {
      await db.exec('DROP TABLE demo_seed_records');
      await db.exec(`CREATE TABLE demo_seed_records (${definition})`);
      await t.assert.rejects(migrate(db, options), incompatible);
      t.assert.deepStrictEqual((await registry(db)).map(row => row.version), versions.filter(version => Number(version) < 54));
    }
  });
}

test('demo seed CLI requires the migrated marker table for apply and reset', async t => {
  const { db, path } = await temporarySqlite(t);
  for (const flag of ['--apply', '--reset']) {
    const result = spawnSync(process.execPath, ['server/seed-demo.mjs', flag], {
      encoding: 'utf8', env: { ...process.env, DB_DRIVER: 'sqlite', DATA_DIR: path, APP_ENV: 'demo' },
    });
    t.assert.ifError(result.error);
    t.assert.strictEqual(result.status, 1);
    t.assert.match(result.stderr, /Missing demo_seed_environment table. Apply database migration 055/);
    t.assert.deepStrictEqual(await db.all("SELECT name FROM sqlite_schema WHERE type = 'table'"), []);
  }
});

test('openDb migrates an isolated PostgreSQL test schema', { skip: !isPg }, async t => {
  const database = await openTestDb();
  t.after(database.close);
  await assertMigrations(t, database.db, 'pg');
});

const hasPg16Snapshot = await readFile(new URL('pg16.schema.json', fixtureRoot))
  .then(() => true, error => {
    if (error.code !== 'ENOENT') throw error;
    return false;
  });

test('PostgreSQL 16 committed chain and openDb catalog parity', {
  skip: !isPg && 'requires an isolated real PostgreSQL 16 test database',
}, async t => {
  const blank = await openTestDb(':memory:', { migrate: false });
  t.after(blank.close);
  const expected = await migrateAndCheckCatalog(blank.db, 'pg', 'pg16', { exact: false });
  assertCatalog(logicalCatalog(expected), logicalCatalog(await readSnapshot('sqlite')), 'SQLite/PostgreSQL logical schema');
  const ordinary = await openTestDb();
  t.after(ordinary.close);
  assertCatalog(await catalog(ordinary.db, 'pg'), expected, 'PostgreSQL openDb catalog');
  await t.test('exact PostgreSQL 16 baseline', {
    skip: !hasPg16Snapshot && 'requires an initial baseline captured on real PostgreSQL 16',
  }, async () => {
    await assertPg16(blank.db);
    assertCatalog(expected, await readSnapshot('pg16'), 'pg16 final catalog');
  });
});

test('migration manifest matches both source directories and checksums', async () => {
  await verifyManifest();
});

test('manifest checks reject missing, unexpected and modified SQL in a disposable copy', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'siteassistant-manifest-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const temporary = pathToFileURL(directory + '/');
  const root = new URL('sources/', temporary);
  await cp(migrationRoot, root, { recursive: true });
  const base = await buildManifest(root);

  const latest = base.at(-1).file;
  await rm(new URL(`pg/${latest}`, root));
  await t.assert.rejects(verifyManifest(root), new RegExp(`missing pg/${latest}`));
  await rm(new URL(`sqlite/${latest}`, root));
  await t.assert.rejects(verifyManifest(root), new RegExp(`missing sqlite/${latest}.*missing pg/${latest}`, 's'));
  await cp(migrationRoot, root, { recursive: true });

  const changed = base[0].file;
  const historical = new URL(`sqlite/${changed}`, root);
  await appendFile(historical, '\n-- synthetic modification\n');
  await t.assert.rejects(verifyManifest(root), /SHA-256 changed: sqlite\/001_init.sql/);
  const rewritten = await buildManifest(root);
  t.assert.throws(() => assertManifestPrefix(base, rewritten), /Historical migration changed.*001_init.sql/);
  await cp(new URL(`sqlite/${changed}`, migrationRoot), historical);

  const next = String(Number(base.at(-1).version) + 1).padStart(3, '0');
  for (const dialect of ['sqlite', 'pg']) await writeFile(new URL(`${dialect}/${next}_synthetic.sql`, root), '-- synthetic tail\n');
  await t.assert.rejects(verifyManifest(root), /unexpected sqlite\/.*_synthetic.sql/);
  const candidate = await buildManifest(root);
  assertManifestPrefix(base, candidate);

  // Use a copy of the production runner with its two local imports and the
  // extended migration directory. The synthetic SQL is a catalog no-op.
  const server = new URL('server/', temporary);
  await mkdir(server);
  await cp(root, new URL('migrations/', server), { recursive: true });
  for (const file of ['demo-sandbox.mjs', 'operational-day.mjs']) {
    await cp(new URL(`../server/${file}`, import.meta.url), new URL(file, server));
  }
  const { migrate: migrateCandidate } = await import(new URL('migrations/index.mjs', server));
  const { db } = await temporarySqlite(t);
  const committed = [];
  const observed = observeMigrations(db, committed);
  t.assert.strictEqual(await migrateCandidate(observed, { driver: 'sqlite', demoSandbox: false }), candidate.length);
  assertSequence(committed, candidate.map(entry => entry.version));
  t.assert.deepStrictEqual((await registry(db)).map(row => row.version), committed);
  committed.length = 0;
  t.assert.strictEqual(await migrateCandidate(observed, { driver: 'sqlite', demoSandbox: false }), 0);
  assertSequence(committed, []);
  assertCatalog(await catalog(db, 'sqlite'), await readSnapshot('sqlite'), 'data-only migration catalog');
});

test('a skipped migration is detected even when the original SQL and manifest are intact', async t => {
  const { db } = await temporarySqlite(t);
  // Let the runner reach its final transaction, then roll it back and report
  // a no-op, as if the runner skipped the migration.
  const last = versions.at(-1);
  const skipped = new Error('synthetic skip');
  const adapter = {
    exec: sql => db.exec(sql),
    all: (...args) => db.all(...args),
    async transaction(fn) {
      try {
        return await db.transaction(tx => fn({
          ...tx,
          async run(sql, ...args) {
            if (/^INSERT INTO schema_migrations/i.test(sql) && args[0] === last) throw skipped;
            return await tx.run(sql, ...args);
          },
        }));
      } catch (error) {
        if (error !== skipped) throw error;
      }
    },
  };
  await t.assert.rejects(assertUpgrade(adapter, { driver: 'sqlite' }),
    new RegExp(`expected ${last}, observed end of sequence`));
});

test('commit order verification rejects swapped versions with a complete sorted registry', async t => {
  const { db } = await temporarySqlite(t);
  const observed = [];
  const correct = versions.slice(-2);
  await db.exec('CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  const adapter = observeMigrations(db, observed);
  for (const version of correct.toReversed()) {
    await adapter.transaction(tx => tx.run('INSERT INTO schema_migrations VALUES (?, ?)', version, '2026-01-01T00:00:00Z'));
  }
  t.assert.deepStrictEqual((await registry(db)).map(row => row.version), correct);
  t.assert.throws(() => assertSequence(observed, correct),
    new RegExp(`Migration commit #1: expected ${correct[0]}, observed ${correct[1]}`));
});

test('catalog drift fails even though the migration registry is unchanged', async t => {
  const { db } = await temporarySqlite(t);
  const before = await assertUpgrade(db, { driver: 'sqlite' });
  const baseline = await readSnapshot('sqlite');
  await db.exec('DROP INDEX assistant_usage_site_pending');
  t.assert.deepStrictEqual(await registry(db), before);
  const drift = await catalog(db, 'sqlite');
  t.assert.throws(() => assertCatalog(drift, baseline, 'SQLite catalog'),
    /- index assistant_usage_site_pending \(missing\)/);
  t.assert.throws(() => assertSnapshotWithoutTail(JSON.stringify(drift), JSON.stringify(baseline), 'sqlite.schema.json'),
    /sqlite.schema.json changed without appending a migration/);
});

test('recording a migration without running its DDL is detected by the catalog', async t => {
  const { db } = await temporarySqlite(t);
  const adapter = {
    exec: sql => db.exec(sql),
    all: (...args) => db.all(...args),
    transaction: fn => db.transaction(tx => fn({
      ...tx,
      exec: sql => /^CREATE TABLE assistant_usage \(/i.test(sql) ? undefined : tx.exec(sql),
    })),
  };
  const after = await assertUpgrade(adapter, { driver: 'sqlite' });
  t.assert.deepStrictEqual(after.map(row => row.version), versions);
  const actual = await catalog(db, 'sqlite');
  const baseline = await readSnapshot('sqlite');
  t.assert.throws(() => assertCatalog(actual, baseline, 'SQLite catalog'), /- table assistant_usage \(missing\)/);
});
