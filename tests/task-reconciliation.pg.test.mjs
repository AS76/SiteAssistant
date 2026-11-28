import test from 'node:test';

const enabled = process.env.DB_DRIVER === 'pg' && Boolean(process.env.DATABASE_URL_TEST);

test('Tasks serialize concurrent decisions from independent PostgreSQL connections', {
  skip: !enabled && 'Requires DB_DRIVER=pg and DATABASE_URL_TEST for a dedicated test database.',
  timeout: 30000,
}, async t => {
  // The shared fixture verifies the test database name before opening a schema.
  const { openTestDb } = await import('./helpers/db.mjs');
  const { assertConcurrentTaskAssignments } = await import('./helpers/task-reconciliation.mjs');
  await assertConcurrentTaskAssignments(t, await openTestDb());
});
