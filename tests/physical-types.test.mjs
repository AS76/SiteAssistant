import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { SqliteStorage } from '../server/storage/sqlite.mjs';
import { translatePlaceholders } from '../server/storage/pg.mjs';
import { applyMigration } from '../server/migrations/index.mjs';
import { isPg, openTestDb } from './helpers/db.mjs';
import { createSite, createTask, createDiary } from '../server/repository.mjs';

const ids = {
  site: '00000000-0000-4000-8000-000000000001',
  task: '00000000-0000-4000-8000-000000000002',
  diary: '00000000-0000-4000-8000-000000000003',
};
const at = '2026-01-01T00:00:00.000Z';
const migration = '004_physical_types.sql';

async function pgTypes(t, db) {
  const rows = await db.all(`SELECT table_name, column_name, udt_name, is_identity, identity_generation
    FROM information_schema.columns WHERE table_schema = current_schema()`);
  const column = (table, name) => rows.find(row => row.table_name === table && row.column_name === name);
  for (const [table, name] of [
    ['sites', 'id'], ['tasks', 'id'], ['tasks', 'site_id'],
    ['diary', 'id'], ['diary', 'site_id'], ['task_events', 'task_id'],
  ]) t.assert.strictEqual(column(table, name).udt_name, 'uuid');
  for (const [table, name] of [
    ['sites', 'created_at'], ['tasks', 'created_at'], ['diary', 'created_at'], ['task_events', 'at'],
  ]) t.assert.strictEqual(column(table, name).udt_name, 'timestamptz');
  t.assert.strictEqual(column('task_events', 'id').udt_name, 'int4');
  t.assert.strictEqual(column('task_events', 'id').is_identity, 'YES');
  t.assert.strictEqual(column('task_events', 'id').identity_generation, 'ALWAYS');
  t.assert.strictEqual(column('idempotency_keys', 'key').udt_name, 'text');
  t.assert.strictEqual(column('idempotency_keys', 'created_at').udt_name, 'text');
}

