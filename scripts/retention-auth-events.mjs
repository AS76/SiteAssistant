import { statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import pg from 'pg';

const triggerQuery = `
  SELECT tgenabled AS mode
  FROM pg_catalog.pg_trigger
  WHERE tgrelid = 'app.auth_events'::regclass
    AND tgname = 'auth_events_no_mutation'
    AND tgtype = 27
    AND NOT tgisinternal
`;
const olderThan = 'FROM app.auth_events WHERE created_at < $1::timestamptz';

class MaintenanceError extends Error {}

export function parseMaintenanceOptions(args, env) {
  if (args.some((arg) => !['--apply', '--confirm', '--dry-run'].includes(arg))) {
    throw new MaintenanceError('Unknown retention option.');
  }
  const apply = args.includes('--apply');
  if (apply && (!args.includes('--confirm') || args.includes('--dry-run'))) {
    throw new MaintenanceError('--apply requires --confirm and cannot be combined with --dry-run.');
  }
  const connectionString = env.RETENTION_MAINTENANCE_DATABASE_URL?.trim();
  if (!connectionString) {
    throw new MaintenanceError('RETENTION_MAINTENANCE_DATABASE_URL is required.');
  }
  if (!/^postgres(?:ql)?:\/\/[^/]/.test(connectionString)) {
    throw new MaintenanceError('A PostgreSQL connection URL is required.');
  }
  const expectedRole = env.RETENTION_MAINTENANCE_EXPECTED_ROLE;
  if (!expectedRole?.trim()) {
    throw new MaintenanceError('RETENTION_MAINTENANCE_EXPECTED_ROLE is required.');
  }
  if (apply) {
    const manifest = env.RETENTION_BACKUP_MANIFEST;
    if (env.RETENTION_BACKUP_VERIFIED !== '1' || !manifest?.trim()) {
      throw new MaintenanceError('Apply requires RETENTION_BACKUP_VERIFIED=1 and RETENTION_BACKUP_MANIFEST.');
    }
    try {
      if (!statSync(manifest).isFile()) throw new Error();
    } catch {
      throw new MaintenanceError('RETENTION_BACKUP_MANIFEST must point to an existing file.');
    }
  }
  const rawDays = env.RETENTION_AUTH_EVENTS_DAYS?.trim() ?? '';
  const days = /^\d+$/.test(rawDays) ? Number(rawDays) : 0;
  return { apply, connectionString, expectedRole, days: Number.isSafeInteger(days) && days > 0 ? days : 90 };
}

export async function runMaintenance(client, { apply, expectedRole, days }, now = Date.now()) {
  const cutoffDate = new Date(now - days * 86_400_000);
  if (cutoffDate.getUTCFullYear() < 1 || !Number.isFinite(cutoffDate.getTime())) {
    throw new MaintenanceError('Retention cutoff is outside the supported date range.');
  }
  const cutoff = cutoffDate.toISOString();
  const { rows: [{ database_user: databaseUser }] } = await client.query('SELECT current_user AS database_user');
  if (databaseUser !== expectedRole) {
    throw new MaintenanceError('PostgreSQL current_user does not match the expected maintenance role.');
  }
  const readTriggerMode = async () => (await client.query(triggerQuery)).rows[0]?.mode ?? null;
  const triggerState = await readTriggerMode();
  if (!apply) {
    const { rows: [{ count }] } = await client.query(`SELECT count(*) ${olderThan}`, [cutoff]);
    return { applied: false, cutoff, count: Number(count), deleted: 0, databaseUser, triggerState };
  }
  if (!['O', 'A'].includes(triggerState)) {
    throw new MaintenanceError('auth_events_no_mutation must be enabled for normal writes.');
  }

  await client.query('BEGIN');
  try {
    // Hold the same lock as ALTER TABLE before checking the trigger again.
    await client.query('LOCK TABLE app.auth_events IN SHARE ROW EXCLUSIVE MODE');
    if (await readTriggerMode() !== triggerState) {
      throw new MaintenanceError('auth_events_no_mutation changed before the maintenance lock was acquired.');
    }
    await client.query('ALTER TABLE app.auth_events DISABLE TRIGGER auth_events_no_mutation');
    const { rowCount: deleted } = await client.query(`DELETE ${olderThan}`, [cutoff]);
    const enable = triggerState === 'A' ? 'ENABLE ALWAYS' : 'ENABLE';
    await client.query(`ALTER TABLE app.auth_events ${enable} TRIGGER auth_events_no_mutation`);
    if (await readTriggerMode() !== triggerState) {
      throw new MaintenanceError('Could not verify restoration of auth_events_no_mutation.');
    }
    await client.query('COMMIT');
    return { applied: true, cutoff, count: deleted, deleted, databaseUser, triggerState };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function main() {
  const options = parseMaintenanceOptions(process.argv.slice(2), process.env);
  const client = new pg.Client({ connectionString: options.connectionString });
  try {
    await client.connect();
    return await runMaintenance(client, options);
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    console.log(JSON.stringify(await main()));
  } catch (error) {
    // Driver diagnostics can contain connection details.
    console.error(error instanceof MaintenanceError ? error.message : 'PostgreSQL retention maintenance failed.');
    process.exitCode = 1;
  }
}
