import test from 'node:test';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { PGlite } from '@electric-sql/pglite';
import { openDb, closeDb } from '../server/db.mjs';
import { SqliteStorage, PgStorage } from '../server/storage/index.mjs';
import { applyMigration } from '../server/migrations/index.mjs';

async function fixture(t, driver) {
  const connections = [];
  const schema = 'db_open_test';
  let directory, engine, location;
  t.after(async () => {
    for (const db of connections) if (db.isOpen) await closeDb(db);
    if (engine) await engine.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });
  if (driver === 'sqlite') {
    directory = await mkdtemp(join(tmpdir(), 'siteassistant-db-open-'));
    location = join(directory, 'test.db');
  } else {
    engine = new PGlite();
    await engine.exec(`CREATE SCHEMA ${schema}; SET search_path TO ${schema}`);
    location = 'postgresql://synthetic.invalid/siteassistant_test';
    // Replace only the pool transport: openDb still uses the real PgStorage.
    // The engine persists when a pool closes, so connections can reopen it.
    const query = async (sql, values) => {
      const result = values === undefined
        ? (await engine.exec(sql)).at(-1)
        : await engine.query(sql, values);
      return { ...result, rowCount: result.affectedRows };
    };
    t.mock.method(pg, 'Pool', function (options) {
      t.assert.strictEqual(options.options, `-c search_path=${schema}`);
      return {
        query,
        connect: async () => ({ query, release() {} }),
        end: async () => {},
      };
    });
  }
  return {
    create: async () => {
      const db = driver === 'sqlite'
        ? new SqliteStorage(location)
        : new PgStorage(location, { schema });
      connections.push(db);
      if (driver === 'pg') await db.open();
      else await db.exec('PRAGMA foreign_keys = ON');
      return db;
    },
    open: async options => {
      const db = await openDb(location, { driver, schema, ...options });
      connections.push(db);
      t.assert.ok(db instanceof (driver === 'sqlite' ? SqliteStorage : PgStorage));
      if (driver === 'pg') {
        t.assert.strictEqual((await db.get('SELECT current_schema() AS name')).name, schema);
      } else {
        t.assert.strictEqual((await db.get('PRAGMA foreign_keys')).foreign_keys, 1);
      }
      return db;
    },
  };
}

async function tableExists(db, driver, name) {
  return !!await db.get(driver === 'sqlite'
    ? "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?"
    : 'SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = ?', name);
}

for (const driver of ['sqlite', 'pg']) {
  test(`openDb preserves a pending migration when disabled and applies it by default: ${driver}`, async t => {
    const database = await fixture(t, driver);
    const original = await database.create();
    const files = (await readdir(new URL(`../server/migrations/${driver}/`, import.meta.url)))
      .filter(file => /^\d{3}_.+\.sql$/.test(file)).sort();
    // Keep 025 pending to exercise creation of audit_events as well as its newer constraints.
    t.assert.strictEqual(files.at(-1), '027_attachments_hse_event.sql');
    const pending = files.filter(file => file >= '025');
    await original.exec('CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
    for (const file of files.filter(file => file < '025')) {
      await original.transaction(async tx => {
        await applyMigration(tx, file, { driver });
        await tx.run('INSERT INTO schema_migrations VALUES (?, ?)', file.slice(0, 3), '2026-01-01T00:00:00.000Z');
      });
    }
    const before = await original.all('SELECT * FROM schema_migrations ORDER BY version');
    t.assert.strictEqual(before.length, files.length - pending.length);
    t.assert.strictEqual(await tableExists(original, driver, 'audit_events'), false);
    await closeDb(original);

    const onMigrationsApplied = t.mock.fn();
    const inspected = await database.open({ migrate: false, onMigrationsApplied });
    t.assert.deepStrictEqual(await inspected.all('SELECT * FROM schema_migrations ORDER BY version'), before);
    t.assert.strictEqual(await tableExists(inspected, driver, 'audit_events'), false);
    t.assert.strictEqual(onMigrationsApplied.mock.callCount(), 0);
    await closeDb(inspected);

    const migrated = await database.open({ onMigrationsApplied });
    const after = await migrated.all('SELECT * FROM schema_migrations ORDER BY version');
    t.assert.deepStrictEqual(after.slice(0, -pending.length), before);
    t.assert.strictEqual(after.length, files.length);
    t.assert.strictEqual(after.at(-1).version, '027');
    t.assert.strictEqual(await tableExists(migrated, driver, 'audit_events'), true);
    t.assert.deepStrictEqual(await migrated.all('SELECT * FROM audit_events'), []);
    t.assert.strictEqual(onMigrationsApplied.mock.callCount(), 1);
    t.assert.deepStrictEqual(onMigrationsApplied.mock.calls[0].arguments, [pending.length]);
    await closeDb(migrated);

    const reopened = await database.open({ migrate: true, onMigrationsApplied });
    t.assert.deepStrictEqual(await reopened.all('SELECT * FROM schema_migrations ORDER BY version'), after);
    t.assert.strictEqual(onMigrationsApplied.mock.callCount(), 1);
  });

  test(`openDb with migrate: false accepts a missing schema version table: ${driver}`, async t => {
    const database = await fixture(t, driver);
    const onMigrationsApplied = t.mock.fn();
    const db = await database.open({ migrate: false, onMigrationsApplied });
    t.assert.strictEqual(await tableExists(db, driver, 'schema_migrations'), false);
    t.assert.strictEqual(await tableExists(db, driver, 'sites'), false);
    t.assert.strictEqual(onMigrationsApplied.mock.callCount(), 0);
  });
}
