import { writeFile } from 'node:fs/promises';
import { openSqliteTestDb, openTestDb, isPg } from '../tests/helpers/db.mjs';
import { fixtureRoot, json } from '../tests/helpers/migration-manifest.mjs';
import { assertUpgrade, verifyManifest } from '../tests/helpers/migrations.mjs';
import { assertPg16, catalog } from '../tests/helpers/migration-schema.mjs';

const [engine, ...extra] = process.argv.slice(2);
if (!['sqlite', 'pg16'].includes(engine) || extra.length || (engine === 'pg16' && !isPg)) {
  throw new Error('Select sqlite, or select pg16 with DB_DRIVER=pg and DATABASE_URL_TEST configured');
}
await verifyManifest();
const database = engine === 'sqlite'
  ? await openSqliteTestDb(':memory:', { migrate: false })
  : await openTestDb(':memory:', { migrate: false });
try {
  const { db } = database;
  const driver = engine === 'sqlite' ? 'sqlite' : 'pg';
  if (engine === 'pg16') await assertPg16(db);
  await assertUpgrade(db, { driver });
  await writeFile(new URL(`${engine}.schema.json`, fixtureRoot), json(await catalog(db, driver)));
} finally {
  await database.close();
}
