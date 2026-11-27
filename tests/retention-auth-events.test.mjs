import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { parseMaintenanceOptions, runMaintenance } from '../scripts/retention-auth-events.mjs';

const env = {
  RETENTION_MAINTENANCE_DATABASE_URL: 'postgresql://maintenance@example.invalid/app',
  RETENTION_MAINTENANCE_EXPECTED_ROLE: 'maintenance',
};
const backup = {
  RETENTION_BACKUP_VERIFIED: '1',
  RETENTION_BACKUP_MANIFEST: fileURLToPath(import.meta.url),
};

test('apply requires explicit confirmation', () => {
  assert.throws(() => parseMaintenanceOptions(['--apply'], env), /requires --confirm/);
});

test('the maintenance URL is mandatory and must be PostgreSQL', () => {
  assert.throws(() => parseMaintenanceOptions([], { DATABASE_URL: env.RETENTION_MAINTENANCE_DATABASE_URL }),
    /RETENTION_MAINTENANCE_DATABASE_URL is required/);
  assert.throws(() => parseMaintenanceOptions([], { ...env, RETENTION_MAINTENANCE_DATABASE_URL: 'sqlite:///test' }),
    /PostgreSQL connection URL/);
});

test('invalid retention days fall back to 90', () => {
  for (const value of ['0', '-3', '1.5', 'junk']) {
    assert.equal(parseMaintenanceOptions([], { ...env, RETENTION_AUTH_EVENTS_DAYS: value }).days, 90);
  }
});

test('apply requires a verified backup and an existing manifest file', () => {
  const args = ['--apply', '--confirm'];
  assert.throws(() => parseMaintenanceOptions(args, env), /RETENTION_BACKUP_VERIFIED/);
  assert.throws(() => parseMaintenanceOptions(args, { ...env, RETENTION_BACKUP_VERIFIED: '1' }), /RETENTION_BACKUP_MANIFEST/);
  assert.throws(() => parseMaintenanceOptions(args, {
    ...env, ...backup, RETENTION_BACKUP_MANIFEST: backup.RETENTION_BACKUP_MANIFEST + '.missing',
  }), /existing file/);
  assert.equal(parseMaintenanceOptions(args, { ...env, ...backup }).apply, true);
});

test('dry-run is the default and can be requested explicitly', () => {
  assert.equal(parseMaintenanceOptions([], env).apply, false);
  assert.equal(parseMaintenanceOptions(['--dry-run'], env).apply, false);
  assert.equal(parseMaintenanceOptions(['--dry-run'], { ...env, RETENTION_AUTH_EVENTS_DAYS: '30' }).days, 30);
});

const now = Date.parse('2026-04-01T00:00:00Z');
const cutoff = '2026-01-01T00:00:00.000Z';
const triggerSteps = [
  'BEGIN',
  'LOCK TABLE app.auth_events IN SHARE ROW EXCLUSIVE MODE',
  'trigger',
  'ALTER TABLE app.auth_events DISABLE TRIGGER auth_events_no_mutation',
  'DELETE FROM app.auth_events WHERE created_at < $1::timestamptz',
  'ALTER TABLE app.auth_events ENABLE TRIGGER auth_events_no_mutation',
  'trigger',
];

function mockClient({ failVerification = false, role = 'maintenance', initialMode = 'O' } = {}) {
  const queries = [];
  let triggerMode = initialMode;
  let deleted = 0;
  return {
    queries,
    state: () => ({ triggerMode, deleted }),
    async query(sql, params) {
      if (sql.includes('pg_catalog.pg_trigger')) {
        queries.push('trigger');
        const mode = failVerification && deleted ? 'D' : triggerMode;
        return { rows: [{ mode }] };
      }
      queries.push(sql);
      if (sql.startsWith('SELECT current_user')) return { rows: [{ database_user: role }] };
      if (sql.startsWith('SELECT count(*)')) {
        assert.deepEqual(params, [cutoff]);
        return { rows: [{ count: '2' }] };
      }
      if (sql.includes('DISABLE TRIGGER')) triggerMode = 'D';
      if (sql.startsWith('DELETE')) {
        assert.deepEqual(params, [cutoff]);
        assert.equal(triggerMode, 'D');
        deleted = 2;
        return { rowCount: deleted };
      }
      if (sql.includes('ENABLE TRIGGER')) triggerMode = 'O';
      if (sql === 'ROLLBACK') {
        triggerMode = initialMode;
        deleted = 0;
      }
      return {};
    },
  };
}

test('dry-run counts eligible rows without writing', async () => {
  const client = mockClient();
  assert.deepEqual(await runMaintenance(client, parseMaintenanceOptions([], env), now), {
    applied: false, cutoff, count: 2, deleted: 0, databaseUser: 'maintenance', triggerState: 'O',
  });
  assert.equal(client.queries.length, 3);
  assert.ok(client.queries[2].startsWith('SELECT count(*)'));
});

const applyOptions = parseMaintenanceOptions(['--apply', '--confirm'], { ...env, ...backup });

test('apply refuses a mismatched role or disabled trigger before beginning', async () => {
  const wrongRole = mockClient({ role: 'other' });
  await assert.rejects(runMaintenance(wrongRole, applyOptions, now), /does not match/);
  assert.equal(wrongRole.queries.length, 1);
  const disabled = mockClient({ initialMode: 'D' });
  await assert.rejects(runMaintenance(disabled, applyOptions, now), /must be enabled/);
  assert.equal(disabled.queries.length, 2);
});

test('apply verifies the restored trigger before committing', async () => {
  const client = mockClient();
  assert.deepEqual(await runMaintenance(client, applyOptions, now), {
    applied: true, cutoff, count: 2, deleted: 2, databaseUser: 'maintenance', triggerState: 'O',
  });
  assert.deepEqual(client.queries.slice(2), [...triggerSteps, 'COMMIT']);
});

test('apply rolls back when trigger restoration cannot be verified', async () => {
  const client = mockClient({ failVerification: true });
  await assert.rejects(runMaintenance(client, applyOptions, now), /Could not verify restoration/);
  assert.deepEqual(client.queries.slice(2), [...triggerSteps, 'ROLLBACK']);
  assert.deepEqual(client.state(), { triggerMode: 'O', deleted: 0 });
});
