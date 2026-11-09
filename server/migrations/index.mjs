import { readdir, readFile } from 'node:fs/promises';

// Also usable for a manual replay, independently of schema_migrations.
// SQLite has no ADD COLUMN IF NOT EXISTS; keep its 004 SQL additive only.
export async function applyMigration(tx, file, { driver }) {
  if (!['sqlite', 'pg'].includes(driver) || !/^\d{3}_[a-z_]+\.sql$/.test(file)) {
    throw new Error('Invalid migration selection.');
  }
  const sql = await readFile(new URL(`./${driver}/${file}`, import.meta.url), 'utf8');
  if (driver !== 'sqlite' || file !== '004_physical_types.sql') return await tx.exec(sql);
  for (const statement of sql.split(';').filter(part => part.trim())) {
    const match = /^\s*ALTER TABLE (\w+) ADD COLUMN (\w+)\s/i.exec(statement);
    if (!match) throw new Error('Expected an additive SQLite 004 statement.');
    const [, table, column] = match;
    const columns = await tx.all(`PRAGMA table_info(${table})`);
    if (!columns.some(existing => existing.name === column)) await tx.exec(statement);
  }
}

export async function migrate(db, { driver }) {
  if (!['sqlite', 'pg'].includes(driver)) throw new Error(`Unknown DB_DRIVER: ${driver}`);
  const directory = new URL(`./${driver}/`, import.meta.url);
  const files = (await readdir(directory)).filter(name => /^\d{3}_.+\.sql$/.test(name)).sort();
  await db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
  );`);
  let applied = 0;
  for (const file of files) {
    const version = file.slice(0, 3);
    const changed = await db.transaction(async tx => {
      if (await tx.get('SELECT version FROM schema_migrations WHERE version = ?', version)) return;
      await applyMigration(tx, file, { driver });
      await tx.run('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)',
        version, new Date().toISOString());
      return true;
    });
    if (changed) applied++;
  }
  return applied;
}
