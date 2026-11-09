import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { SqliteStorage } from '../server/storage/sqlite.mjs';
import { translatePlaceholders } from '../server/storage/pg.mjs';
import { applyMigration } from '../server/migrations/index.mjs';
import { seed } from '../server/seed.mjs';
import { createServer } from '../server/http.mjs';
import { requestListener } from './helpers/auth.mjs';

for (const driver of ['sqlite', 'pg']) {
  test(`005 upgrades populated ${driver} through applyMigration and preserves task history`, async t => {
    let db;
    if (driver === 'sqlite') {
      db = new SqliteStorage(':memory:'); t.after(() => db.close());
      await db.exec('PRAGMA foreign_keys = ON');
    } else {
      const pg = new PGlite(); t.after(() => pg.close());
      const adapt = connection => ({
        exec: sql => connection.exec(sql),
        all: async (sql, ...params) => (await connection.query(translatePlaceholders(sql), params)).rows,
        get: async (sql, ...params) => (await connection.query(translatePlaceholders(sql), params)).rows[0],
        run: async (sql, ...params) => ({ rowCount: (await connection.query(translatePlaceholders(sql), params)).affectedRows }),
        isUniqueViolation: error => error.code === '23505',
      });
      db = { ...adapt(pg), transaction: fn => pg.transaction(tx => fn(adapt(tx))) };
    }
    for (const file of ['001_init.sql', '002_operational_day.sql', '003_idempotency_keys.sql', '004_physical_types.sql']) {
      await db.transaction(tx => applyMigration(tx, file, { driver }));
    }
    const site = '00000000-0000-4000-8000-000000000001', task = '00000000-0000-4000-8000-000000000002';
    await db.run("INSERT INTO sites (id, code, name, created_at) VALUES (?, 'UPGRADE', 'Synthetic site', ?)", site, '2026-01-01T00:00:00.000Z');
    await db.run(`INSERT INTO tasks (id, site_id, title, executor, verifier, submitted_by, created_at)
      VALUES (?, ?, 'Synthetic task', 'A', 'B', 'A', ?)`, task, site, '2026-01-01T00:00:00.000Z');
    await db.run(`INSERT INTO task_events (task_id, at, actor, from_status, to_status, action)
      VALUES (?, ?, 'A', 'todo', 'todo', 'create')`, task, '2026-01-01T00:00:00.000Z');
    const before = await db.get('SELECT * FROM tasks WHERE id = ?', task);
    const events = await db.all('SELECT * FROM task_events');
    await db.transaction(tx => applyMigration(tx, '005_auth.sql', { driver }));
    t.assert.deepStrictEqual({ ...await db.get('SELECT * FROM tasks WHERE id = ?', task) }, {
      ...before, executor_id: null, verifier_id: null, submitted_by_id: null,
    });
    t.assert.deepStrictEqual(await db.all('SELECT * FROM task_events'), events);
    if (driver === 'pg') {
      await db.transaction(tx => applyMigration(tx, '005_auth.sql', { driver }));
      const columns = await db.all("SELECT table_name, column_name, udt_name FROM information_schema.columns WHERE table_schema = 'public'");
      for (const [table, column, type] of [
        ['users', 'id', 'uuid'], ['users', 'email', 'text'], ['users', 'created_at', 'timestamptz'],
        ['sessions', 'id', 'uuid'], ['sessions', 'user_id', 'uuid'], ['sessions', 'expires_at', 'timestamptz'],
        ['site_members', 'site_id', 'uuid'], ['site_members', 'user_id', 'uuid'],
        ...['executor_id', 'verifier_id', 'submitted_by_id'].map(column => ['tasks', column, 'uuid']),
      ]) t.assert.strictEqual(columns.find(row => row.table_name === table && row.column_name === column).udt_name, type);
    }
    await seed(db, { reset: true });
    const user = await db.get("SELECT id FROM users WHERE email = 'editor@example.invalid'");
    for (const column of ['executor_id', 'verifier_id', 'submitted_by_id']) {
      await t.assert.rejects(() => db.run(`UPDATE tasks SET ${column} = ?`, '00000000-0000-4000-8000-000000000099'), /foreign key/i);
    }
    await t.assert.rejects(() => db.run("UPDATE site_members SET role = 'unknown'"), /check/i);
    await t.assert.rejects(() => db.run("UPDATE users SET email = 'OWNER@EXAMPLE.INVALID' WHERE id = ?", user.id), /unique/i);
    await db.transaction(tx => applyMigration(tx, '006_signup.sql', { driver }));
    const request = requestListener(createServer(db));
    const result = await request('/api/auth/login', { method: 'POST', body: { email: 'owner@example.invalid', password: 'Local-owner-5b!' } });
    t.assert.strictEqual(result.status, 200);
    const me = await request('/api/auth/me', { cookie: result.headers['set-cookie'].split(';')[0] });
    t.assert.strictEqual(me.status, 200); t.assert.strictEqual(me.body.roles.length, 2);
  });
}
