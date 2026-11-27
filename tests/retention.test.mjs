import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDb, closeDb } from '../server/db.mjs';
import { applyRetention, parseRetentionArgs, planRetention, retentionPolicy } from '../server/retention.mjs';

const daysAgo = days => new Date(Date.now() - days * 86400000).toISOString();

test('retention is dry-run by default and deletes only eligible rows when applied', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'siteassistant-retention-'));
  const db = await openDb(join(directory, 'app.db'), { driver: 'sqlite' });
  try {
    const userId = '00000000-0000-4000-8000-000000000001';
    await db.run('INSERT INTO users (id, email, name, password_hash, password_algo, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      userId, 'retention@example.invalid', 'Retention', 'hash', 'scrypt', daysAgo(200));
    await db.run(`INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at, revoked_at)
      VALUES (?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?)`, 's1', userId, 'a'.repeat(64), daysAgo(40), daysAgo(33), null,
      's2', userId, 'b'.repeat(64), daysAgo(10), daysAgo(1), null);
    await db.run(`INSERT INTO auth_events (id, user_id, event, outcome, detail_json, created_at) VALUES
      (?, ?, 'old', 'success', '{}', ?), (?, ?, 'new', 'success', '{}', ?)`,
      'e1', userId, daysAgo(100), 'e2', userId, daysAgo(10));
    await db.run(`INSERT INTO signup_requests (id, email, decision_token_hash, status, requested_at, decided_at)
      VALUES (?, ?, ?, 'rejected', ?, ?), (?, ?, ?, 'pending', ?, NULL)`,
      'r1', 'old@example.invalid', 'c'.repeat(64), daysAgo(60), daysAgo(40),
      'r2', 'pending@example.invalid', 'd'.repeat(64), daysAgo(10));
    const policy = retentionPolicy({});
    const plan = await planRetention(db, { policy });
    assert.deepEqual(plan.counts, { expiredSessions: 1, authEvents: 1, closedSignupRequests: 1 });
    assert.match(plan.blocked.authEvents, /append-only/);
    const dry = await applyRetention(db, plan);
    assert.equal(dry.applied, false);
    assert.equal((await db.get('SELECT COUNT(*) AS total FROM sessions')).total, 2);
    const applied = await applyRetention(db, plan, { apply: true });
    assert.equal(applied.applied, true);
    assert.deepEqual(applied.deleted, { expiredSessions: 1, authEvents: 0, closedSignupRequests: 1 });
    assert.equal((await db.get('SELECT COUNT(*) AS total FROM sessions')).total, 1);
    assert.equal((await db.get('SELECT COUNT(*) AS total FROM auth_events')).total, 2);
    assert.equal((await db.get('SELECT COUNT(*) AS total FROM signup_requests')).total, 1);
    assert.equal((await db.get('SELECT status FROM signup_requests')).status, 'pending');
  } finally {
    await closeDb(db);
    await rm(directory, { recursive: true, force: true });
  }
});

test('apply requires explicit confirmation and threshold values are bounded', () => {
  assert.throws(() => parseRetentionArgs(['--apply']), /confirm/i);
  assert.deepEqual(parseRetentionArgs([]), { apply: false });
  assert.equal(retentionPolicy({ RETENTION_AUTH_EVENTS_DAYS: '0' }).authEventsDays, 90);
  assert.equal(retentionPolicy({ RETENTION_AUTH_EVENTS_DAYS: '42' }).authEventsDays, 42);
});
