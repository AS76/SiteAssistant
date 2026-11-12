import { migrate } from './migrations/index.mjs';
import { SqliteStorage, PgStorage } from './storage/index.mjs';

// DATA_DIR is the database pathname; its parent directory must already exist.
// An explicit location overrides DATA_DIR (SQLite) or DATABASE_URL (pg).
// migrate defaults to true. Use migrate: false only in inspection/diagnostic
// scripts, never in the server. It skips migrations and onMigrationsApplied
// without checking the schema version; compatibility is the caller's responsibility.
export async function openDb(location, { driver = process.env.DB_DRIVER || 'sqlite', schema = 'app', migrate: shouldMigrate = true, onMigrationsApplied } = {}) {
  if (!['sqlite', 'pg'].includes(driver)) throw new Error(`Unknown DB_DRIVER: ${driver}`);
  const db = driver === 'pg'
    ? new PgStorage(location ?? process.env.DATABASE_URL, { schema })
    : new SqliteStorage(location ?? (process.env.DATA_DIR || './data/app.db'));
  try {
    if (driver === 'pg') await db.open();
    if (driver === 'sqlite') await db.exec('PRAGMA foreign_keys = ON;');
    if (shouldMigrate) {
      const applied = await migrate(db, { driver });
      if (applied > 0) onMigrationsApplied?.(applied);
    }
    return db;
  } catch (error) {
    await db.close();
    throw error;
  }
}

export async function closeDb(db) {
  await db.close();
}
