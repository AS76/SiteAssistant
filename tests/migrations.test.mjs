import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { SqliteStorage } from '../server/storage/sqlite.mjs';
import { translatePlaceholders } from '../server/storage/pg.mjs';
import { openDb, closeDb } from '../server/db.mjs';
import { migrate } from '../server/migrations/index.mjs';
import { isPg, openTestDb } from './helpers/db.mjs';

const versions = ['001', '002', '003', '004', '005', '006', '007', '008', '009', '010'];

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
  for (const table of ['sites', 'tasks', 'task_events', 'diary', 'idempotency_keys', 'users', 'sessions', 'site_members', 'attachments', 'project_structure', 'wbs_import_sources', 'employees', 'work_days', 'hr_import_sources']) {
    t.assert.deepStrictEqual(await db.all(`SELECT * FROM ${table}`), []);
  }
  await migrate(db, { driver });
  t.assert.deepStrictEqual(await db.all('SELECT * FROM schema_migrations ORDER BY version'), before);
}

test('migrations initialize an empty temporary SQLite file and reopening is a no-op', async t => {
  const { db, path } = await temporarySqlite(t);
  await migrate(db, { driver: 'sqlite' });
  await assertMigrations(t, db, 'sqlite');
  const reopened = await openDb(path, { driver: 'sqlite' });
  try { await assertMigrations(t, reopened, 'sqlite'); }
  finally { await closeDb(reopened); }
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
  await migrate(db, { driver: 'sqlite' });
  t.assert.deepStrictEqual(await db.all('SELECT * FROM sites'), before);
  t.assert.deepStrictEqual({ ...await db.get('SELECT * FROM diary') }, {
    ...diaryBefore, time_zone: 'Europe/Rome', day_cutoff_time: '06:00',
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
  await t.assert.rejects(() => migrate(failing, { driver: 'sqlite' }), /syntax/i);
  t.assert.deepStrictEqual(await db.all('SELECT * FROM schema_migrations'), []);
  t.assert.strictEqual(await db.get("SELECT name FROM sqlite_master WHERE name = 'sites'"), undefined);
  await migrate(db, { driver: 'sqlite' });
  await assertMigrations(t, db, 'sqlite');
});

test('PostgreSQL migrations initialize an empty PGlite schema and repeat without changes', async t => {
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
  await migrate(db, { driver: 'pg' });
  await assertMigrations(t, db, 'pg');
  t.assert.strictEqual((await pg.query("SELECT table_schema FROM information_schema.tables WHERE table_name = 'schema_migrations'")).rows[0].table_schema, 'migration_test');
});

test('openDb migrates an isolated PostgreSQL test schema', { skip: !isPg }, async t => {
  const database = await openTestDb();
  t.after(database.close);
  await assertMigrations(t, database.db, 'pg');
});
