import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { SqliteStorage } from '../server/storage/sqlite.mjs';
import { translatePlaceholders } from '../server/storage/pg.mjs';
import { applyMigration, migrate } from '../server/migrations/index.mjs';
import { createSite, createTask, createDiary, createAttachment, listAttachments, deleteAttachment } from '../server/repository.mjs';
import { MemoryObjectStorage } from './helpers/object-storage.mjs';

for (const driver of ['sqlite', 'pg']) {
  test(`007 upgrades populated ${driver}, preserves entities, enforces schema and replays safely`, async t => {
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
    await db.exec('CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
    for (const file of ['001_init.sql', '002_operational_day.sql', '003_idempotency_keys.sql', '004_physical_types.sql', '005_auth.sql', '006_signup.sql']) {
      await db.transaction(async tx => {
        await applyMigration(tx, file, { driver });
        await tx.run('INSERT INTO schema_migrations VALUES (?, ?)', file.slice(0, 3), new Date().toISOString());
      });
    }
    const site = await createSite(db, { code: 'SYNTHETIC', name: 'Synthetic upgrade site' });
    const task = await createTask(db, { siteId: site.id, title: 'Synthetic upgrade task', executor: 'A', verifier: 'B' });
    const diary = await createDiary(db, { siteId: site.id, shift: 'day' });
    const user = { id: randomUUID() };
    await db.run(`INSERT INTO users (id, email, name, password_hash, password_algo, created_at)
      VALUES (?, 'synthetic@example.invalid', 'Synthetic', 'unused', 'scrypt', ?)`, user.id, new Date().toISOString());
    await db.run("INSERT INTO site_members VALUES (?, ?, 'owner')", site.id, user.id);
    const tables = ['sites', 'tasks', 'task_events', 'diary', 'users', 'site_members'];
    const before = await Promise.all(tables.map(table => db.all(`SELECT * FROM ${table}`)));
    t.assert.strictEqual(await migrate(db, { driver }), 1);
    t.assert.deepStrictEqual(await Promise.all(tables.map(table => db.all(`SELECT * FROM ${table}`))), before);
    const storage = new MemoryObjectStorage();
    for (const [entity_type, entity_id] of [['site', site.id], ['task', task.id], ['diary', diary.id]]) {
      const file = await createAttachment(db, { entity_type, entity_id, filename: 'synthetic.pdf', content_type: 'application/pdf', data_base64: Buffer.from('%PDF synthetic').toString('base64') }, user, storage);
      t.assert.strictEqual(file.site_id, site.id);
      t.assert.strictEqual((await listAttachments(db, { site_id: site.id, entity_type, entity_id }, user))[0].id, file.id);
    }
    const attachments = await db.all('SELECT * FROM attachments ORDER BY id');
    await db.transaction(tx => applyMigration(tx, '007_attachments.sql', { driver }));
    t.assert.strictEqual(await migrate(db, { driver }), 0);
    t.assert.deepStrictEqual(await db.all('SELECT * FROM attachments ORDER BY id'), attachments);
    await t.assert.rejects(() => db.run("UPDATE attachments SET entity_type = 'invalid'"), /check/i);
    await t.assert.rejects(() => db.run('UPDATE attachments SET site_id = ?', randomUUID()), /foreign key/i);
    await t.assert.rejects(() => db.run('UPDATE attachments SET uploaded_by = ?', randomUUID()), /foreign key/i);
    await t.assert.rejects(() => db.run('UPDATE attachments SET filename = NULL'), /not.null/i);
    if (driver === 'pg') {
      const columns = await db.all("SELECT column_name, udt_name FROM information_schema.columns WHERE table_name = 'attachments'");
      for (const [column, type] of [['id', 'uuid'], ['site_id', 'uuid'], ['entity_id', 'uuid'], ['uploaded_by', 'uuid'], ['created_at', 'timestamptz'], ['size', 'int4']]) {
        t.assert.strictEqual(columns.find(row => row.column_name === column).udt_name, type);
      }
      t.assert.match((await db.get("SELECT indexdef FROM pg_indexes WHERE indexname = 'attachments_entity'")).indexdef, /\(site_id, entity_type, entity_id\)/);
    } else {
      t.assert.deepStrictEqual((await db.all('PRAGMA index_info(attachments_entity)')).map(row => row.name), ['site_id', 'entity_type', 'entity_id']);
    }
    for (const file of attachments) await deleteAttachment(db, file.id, user, storage);
    t.assert.strictEqual(storage.objects.size, 0);
    t.assert.deepStrictEqual(await db.all('SELECT * FROM attachments'), []);
  });
}
