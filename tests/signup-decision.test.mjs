import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { SqliteStorage } from '../server/storage/sqlite.mjs';
import { translatePlaceholders } from '../server/storage/pg.mjs';
import { migrate } from '../server/migrations/index.mjs';
import { createSite } from '../server/repository.mjs';
import { DECISION_TTL, decideSignup, requestSignup } from '../server/signup.mjs';

const email = 'applicant@example.invalid';

// Same in-process PostgreSQL adapter as the audit and HSE suites: real pg
// semantics without a database service.
async function database(t, driver) {
  if (driver === 'sqlite') {
    const db = new SqliteStorage(':memory:');
    await db.exec('PRAGMA foreign_keys = ON');
    t.after(() => db.close());
    await migrate(db, { driver });
    return db;
  }
  const pg = new PGlite();
  t.after(() => pg.close());
  const adapt = connection => ({
    exec: sql => connection.exec(sql),
    all: async (sql, ...values) => (await connection.query(translatePlaceholders(sql), values)).rows,
    get: async (sql, ...values) => (await connection.query(translatePlaceholders(sql), values)).rows[0],
    run: async (sql, ...values) => ({ rowCount: (await connection.query(translatePlaceholders(sql), values)).affectedRows }),
    isUniqueViolation: error => error.code === '23505',
  });
  const db = { ...adapt(pg), transaction: fn => pg.transaction(tx => fn(adapt(tx))) };
  await migrate(db, { driver });
  return db;
}

async function fixture(t, driver) {
  const db = await database(t, driver);
  const mail = [];
  const mailer = async message => { mail.push(message); };
  await requestSignup(db, email, {
    mailer,
    ownerEmail: 'owner@example.invalid',
    publicUrl: 'https://app.example.invalid',
  });
  t.assert.strictEqual(mail.length, 1);
  const [, reviewUrl] = /^Review request: (https:\/\/\S+)$/m.exec(mail[0].text);
  const token = new URL(reviewUrl).searchParams.get('token');
  t.assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  return { db, token, mail, mailer };
}

for (const driver of ['sqlite', 'pg']) {
  for (const demoSandbox of [true, false]) {
    test(`signup approval sets demo_sandbox and roles with demoSandbox=${demoSandbox} (${driver})`, async t => {
      const { db, token, mail, mailer } = await fixture(t, driver);
      const first = await createSite(db, { code: 'SANDBOX-1', name: 'Synthetic sandbox 1' }, { demoSandbox: true });
      const second = await createSite(db, { code: 'SANDBOX-2', name: 'Synthetic sandbox 2' }, { demoSandbox: true });
      await createSite(db, { code: 'STANDARD', name: 'Synthetic standard site' });

      t.assert.strictEqual(await decideSignup(db, token, 'approve', { mailer, demoSandbox }), 'approve');

      const user = await db.get('SELECT id, demo_sandbox FROM users WHERE email = ?', email);
      t.assert.ok(user);
      t.assert.strictEqual(Boolean(user.demo_sandbox), demoSandbox);
      const expectedRoles = demoSandbox ? [first.id, second.id].sort().map(id => [id, 'demo_user']) : [];
      const roles = await db.all('SELECT site_id, role FROM site_members WHERE user_id = ? ORDER BY site_id', user.id);
      t.assert.deepStrictEqual(roles.map(({ site_id, role }) => [site_id, role]), expectedRoles);

      const events = await db.all("SELECT user_id, detail_json FROM auth_events WHERE event = 'signup.approved'");
      t.assert.strictEqual(events.length, 1);
      t.assert.strictEqual(events[0].user_id, user.id);
      const detail = typeof events[0].detail_json === 'string' ? JSON.parse(events[0].detail_json) : events[0].detail_json;
      t.assert.deepStrictEqual(detail, { sites_assigned: expectedRoles.length });
      t.assert.strictEqual(mail.length, 2);
      t.assert.strictEqual(mail[1].to, email);
    });
  }

  test(`signup rejection records the decision without creating an account (${driver})`, async t => {
    const { db, token, mail, mailer } = await fixture(t, driver);

    t.assert.strictEqual(await decideSignup(db, token, 'reject', { mailer, demoSandbox: true }), 'reject');

    t.assert.deepStrictEqual(await db.all('SELECT id FROM users'), []);
    t.assert.strictEqual((await db.get('SELECT status FROM signup_requests WHERE email = ?', email)).status, 'rejected');
    t.assert.strictEqual(mail.length, 1);
  });

  test(`a second signup decision returns LINK_EXPIRED without duplicate effects (${driver})`, async t => {
    const { db, token, mail, mailer } = await fixture(t, driver);
    await createSite(db, { code: 'SANDBOX', name: 'Synthetic sandbox' }, { demoSandbox: true });
    const options = { mailer, demoSandbox: true };
    t.assert.strictEqual(await decideSignup(db, token, 'approve', options), 'approve');
    const decision = await db.get('SELECT status, decided_at FROM signup_requests WHERE email = ?', email);

    await t.assert.rejects(() => decideSignup(db, token, 'approve', options), { code: 'LINK_EXPIRED', status: 410 });

    t.assert.deepStrictEqual(await db.get('SELECT status, decided_at FROM signup_requests WHERE email = ?', email), decision);
    t.assert.strictEqual((await db.all('SELECT id FROM users')).length, 1);
    t.assert.strictEqual((await db.all('SELECT user_id FROM site_members')).length, 1);
    t.assert.strictEqual((await db.all("SELECT id FROM auth_events WHERE event = 'signup.approved'")).length, 1);
    t.assert.strictEqual(mail.length, 2);
  });

  test(`a signup token older than its validity window returns LINK_EXPIRED (${driver})`, async t => {
    const { db, token, mail, mailer } = await fixture(t, driver);
    const expiredAt = new Date(Date.now() - DECISION_TTL - 1000).toISOString();
    await db.run('UPDATE signup_requests SET requested_at = ? WHERE email = ?', expiredAt, email);

    await t.assert.rejects(() => decideSignup(db, token, 'approve', { mailer, demoSandbox: true }), {
      code: 'LINK_EXPIRED', status: 410,
    });

    t.assert.deepStrictEqual(await db.all('SELECT id FROM users'), []);
    const request = await db.get('SELECT status, decided_at FROM signup_requests WHERE email = ?', email);
    t.assert.strictEqual(request.status, 'pending');
    t.assert.strictEqual(request.decided_at, null);
    t.assert.strictEqual(mail.length, 1);
  });
}
