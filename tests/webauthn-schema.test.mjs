import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { SqliteStorage } from '../server/storage/sqlite.mjs';
import { translatePlaceholders } from '../server/storage/pg.mjs';
import { createWebAuthn } from '../server/webauthn.mjs';
import { migrate } from '../server/migrations/index.mjs';

for (const driver of ['sqlite', 'pg']) {
  test(`035 WebAuthn schema constraints and append-only audit on ${driver}`, async t => {
    let db;
    if (driver === 'sqlite') {
      db = new SqliteStorage(':memory:'); t.after(() => db.close());
      await db.exec('PRAGMA foreign_keys = ON');
    } else {
      const pg = new PGlite(); t.after(() => pg.close());
      const adapt = connection => ({
        exec: sql => connection.exec(sql),
        get: async (sql, ...params) => (await connection.query(translatePlaceholders(sql), params)).rows[0],
        all: async (sql, ...params) => (await connection.query(translatePlaceholders(sql), params)).rows,
        run: (sql, ...params) => connection.query(translatePlaceholders(sql), params),
      });
      db = { ...adapt(pg), transaction: fn => pg.transaction(tx => fn(adapt(tx))) };
    }
    await migrate(db, { driver });
    const user = randomUUID(), id = randomUUID(), at = '2026-01-01T00:00:00.000Z';
    await db.run(`INSERT INTO users (id, email, name, password_hash, password_algo, created_at)
      VALUES (?, 'test@example.invalid', 'Synthetic user', 'unused', 'scrypt', ?)`, user, at);
    t.assert.equal((await db.get('SELECT email_verified_at FROM users WHERE id = ?', user)).email_verified_at, null);
    const insert = (id, owner, credential) => db.run(`INSERT INTO webauthn_credentials
      (id, user_id, credential_id, public_key, sign_count, transports, name, backup_eligible, backup_state, user_verified, created_at)
      VALUES (?, ?, ?, ?, 0, '[]', 'Test passkey', ?, ?, ?, ?)`, id, owner, credential, Buffer.from([1, 2]), 1, 0, 1, at);
    await insert(id, user, 'synthetic-key');
    const stored = await db.get('SELECT public_key, transports FROM webauthn_credentials WHERE id = ?', id);
    t.assert.deepEqual([...stored.public_key], [1, 2]);
    t.assert.deepEqual(JSON.parse(stored.transports), []);
    const api = createWebAuthn(db, { rpID: 'example.invalid', origin: 'https://example.invalid',
      authenticationOptions: async options => ({ ...options, challenge: 'synthetic-challenge' }),
    });
    t.assert.deepEqual((await api.credentials({ id: user }))[0].transports, []);
    t.assert.deepEqual((await api.loginOptions({ email: 'test@example.invalid' })).allowCredentials,
      [{ id: 'synthetic-key', transports: [] }]);
    await t.assert.rejects(() => insert(randomUUID(), user, 'synthetic-key'), /unique/i);
    await t.assert.rejects(() => insert(randomUUID(), randomUUID(), 'other-key'), /foreign key/i);
    await t.assert.rejects(() => db.run(`INSERT INTO webauthn_challenges
      (id, kind, challenge_hash, expires_at, created_at) VALUES (?, 'invalid', 'hash', ?, ?)`, randomUUID(), at, at), /check/i);
    await db.run(`INSERT INTO auth_events (id, user_id, event, outcome, detail_json, created_at)
      VALUES (?, ?, 'test', 'success', '{}', ?)`, randomUUID(), user, at);
    await t.assert.rejects(() => db.run("UPDATE auth_events SET outcome = 'failure'"), /append-only/i);
    await t.assert.rejects(() => db.run('DELETE FROM auth_events'), /append-only/i);
    await db.run('DELETE FROM users WHERE id = ?', user);
    t.assert.equal((await db.all('SELECT * FROM webauthn_credentials')).length, 0);
    t.assert.equal((await db.all('SELECT * FROM auth_events')).length, 1);
    t.assert.equal((await db.get('SELECT user_id FROM auth_events')).user_id, user);
    await db.run(`INSERT INTO auth_events (id, user_id, event, outcome, detail_json, created_at)
      VALUES (?, NULL, 'test', 'failure', '{}', ?)`, randomUUID(), at);
    t.assert.equal((await db.all('SELECT * FROM auth_events WHERE user_id IS NULL')).length, 1);
    const sessions = await db.all('SELECT auth_method, assurance, last_seen_at, credential_id FROM sessions');
    t.assert.deepEqual(sessions, []);
    if (driver === 'pg') {
      await t.assert.rejects(() => db.exec('TRUNCATE auth_events'), /append-only/i);
      const columns = await db.all("SELECT table_name, column_name, udt_name FROM information_schema.columns WHERE table_schema = 'public'");
      for (const [table, column, type] of [
        ['webauthn_credentials', 'public_key', 'bytea'], ['webauthn_credentials', 'user_id', 'uuid'],
        ['webauthn_credentials', 'backup_state', 'bool'], ['webauthn_challenges', 'expires_at', 'timestamptz'],
        ['sessions', 'credential_id', 'uuid'],
      ]) t.assert.equal(columns.find(c => c.table_name === table && c.column_name === column).udt_name, type);
    }
  });
}
