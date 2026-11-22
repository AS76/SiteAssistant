import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { createSite } from '../../server/repository.mjs';
import { createPurchaseOrder, addPurchaseOrderItem } from '../../server/purchase-orders.mjs';
import { saveModuleAccess } from '../../server/module-access.mjs';
import { translatePlaceholders } from '../../server/storage/pg.mjs';
import { migrate, applyMigration } from '../../server/migrations/index.mjs';
import { openDb, closeDb } from '../../server/db.mjs';

export async function database(t, driver, initialize = true) {
  if (driver === 'sqlite') {
    const db = await openDb(':memory:', { driver, migrate: initialize });
    t.after(() => closeDb(db));
    return db;
  }
  const pg = new PGlite();
  t.after(() => pg.close());
  const adapt = connection => ({
    exec: sql => connection.exec(sql),
    all: async (sql, ...values) => (await connection.query(translatePlaceholders(sql), values)).rows,
    get: async (sql, ...values) => (await connection.query(translatePlaceholders(sql), values)).rows[0],
    run: async (sql, ...values) => ({ rowCount: (await connection.query(translatePlaceholders(sql), values)).affectedRows }),
    isUniqueViolation: error => error.code === '23505',
  });
  const db = { ...adapt(pg), transaction: fn => pg.transaction(tx => fn(adapt(tx))) };
  if (initialize) await migrate(db, { driver });
  return db;
}

export async function purchasingFixture(db, users, { grants = true } = {}) {
  const site = await createSite(db, { code: randomUUID(), name: 'Synthetic procurement site' });
  for (const role of ['owner', 'editor', 'verifier', 'viewer']) {
    await db.run('INSERT INTO site_members VALUES (?, ?, ?)', site.id, users[role].id, role);
    if (grants && role !== 'owner') await saveModuleAccess(db, {
      siteId: site.id, memberId: users[role].id, module: 'logistics', allowed: true,
    }, users.owner);
  }
  const order = await createPurchaseOrder(db, {
    siteId: site.id, poNo: 'PO-001', supplierName: 'Synthetic supplier', orderedOn: '2026-01-15',
  }, users.owner);
  const item = await addPurchaseOrderItem(db, order.id, {
    materialNo: 'MAT-001', description: 'Synthetic material', unit: 'piece', quantity: '10.125',
  }, users.owner);
  return { site, order, item, packageInput: {
    siteId: site.id, purchaseOrderId: order.id, items: [{ purchaseOrderItemId: item.id, quantityPacked: '1.125' }],
  } };
}

export function failAudit(db, entityType) {
  return { isUniqueViolation: error => db.isUniqueViolation(error),
    transaction: fn => db.transaction(tx => fn({ ...tx, run: async (sql, ...values) => {
    if (sql.startsWith('INSERT INTO audit_events') && values[2] === entityType) throw new Error('Synthetic audit failure');
    return await tx.run(sql, ...values);
  } })) };
}

export async function auditUpgrade(t, driver, file, oldType, newTypes) {
  const db = await database(t, driver, false);
  await db.exec('CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  const files = (await readdir(new URL(`../../server/migrations/${driver}/`, import.meta.url)))
    .filter(name => /^\d{3}_.*\.sql$/.test(name) && name < file).sort();
  for (const name of files) await db.transaction(async tx => {
    await applyMigration(tx, name, { driver });
    await tx.run('INSERT INTO schema_migrations VALUES (?, ?)', name.slice(0, 3), new Date().toISOString());
  });
  const site = { id: randomUUID() };
  await db.run('INSERT INTO sites (id, code, name, created_at) VALUES (?, ?, ?, ?)',
    site.id, randomUUID(), 'Synthetic upgrade site', new Date().toISOString());
  const insert = (type, action = 'create') => db.run(`INSERT INTO audit_events
    (id, site_id, entity_type, entity_id, action, at, actor, changes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  randomUUID(), site.id, type, randomUUID(), action, new Date().toISOString(), randomUUID(), '{}');
  await insert(oldType);
  await insert(oldType, 'read');
  const before = await db.all('SELECT * FROM audit_events ORDER BY id');
  await t.assert.rejects(() => insert(newTypes[0]), /check/i);
  await migrate(db, { driver });
  t.assert.deepStrictEqual(await db.all('SELECT * FROM audit_events ORDER BY id'), before);
  for (const type of newTypes) await insert(type);
  await t.assert.rejects(() => insert('invalid'), /check/i);
  await t.assert.rejects(() => insert(newTypes[0], 'invalid'), /check/i);
  t.assert.strictEqual(await migrate(db, { driver }), 0);
  if (driver === 'sqlite') {
    t.assert.deepStrictEqual(await db.all('PRAGMA foreign_key_check'), []);
    t.assert.deepStrictEqual((await db.all('PRAGMA index_info(audit_events_site_entity)')).map(row => row.name),
      ['site_id', 'entity_type', 'entity_id', 'at', 'id']);
  } else {
    t.assert.match((await db.get("SELECT indexdef FROM pg_indexes WHERE indexname = 'audit_events_site_entity'")).indexdef,
      /\(site_id, entity_type, entity_id, at, id\)/);
  }
}
