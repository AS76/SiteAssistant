import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { SqliteStorage } from '../server/storage/sqlite.mjs';
import { translatePlaceholders } from '../server/storage/pg.mjs';
import { applyMigration, migrate } from '../server/migrations/index.mjs';
import { createUser } from '../server/create-user.mjs';

for (const driver of ['sqlite', 'pg']) {
  test(`006 upgrades populated ${driver}, preserves users/sessions and replays safely`, async t => {
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
      });
      db = { ...adapt(pg), transaction: fn => pg.transaction(tx => fn(adapt(tx))) };
    }
    await db.exec('CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
    for (const file of ['001_init.sql', '002_operational_day.sql', '003_idempotency_keys.sql', '004_physical_types.sql', '005_auth.sql']) {
      await db.transaction(async tx => {
        await applyMigration(tx, file, { driver });
        await tx.run('INSERT INTO schema_migrations VALUES (?, ?)', file.slice(0, 3), new Date().toISOString());
      });
    }
    const user = await createUser(db, { email: 'upgrade@example.invalid', name: 'Synthetic upgrade', password: 'Synthetic-password!' });
    await db.run('INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)', randomUUID(), user.id, 'a'.repeat(64), '2026-01-01T00:00:00.000Z', '2026-01-08T00:00:00.000Z');
    const before = await db.get('SELECT * FROM users'), sessions = await db.all('SELECT * FROM sessions');
    t.assert.strictEqual(await migrate(db, { driver }), 13);
    const after = await db.get('SELECT * FROM users');
    t.assert.strictEqual(Boolean(after.password_change_required), false);
    delete after.password_change_required;
    t.assert.deepStrictEqual(after, before);
    t.assert.deepStrictEqual(await db.all('SELECT * FROM sessions'), sessions);
    for (let i = 0; i < 2; i++) {
      if (driver === 'pg') await db.transaction(tx => applyMigration(tx, '006_signup.sql', { driver }));
      t.assert.strictEqual(await migrate(db, { driver }), 0);
    }
    t.assert.deepStrictEqual((await db.all('SELECT version FROM schema_migrations ORDER BY version')).map(row => row.version), ['001', '002', '003', '004', '005', '006', '007', '008', '009', '010', '011', '012', '013', '014', '015', '016', '017', '018']);
    if (driver === 'pg') {
      const columns = await db.all("SELECT table_name, column_name, udt_name FROM information_schema.columns WHERE table_schema = 'public'");
      for (const [table, column, type] of [['users', 'password_change_required', 'bool'], ['signup_requests', 'id', 'uuid'], ['signup_requests', 'requested_at', 'timestamptz'], ['signup_requests', 'decided_at', 'timestamptz']]) {
        t.assert.strictEqual(columns.find(row => row.table_name === table && row.column_name === column).udt_name, type);
      }
    }
    const insert = (status, email, hash) => db.run('INSERT INTO signup_requests (id, email, decision_token_hash, status, requested_at) VALUES (?, ?, ?, ?, ?)', randomUUID(), email, hash, status, new Date().toISOString());
    await insert('pending', 'pending@example.invalid', 'b'.repeat(64));
    await t.assert.rejects(() => insert('pending', 'PENDING@EXAMPLE.INVALID', 'c'.repeat(64)), /unique/i);
    await t.assert.rejects(() => insert('unknown', 'other@example.invalid', 'd'.repeat(64)), /check/i);
    await t.assert.rejects(() => db.run('UPDATE users SET password_change_required = NULL'), /not.null/i);
    await db.run("UPDATE signup_requests SET status = 'rejected'");
    await insert('pending', 'pending@example.invalid', 'e'.repeat(64));
    t.assert.strictEqual((await db.all('SELECT * FROM signup_requests')).length, 2);
  });
}