for (const driver of ['sqlite', 'pg']) {
  test(`004 upgrades populated ${driver}, preserves history/FKs and replays without the version ledger`, async t => {
    let db;
    if (driver === 'sqlite') {
      db = new SqliteStorage(':memory:');
      t.after(() => db.close());
      await db.exec('PRAGMA foreign_keys = ON');
    } else {
      const pg = new PGlite();
      t.after(() => pg.close());
      const adapt = connection => ({
        exec: sql => connection.exec(sql),
        all: async (sql, ...params) => (await connection.query(translatePlaceholders(sql), params)).rows,
        get: async (sql, ...params) => (await connection.query(translatePlaceholders(sql), params)).rows[0],
        run: (sql, ...params) => connection.query(translatePlaceholders(sql), params),
      });
      db = { ...adapt(pg), transaction: fn => pg.transaction(tx => fn(adapt(tx))) };
      await db.exec('CREATE SCHEMA physical_test; SET search_path TO physical_test;');
    }
    for (const file of ['001_init.sql', '002_operational_day.sql', '003_idempotency_keys.sql']) {
      await applyMigration(db, file, { driver });
    }
    await db.run('INSERT INTO sites (id, code, name, created_at) VALUES (?, ?, ?, ?)', ids.site, 'EXAMPLE', 'Example', at);
    await db.run(`INSERT INTO tasks (id, site_id, title, executor, verifier, status, created_at)
      VALUES (?, ?, 'Example', 'Executor', 'Verifier', 'blocked', ?)`, ids.task, ids.site, at);
    await db.run(`INSERT INTO task_events (task_id, at, actor, from_status, to_status)
      VALUES (?, ?, 'Executor', 'todo', 'blocked')`, ids.task, at);
    await db.run(`INSERT INTO diary (id, site_id, operational_date, shift, created_at)
      VALUES (?, ?, '2026-01-01', 'day', ?)`, ids.diary, ids.site, at);
    await db.run(`INSERT INTO idempotency_keys VALUES ('example', 'POST /api/tasks', 'example', 201, '{}', ?)`, at);
    const tables = ['sites', 'tasks', 'diary', 'task_events', 'idempotency_keys'];
    const snapshot = async () => JSON.parse(JSON.stringify(await Promise.all(tables.map(table => db.all(`SELECT * FROM ${table}`)))));
    const before = await snapshot();
    const foreignKeys = () => db.all(`SELECT conname, pg_get_constraintdef(oid) AS definition
      FROM pg_constraint WHERE contype = 'f' AND connamespace = current_schema()::regnamespace ORDER BY conname`);
    const fks = driver === 'pg' ? await foreignKeys() : null;
    await db.transaction(tx => applyMigration(tx, migration, { driver }));
    const after = await snapshot();
    const expected = structuredClone(before);
    expected[1][0] = { ...expected[1][0], blocked_from: null, submitted_by: null };
    expected[3][0] = { ...expected[3][0], action: null };
    t.assert.deepStrictEqual(after, expected);
    await db.transaction(tx => applyMigration(tx, migration, { driver }));
    t.assert.deepStrictEqual(await snapshot(), after);
    if (driver === 'pg') {
      // Exercise the raw SQL as well as the manual helper, with no ledger guard.
      await db.exec(await readFile(new URL(`../server/migrations/pg/${migration}`, import.meta.url), 'utf8'));
      await pgTypes(t, db);
      t.assert.deepStrictEqual(await foreignKeys(), fks);
    } else {
      for (const [table, name] of [['sites', 'id'], ['tasks', 'id'], ['diary', 'id'], ['task_events', 'at']]) {
        t.assert.strictEqual((await db.all(`PRAGMA table_info(${table})`)).find(col => col.name === name).type, 'TEXT');
      }
      t.assert.deepStrictEqual(await db.all('PRAGMA foreign_key_check'), []);
    }
    for (const [table, column] of [['tasks', 'site_id'], ['diary', 'site_id'], ['task_events', 'task_id']]) {
      await t.assert.rejects(() => db.run(`UPDATE ${table} SET ${column} = ?`, '00000000-0000-4000-8000-000000000099'), /foreign key/i);
    }
    await t.assert.rejects(() => db.run("UPDATE tasks SET status = 'unknown'"), /check/i);
    await t.assert.rejects(() => db.run("UPDATE task_events SET action = 'unknown'"), /check/i);
    await db.run(`INSERT INTO task_events (task_id, at, actor, from_status, to_status, action)
      VALUES (?, ?, 'Executor', 'blocked', 'todo', 'resume')`, ids.task, at);
    t.assert.strictEqual((await db.all('SELECT id FROM task_events ORDER BY id'))[1].id, 2);
  });
}

test('pg driver exposes UUID and timestamptz columns as JSON-compatible strings', { skip: !isPg }, async t => {
  const database = await openTestDb();
  t.after(database.close);
  const { db } = database;
  await pgTypes(t, db);
  const site = await createSite(db, { code: 'TYPES', name: 'Example' });
  const task = await createTask(db, { siteId: site.id, title: 'Example', executor: 'Executor', verifier: 'Verifier' });
  const diary = await createDiary(db, { siteId: site.id, shift: 'day' });
  for (const record of [site, task, diary]) {
    t.assert.strictEqual(typeof record.id, 'string');
    t.assert.match(record.created_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  }
  t.assert.strictEqual(typeof task.events[0].id, 'number');
  t.assert.strictEqual(task.events[0].at, task.created_at);
  // The pool-local timestamp parser also applies to transaction clients.
  await db.transaction(async tx => {
    const row = await tx.get("SELECT '2026-01-01T03:00:00+03:00'::timestamptz AS instant");
    t.assert.strictEqual(row.instant, at);
  });
  await db.exec(await readFile(new URL(`../server/migrations/pg/${migration}`, import.meta.url), 'utf8'));
  await pgTypes(t, db);
});
