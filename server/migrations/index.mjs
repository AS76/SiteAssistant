import { readdir, readFile } from 'node:fs/promises';

export async function migrate(db, { driver }) {
  if (!['sqlite', 'pg'].includes(driver)) throw new Error(`Unknown DB_DRIVER: ${driver}`);
  const directory = new URL(`./${driver}/`, import.meta.url);
  const files = (await readdir(directory)).filter(name => /^\d{3}_.+\.sql$/.test(name)).sort();
  await db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
  );`);
  for (const file of files) {
    const version = file.slice(0, 3);
    await db.transaction(async tx => {
      if (await tx.get('SELECT version FROM schema_migrations WHERE version = ?', version)) return;
      await tx.exec(await readFile(new URL(file, directory), 'utf8'));
      await tx.run('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)',
        version, new Date().toISOString());
    });
  }
}
