export const DEMO_SEED_MARKER = 'siteassistant-demo-v1';

export function requireDemoAppEnv() {
  if (process.env.APP_ENV !== 'demo') throw new Error('Demo seed operation requires APP_ENV=demo.');
}

export async function requireDemoDatabase(db) {
  requireDemoAppEnv();
  let row;
  try {
    const lock = await demoDatabaseIsSqlite(db) ? '' : ' FOR UPDATE';
    row = await db.get(`SELECT marker FROM demo_seed_environment WHERE singleton = 1${lock}`);
  } catch (error) {
    if (error.code !== '42P01' &&
        !(error.code === 'ERR_SQLITE_ERROR' && error.message === 'no such table: demo_seed_environment')) throw error;
    throw new Error('Missing demo_seed_environment table. Apply database migration 055 before provisioning the demo database.', { cause: error });
  }
  if (row?.marker !== DEMO_SEED_MARKER) {
    throw new Error('Demo database marker is missing or invalid.');
  }
}

// Both engines accept this expression and encode boolean literals differently.
export async function demoDatabaseIsSqlite(db) {
  return (await db.get('SELECT CAST(TRUE AS TEXT) AS value')).value === '1';
}
