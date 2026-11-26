import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openDb } from '../server/db.mjs';
import { apply, reset } from '../server/seed-demo.mjs';
import { demoDatabaseIsSqlite } from '../server/demo-seed-environment.mjs';
import { isPg, openTestDb } from './helpers/db.mjs';
import { provisionDemoFixture, withDemoEnvironment } from './helpers/demo-seed.mjs';
import { wbsDatabase } from './helpers/wbs.mjs';

async function snapshot(db) {
  const tables = await (await demoDatabaseIsSqlite(db)
    ? db.all("SELECT name FROM main.sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    : db.all("SELECT table_name AS name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' ORDER BY table_name"));
  return Object.fromEntries(await Promise.all(tables.map(async ({ name }) => [
    name, (await db.all(`SELECT * FROM "${name}"`)).map(row => JSON.stringify(row)).sort(),
  ])));
}

function failAfterWrites(db, predicate) {
  let completedWrites = 0;
  const interrupted = {
    transaction: fn => db.transaction(tx => fn({
      ...tx,
      async run(sql, ...values) {
        const result = await tx.run(sql, ...values);
        if (predicate(sql) && result.rowCount > 0 && ++completedWrites === 5) {
          throw new Error('Simulated failure after five successful writes');
        }
        return result;
      },
    })),
  };
  return interrupted;
}

for (const driver of ['sqlite', 'pg']) {
  const engine = driver === 'sqlite' ? 'SQLite' : isPg ? 'PostgreSQL' : 'PGlite';
  test(`${engine} demo seed and reset safety`, async t => {
    const fixture = driver === 'pg' && isPg ? await openTestDb() : null;
    if (fixture) t.after(fixture.close);
    const db = fixture?.db ?? await wbsDatabase(t, driver);

    await t.test('missing or invalid marker refuses apply and reset without writes', async () => {
      const check = async () => {
        const before = await snapshot(db);
        await withDemoEnvironment(async () => {
          await assert.rejects(apply(db), /Demo database marker is missing or invalid/);
          await assert.rejects(reset(db), /Demo database marker is missing or invalid/);
        });
        assert.deepEqual(await snapshot(db), before);
      };
      await check();
      await db.run("INSERT INTO demo_seed_environment (singleton, marker) VALUES (1, 'invalid')");
      await check();
      await db.run('DELETE FROM demo_seed_environment WHERE singleton = 1');
      await provisionDemoFixture(db);
    });

    await t.test('APP_ENV must identify demo even when the database is marked', async t => {
      const previous = process.env.APP_ENV;
      process.env.APP_ENV = 'production';
      t.after(() => {
        if (previous === undefined) delete process.env.APP_ENV;
        else process.env.APP_ENV = previous;
      });
      const before = await snapshot(db);
      await assert.rejects(apply(db), /requires APP_ENV=demo/);
      await assert.rejects(reset(db), /requires APP_ENV=demo/);
      assert.deepEqual(await snapshot(db), before);
    });

    await withDemoEnvironment(async () => {
      await t.test('interrupted apply rolls back fixture data and the registry', async () => {
        const before = await snapshot(db);
        await assert.rejects(apply(failAfterWrites(db, sql => sql.startsWith('INSERT INTO demo_seed_records'))), /five successful writes/);
        assert.deepEqual(await snapshot(db), before);
      });

      await t.test('double apply leaves every application table and the registry identical', async () => {
        await apply(db);
        const before = await snapshot(db);
        await apply(db);
        assert.deepEqual(await snapshot(db), before);
      });

      await t.test('an existing ID without ownership refuses apply and reset without writes', async () => {
        const entry = await db.get("SELECT record_id FROM demo_seed_records WHERE table_name = 'tasks' ORDER BY record_id LIMIT 1");
        await db.run("DELETE FROM demo_seed_records WHERE table_name = 'tasks' AND record_id = ?", entry.record_id);
        const before = await snapshot(db);
        for (const execute of [apply, reset]) {
          await assert.rejects(execute(db), /Unregistered demo fixture collision: tasks/);
          assert.deepEqual(await snapshot(db), before);
        }
        await db.run("INSERT INTO demo_seed_records (table_name, record_id) VALUES ('tasks', ?)", entry.record_id);
      });

      await t.test('unregistered child rows block reset even where a foreign key would cascade', async () => {
        const batch = await db.get('SELECT id FROM deviation_exports ORDER BY id LIMIT 1');
        const site = await db.get("SELECT id FROM sites WHERE code = 'FITT-01'");
        const unrelated = randomUUID();
        await db.run(`INSERT INTO deviations (id, site_id, title, status, created_at)
          VALUES (?, ?, 'Unrelated synthetic deviation', 'open', '2026-11-01T08:00:00.000Z')`, unrelated, site.id);
        await db.run('INSERT INTO deviation_export_rows (export_id, deviation_id) VALUES (?, ?)', batch.id, unrelated);
        const before = await snapshot(db);
        await assert.rejects(reset(db), /referenced by deviation_export_rows/);
        assert.deepEqual(await snapshot(db), before);
        await db.run('DELETE FROM deviation_export_rows WHERE export_id = ? AND deviation_id = ?', batch.id, unrelated);
      });

      await t.test('unregistered composite links survive apply and block reset', async () => {
        const { id: impact } = await db.get('SELECT id FROM cost_impacts ORDER BY id LIMIT 1');
        const { id: deviation } = await db.get("SELECT id FROM deviations WHERE title = 'Unrelated synthetic deviation'");
        await db.run('INSERT INTO cost_impact_deviations (cost_impact_id, deviation_id) VALUES (?, ?)', impact, deviation);
        const before = await snapshot(db);
        await apply(db);
        assert.deepEqual(await snapshot(db), before);
        await assert.rejects(reset(db), /Demo reset blocked: cost_impacts/);
        assert.deepEqual(await snapshot(db), before);
        await db.run('DELETE FROM cost_impact_deviations WHERE cost_impact_id = ? AND deviation_id = ?', impact, deviation);
      });

      await t.test('a skipped composite insert cannot claim an existing relationship', async () => {
        const table = 'cost_impact_deviations';
        const { record_id: key } = await db.get('SELECT record_id FROM demo_seed_records WHERE table_name = ? ORDER BY record_id LIMIT 1', table);
        await db.run('DELETE FROM demo_seed_records WHERE table_name = ? AND record_id = ?', table, key);
        const before = await snapshot(db);
        await assert.rejects(apply(db), /Unregistered demo fixture collision: cost_impact_deviations/);
        assert.deepEqual(await snapshot(db), before);
        await db.run('INSERT INTO demo_seed_records (table_name, record_id) VALUES (?, ?)', table, key);
      });

      await t.test('an unregistered link to a fixture target blocks deletion', async () => {
        const { id: task } = await db.get('SELECT id FROM tasks ORDER BY id LIMIT 1');
        const { id: deviation } = await db.get("SELECT id FROM deviations WHERE title = 'Unrelated synthetic deviation'");
        await db.run("INSERT INTO deviation_links (deviation_id, entity_type, entity_id) VALUES (?, 'task', ?)", deviation, task);
        const before = await snapshot(db);
        await assert.rejects(reset(db), /referenced by deviation_links/);
        assert.deepEqual(await snapshot(db), before);
        await db.run("DELETE FROM deviation_links WHERE deviation_id = ? AND entity_type = 'task' AND entity_id = ?", deviation, task);
      });

      await t.test('interrupted reset rolls back data and ledger and can be retried', async () => {
        const before = await snapshot(db);
        await assert.rejects(reset(failAfterWrites(db, sql => /^DELETE FROM (?!demo_seed_records)/.test(sql))), /five successful writes/);
        assert.deepEqual(await snapshot(db), before);
        assert.ok(await reset(db) > 0);
        assert.ok(await db.get("SELECT id FROM deviations WHERE title = 'Unrelated synthetic deviation'"));
      });

      await t.test('double reset leaves every application table and the registry identical', async () => {
        const before = await snapshot(db);
        assert.equal(await reset(db), 0);
        assert.deepEqual(await snapshot(db), before);
      });
    });
  });
}

test('the CLI marker requires deliberate provisioning and refuses the legacy ledger', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'siteassistant-demo-marker-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'demo.db');
  const db = await openDb(path, { driver: 'sqlite' });
  t.after(() => db.close());
  const run = (flag, environment = 'demo') => {
    const result = spawnSync(process.execPath, ['server/seed-demo.mjs', flag], {
      env: { ...process.env, DB_DRIVER: 'sqlite', DATA_DIR: path, APP_ENV: environment }, encoding: 'utf8',
    });
    assert.ifError(result.error);
    return result;
  };
  assert.match(run('--reset').stderr, /Demo database marker is missing or invalid/);
  await db.run("INSERT INTO demo_seed_records (table_name, record_id) VALUES ('sites', 'legacy-id')");
  assert.match(run('--mark-demo-database').stderr, /Legacy demo seed registry requires manual reconciliation/);
  assert.deepEqual(await db.all('SELECT * FROM demo_seed_environment'), []);
  await db.run("DELETE FROM demo_seed_records WHERE table_name = 'sites' AND record_id = 'legacy-id'");
  assert.match(run('--mark-demo-database', 'production').stderr, /requires APP_ENV=demo/);
  assert.deepEqual(await db.all('SELECT * FROM demo_seed_environment'), []);
  for (let attempt = 0; attempt < 2; attempt++) {
    const marked = run('--mark-demo-database');
    assert.equal(marked.status, 0, marked.stderr);
  }
  assert.equal((await db.all('SELECT * FROM demo_seed_environment')).length, 1);
  const resetInDemo = run('--reset');
  assert.equal(resetInDemo.status, 0, resetInDemo.stderr);
});
