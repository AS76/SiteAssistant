import test from 'node:test';
import { readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { SqliteStorage } from '../server/storage/sqlite.mjs';
import { translatePlaceholders } from '../server/storage/pg.mjs';
import { applyMigration, migrate } from '../server/migrations/index.mjs';
import { createSite, createTask, createDiary, createAttachment, listAttachments, deleteAttachment } from '../server/repository.mjs';
import { MemoryObjectStorage } from './helpers/object-storage.mjs';

async function schemaDb(t, driver) {
  if (driver === 'sqlite') {
    const db = new SqliteStorage(':memory:'); t.after(() => db.close());
    await db.exec('PRAGMA foreign_keys = ON');
    return db;
  }
  const pg = new PGlite(); t.after(() => pg.close());
  const adapt = connection => ({
    exec: sql => connection.exec(sql),
    all: async (sql, ...params) => (await connection.query(translatePlaceholders(sql), params)).rows,
    get: async (sql, ...params) => (await connection.query(translatePlaceholders(sql), params)).rows[0],
    run: async (sql, ...params) => ({ rowCount: (await connection.query(translatePlaceholders(sql), params)).affectedRows }),
    isUniqueViolation: error => error.code === '23505',
  });
  return { ...adapt(pg), transaction: fn => pg.transaction(tx => fn(adapt(tx))) };
}

for (const driver of ['sqlite', 'pg']) {
  test(`007 upgrades populated ${driver}, preserves entities, enforces schema and replays safely`, async t => {
    const db = await schemaDb(t, driver);
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
    t.assert.strictEqual(await migrate(db, { driver }), 21);
    // Increment 12 adds only a nullable reserved column to existing task rows.
    for (const row of before[tables.indexOf('tasks')]) row.kind = null;
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

  test(`027 upgrades populated ${driver} from 026, preserves attachments and rolls back safely`, async t => {
    const db = await schemaDb(t, driver);
    await db.exec('CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
    const files = (await readdir(new URL(`../server/migrations/${driver}/`, import.meta.url)))
      .filter(file => /^\d{3}_.+\.sql$/.test(file) && file < '027').sort();
    for (const file of files) {
      await db.transaction(async tx => {
        await applyMigration(tx, file, { driver });
        await tx.run('INSERT INTO schema_migrations VALUES (?, ?)', file.slice(0, 3), '2026-01-01T00:00:00.000Z');
      });
    }
    const site = await createSite(db, { code: 'SYNTHETIC', name: 'Synthetic attachment upgrade' });
    const userId = randomUUID();
    await db.run(`INSERT INTO users (id, email, name, password_hash, password_algo, created_at)
      VALUES (?, 'upgrade@example.invalid', 'Synthetic user', 'unused', 'scrypt', ?)`, userId, '2026-01-01T00:00:00.000Z');
    for (const entityType of ['task', 'diary', 'site']) {
      await db.run(`INSERT INTO attachments (id, site_id, entity_type, entity_id, filename, mime, size,
        content_sha256, storage_locator, manifest_version, uploaded_by, created_at)
        VALUES (?, ?, ?, ?, ?, 'application/pdf', 42, ?, ?, 'v1', ?, ?)`,
      randomUUID(), site.id, entityType, entityType === 'site' ? site.id : randomUUID(),
      `Synthetic ${entityType}.pdf`, 'a'.repeat(64), `synthetic/${entityType}/v1`,
      entityType === 'diary' ? null : userId, '2026-01-02T03:04:05.000Z');
    }
    const before = await db.all('SELECT * FROM attachments ORDER BY id');
    const versions = await db.all('SELECT * FROM schema_migrations ORDER BY version');
    t.assert.strictEqual(versions.at(-1).version, '026');
    await t.assert.rejects(() => db.run("UPDATE attachments SET entity_type = 'hse_event'"), /check/i);

    const failing = {
      exec: db.exec.bind(db),
      transaction: fn => db.transaction(tx => fn({
        ...tx, exec: async sql => {
          await tx.exec(sql);
          throw new Error('Synthetic migration failure');
        },
      })),
    };
    await t.assert.rejects(() => migrate(failing, { driver }), /Synthetic migration failure/);
    t.assert.deepStrictEqual(await db.all('SELECT * FROM attachments ORDER BY id'), before);
    t.assert.deepStrictEqual(await db.all('SELECT * FROM schema_migrations ORDER BY version'), versions);
    await t.assert.rejects(() => db.run("UPDATE attachments SET entity_type = 'hse_event'"), /check/i);

    t.assert.strictEqual(await migrate(db, { driver }), 1);
    t.assert.deepStrictEqual(await db.all('SELECT * FROM attachments ORDER BY id'), before);
    await db.run(`INSERT INTO attachments (id, site_id, entity_type, entity_id, filename, mime, size,
      content_sha256, storage_locator, created_at) VALUES (?, ?, 'hse_event', ?, 'Synthetic condition.png',
      'image/png', 0, ?, 'synthetic/hse/v1', ?)`, randomUUID(), site.id, randomUUID(), 'b'.repeat(64), '2026-01-02T03:04:05.000Z');
    const hse = await db.get("SELECT * FROM attachments WHERE entity_type = 'hse_event'");
    t.assert.strictEqual(hse.manifest_version, 'v1');
    t.assert.strictEqual(hse.uploaded_by, null);
    await t.assert.rejects(() => db.run("UPDATE attachments SET entity_type = 'invalid'"), /check/i);
    await t.assert.rejects(() => db.run('UPDATE attachments SET site_id = ?', randomUUID()), /foreign key/i);
    await t.assert.rejects(() => db.run('UPDATE attachments SET uploaded_by = ?', randomUUID()), /foreign key/i);
    await t.assert.rejects(() => db.run('UPDATE attachments SET filename = NULL'), /not.null/i);
    await t.assert.rejects(() => db.run('UPDATE attachments SET id = ?', hse.id), /unique/i);
    if (driver === 'sqlite') {
      t.assert.deepStrictEqual((await db.all('PRAGMA index_info(attachments_entity)')).map(row => row.name), ['site_id', 'entity_type', 'entity_id']);
      t.assert.deepStrictEqual(await db.all('PRAGMA foreign_key_check'), []);
    } else {
      t.assert.match((await db.get("SELECT indexdef FROM pg_indexes WHERE indexname = 'attachments_entity'")).indexdef, /\(site_id, entity_type, entity_id\)/);
    }
    const after = await db.all('SELECT * FROM attachments ORDER BY id');
    const applied = await db.all('SELECT * FROM schema_migrations ORDER BY version');
    t.assert.strictEqual(applied.at(-1).version, '027');
    t.assert.strictEqual(await migrate(db, { driver }), 0);
    t.assert.deepStrictEqual(await db.all('SELECT * FROM attachments ORDER BY id'), after);
    t.assert.deepStrictEqual(await db.all('SELECT * FROM schema_migrations ORDER BY version'), applied);
  });
}
