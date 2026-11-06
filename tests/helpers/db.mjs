import { randomUUID } from 'node:crypto';
import { openDb, closeDb } from '../../server/db.mjs';
import { PgStorage } from '../../server/storage/pg.mjs';

export const isPg = process.env.DB_DRIVER === 'pg';
const connectionString = process.env.DATABASE_URL_TEST;

// Abort at startup, before any fixture can run application DDL. Never fall
// back to DATABASE_URL, and reject the operational database before connecting.
if (isPg) {
  if (!connectionString) throw new Error('DATABASE_URL_TEST is required for pg tests.');
  const expected = process.env.SA_TEST_DB || 'siteassistant_test';
  let url;
  try { url = new URL(connectionString); }
  catch { throw new Error('DATABASE_URL_TEST must be a PostgreSQL URL.'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) ||
      expected === 'siteassistant' || decodeURI(url.pathname.slice(1)) !== expected) {
    throw new Error('DATABASE_URL_TEST must target the test database specified by SA_TEST_DB (default siteassistant_test).');
  }
  const guard = new PgStorage(connectionString);
  try {
    const row = await guard.get('SELECT current_database() AS database');
    if (row.database !== expected) throw new Error('Refusing pg tests: current_database() does not match the test database.');
  } finally {
    await closeDb(guard);
  }
}

// Explicit SQLite fixture also supplies the baseline in a pg parity run.
export async function openSqliteTestDb(path = ':memory:') {
  const db = await openDb(path, { driver: 'sqlite' });
  return { db, reopen: () => openDb(path, { driver: 'sqlite' }), close: () => closeDb(db) };
}

export async function openTestDb(path = ':memory:') {
  if (!isPg) return await openSqliteTestDb(path);

  const schema = `t_${randomUUID().replaceAll('-', '_')}`;
  const dropSchema = async () => {
    const admin = new PgStorage(connectionString);
    try { await admin.exec(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
    finally { await closeDb(admin); }
  };
  let db;
  try {
    db = await openDb(connectionString, { schema });
  } catch (error) {
    await dropSchema();
    throw error;
  }
  return {
    db,
    reopen: () => openDb(connectionString, { schema }),
    close: async () => {
      try { await closeDb(db); }
      finally { await dropSchema(); }
    },
  };
}
