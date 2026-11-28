import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { openDb } from '../server/db.mjs';
import { apply, reset, resetAndApply } from '../server/seed-demo.mjs';
import { fixtureRecordId } from '../server/demo-seed-registry.mjs';
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

function assertFixtureLedger(before, after) {
  const registered = after.demo_seed_records.map(json => {
    const { table_name, record_id } = JSON.parse(json);
    return JSON.stringify([table_name, record_id]);
  });
  const expected = [];
  for (const [table, rows] of Object.entries(after)) {
    if (table === 'demo_seed_records') continue;
    const existing = new Set(before[table]);
    for (const json of rows.filter(row => !existing.has(row))) {
      expected.push(JSON.stringify([table, fixtureRecordId(table, JSON.parse(json))]));
    }
  }
  assert.deepEqual(registered.sort(), expected.sort());
}

const tableCounts = snapshot => Object.fromEntries(Object.entries(snapshot).map(([table, rows]) => [table, rows.length]));

async function addNonDemoSite(db) {
  const id = randomUUID();
  await db.run(`INSERT INTO sites (id, code, name, created_at, demo_sandbox)
    VALUES (?, 'NON-DEMO', 'Synthetic non-demo site', '2026-11-01T08:00:00.000Z', FALSE)`, id);
  return db.get('SELECT * FROM sites WHERE id = ?', id);
}

async function runConcurrentResets(db) {
  const firstLocked = Promise.withResolvers();
  const resumeFirst = Promise.withResolvers();
  const secondStarted = Promise.withResolvers();
  const first = resetAndApply({
    transaction: fn => db.transaction(tx => fn({
      ...tx,
      async get(sql, ...values) {
        const result = await tx.get(sql, ...values);
        if (sql.startsWith('SELECT pg_advisory_xact_lock(')) {
          firstLocked.resolve((await tx.get('SELECT pg_backend_pid() AS pid')).pid);
          await resumeFirst.promise;
        }
        return result;
      },
    })),
  });
  let second;
  try {
    const holder = await Promise.race([firstLocked.promise, first.then(() => assert.fail('First reset did not take the advisory lock'))]);
    second = resetAndApply({
      transaction: fn => db.transaction(async tx => {
        secondStarted.resolve((await tx.get('SELECT pg_backend_pid() AS pid')).pid);
        return fn(tx);
      }),
    });
    const waiter = await Promise.race([secondStarted.promise, second.then(() => assert.fail('Second reset did not start a transaction'))]);
    assert.notEqual(waiter, holder);
    const deadline = Date.now() + 5000;
    let waiting;
    do {
      ({ waiting } = await db.get(`SELECT EXISTS (SELECT 1 FROM pg_locks
        WHERE pid = ? AND locktype = 'advisory' AND NOT granted
        AND CAST(? AS INTEGER) = ANY(pg_blocking_pids(pid))) AS waiting`, waiter, holder));
      if (!waiting) await delay(20);
    } while (!waiting && Date.now() < deadline);
    assert.ok(waiting, 'Second reset must wait on the first reset’s advisory lock');
  } finally {
    resumeFirst.resolve();
    await Promise.allSettled([first, second]);
  }
  return Promise.all([first, second]);
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

    await t.test('missing or invalid marker refuses demo mutations without writes', async () => {
      const check = async () => {
        const before = await snapshot(db);
        await withDemoEnvironment(async () => {
          for (const execute of [apply, reset, resetAndApply]) {
            await assert.rejects(execute(db), /Demo database marker is missing or invalid/);
          }
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
      for (const execute of [apply, reset, resetAndApply]) {
        await assert.rejects(execute(db), /requires APP_ENV=demo/);
      }
      assert.deepEqual(await snapshot(db), before);
    });

    await withDemoEnvironment(async () => {
      const nonDemoSite = await addNonDemoSite(db);
      const unseeded = await snapshot(db);

      await t.test('interrupted apply rolls back fixture data and the registry', async () => {
        await assert.rejects(apply(failAfterWrites(db, sql => sql.startsWith('INSERT INTO demo_seed_records'))), /five successful writes/);
        assert.deepEqual(await snapshot(db), unseeded);
      });

      await t.test('fresh apply registers every fixture row with its actual primary key', async () => {
        await apply(db);
        assertFixtureLedger(unseeded, await snapshot(db));
      });

      await t.test('double apply leaves every application table and the registry identical', async () => {
        await apply(db);
        const before = await snapshot(db);
        await apply(db);
        assert.deepEqual(await snapshot(db), before);
      });

      if (driver === 'pg') {
        await t.test(isPg ? 'two atomic resets serialize on the PostgreSQL advisory lock'
          : 'two atomic resets leave a consistent fixture registry', async () => {
          const seeded = await snapshot(db);
          let results;
          if (isPg) {
            results = await runConcurrentResets(db);
          } else {
            results = [await resetAndApply(db), await resetAndApply(db)];
          }
          assert.ok(results[0].reset.removed > 0);
          assert.deepEqual(results[1], results[0]);
          const after = await snapshot(db);
          assert.deepEqual(tableCounts(after), tableCounts(seeded));
          assertFixtureLedger(unseeded, after);
          assert.deepEqual(await db.get('SELECT * FROM sites WHERE id = ?', nonDemoSite.id), nonDemoSite);
        });
      }

      await t.test('a shipment collision during atomic apply also rolls back fixture deletions', async () => {
        const before = await snapshot(db);
        let removedTasks = 0;
        let injected = false;
        const collision = {
          transaction: fn => db.transaction(tx => fn({
            ...tx,
            async run(sql, ...values) {
              if (!injected && sql.startsWith('INSERT INTO shipment_packages')) {
                assert.ok(removedTasks > 0, 'The reset must have deleted existing fixtures');
                const insert = await tx.run('INSERT INTO shipment_packages (shipment_id, package_id) VALUES (?, ?)', ...values);
                assert.equal(insert.rowCount, 1);
                injected = true;
              }
              const result = await tx.run(sql, ...values);
              if (sql.startsWith('DELETE FROM tasks ')) removedTasks += result.rowCount;
              return result;
            },
          })),
        };
        await assert.rejects(resetAndApply(collision), /Unregistered demo fixture collision: shipment_packages \(1 row,/);
        assert.ok(injected);
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

      const cascadeTables = [
        'deviation_export_rows', 'shipment_packages', 'shipment_receipts', 'cost_impact_deviations',
        'deviation_links', 'packages', 'package_items', 'purchase_order_items', 'site_progress_item_steps',
        'hse_inspection_items', 'employee_certifications',
      ];
      const unrelated = randomUUID();
      const unrelatedExportHash = 'a'.repeat(64);

      await t.test('unregistered composite links survive apply without being claimed', async () => {
        const { id: impact } = await db.get('SELECT id FROM cost_impacts ORDER BY id LIMIT 1');
        const site = await db.get("SELECT id FROM sites WHERE code = 'FITT-01'");
        await db.run(`INSERT INTO deviations (id, site_id, title, status, created_at)
          VALUES (?, ?, 'Unrelated synthetic deviation', 'open', '2026-11-01T08:00:00.000Z')`, unrelated, site.id);
        await db.run('INSERT INTO cost_impact_deviations (cost_impact_id, deviation_id) VALUES (?, ?)', impact, unrelated);
        const before = await snapshot(db);
        await apply(db);
        assert.deepEqual(await snapshot(db), before);
        const batch = await db.get(`INSERT INTO deviation_exports (site_id, source_system, export_date, file_sha256, complete, scope)
          VALUES (?, 'other', '2026-11-01', ?, TRUE, 'Unrelated synthetic scope') RETURNING id`, site.id, unrelatedExportHash);
        await db.run('INSERT INTO deviation_export_rows (export_id, deviation_id) VALUES (?, ?)', batch.id, unrelated);
      });

      await t.test('legacy shipment links report all collisions by table with three example keys', async () => {
        const tables = ['shipment_packages', 'cost_impact_deviations'];
        const keys = new Map();
        for (const table of tables) {
          const limit = table === 'shipment_packages' ? 4 : 1;
          const rows = await db.all('SELECT record_id FROM demo_seed_records WHERE table_name = ? ORDER BY record_id LIMIT ?', table, limit);
          assert.equal(rows.length, limit);
          keys.set(table, rows.map(row => row.record_id).sort());
          for (const { record_id } of rows) {
            await db.run('DELETE FROM demo_seed_records WHERE table_name = ? AND record_id = ?', table, record_id);
          }
        }
        const before = await snapshot(db);
        await assert.rejects(apply(db), {
          message: `Unregistered demo fixture collision: shipment_packages (4 rows, examples: ${keys.get('shipment_packages').slice(0, 3).join(', ')}) | cost_impact_deviations (1 row, examples: ${keys.get('cost_impact_deviations')[0]}).`,
        });
        assert.deepEqual(await snapshot(db), before);
        for (const [table, records] of keys) {
          for (const record of records) {
            await db.run('INSERT INTO demo_seed_records (table_name, record_id) VALUES (?, ?)', table, record);
          }
        }
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

      await t.test('a foreign key from a tester-owned child blocks deletion and rolls back the reset', async () => {
        const { id: deviation } = await db.get('SELECT id FROM deviations WHERE id <> ? ORDER BY id LIMIT 1', unrelated);
        const { id: batch } = await db.get('SELECT id FROM deviation_exports WHERE file_sha256 = ?', unrelatedExportHash);
        await db.run('INSERT INTO deviation_export_rows (export_id, deviation_id) VALUES (?, ?)', batch, deviation);
        const before = await snapshot(db);
        await assert.rejects(reset(db), /referenced by deviation_export_rows/);
        assert.deepEqual(await snapshot(db), before);
        await db.run('DELETE FROM deviation_export_rows WHERE export_id = ? AND deviation_id = ?', batch, deviation);
      });

      const expectedCascade = {};
      await t.test('legacy ledger gaps include a child and grandchild of a registered order', async () => {
        for (const table of cascadeTables) {
          const { rowCount } = await db.run('DELETE FROM demo_seed_records WHERE table_name = ?', table);
          assert.ok(rowCount > 0, table);
          expectedCascade[table] = rowCount;
        }
        expectedCascade.cost_impact_deviations += 1;
        assert.ok(await db.get(`SELECT 1 FROM package_items pi JOIN packages p ON p.id = pi.package_id
          JOIN demo_seed_records r ON r.table_name = 'purchase_orders' AND r.record_id = CAST(p.purchase_order_id AS TEXT)`));
      });

      await t.test('interrupted reset rolls back data and ledger and can be retried', async () => {
        const before = await snapshot(db);
        await assert.rejects(reset(failAfterWrites(db, sql => /^DELETE FROM (?!demo_seed_records)/.test(sql))), /five successful writes/);
        assert.deepEqual(await snapshot(db), before);
      });

      await t.test('reset counts residual child and grandchild deletes and preserves tester-owned rows', async () => {
        const before = await snapshot(db);
        const { removed, cascaded } = await reset(db);
        const after = await snapshot(db);
        assert.deepEqual(cascaded, expectedCascade);
        assert.equal(removed, Object.keys(before).filter(table => table !== 'demo_seed_records')
          .reduce((count, table) => count + before[table].length - after[table].length, 0));
        for (const table of ['shipments', 'shipment_packages', 'purchase_orders', 'packages', 'package_items']) {
          assert.deepEqual(after[table], [], table);
        }
        assert.deepEqual((await db.all('SELECT id FROM deviations')).map(row => row.id), [unrelated]);
        const batch = await db.get('SELECT id, file_sha256 FROM deviation_exports');
        assert.equal(batch.file_sha256, unrelatedExportHash);
        assert.deepEqual((await db.all('SELECT * FROM deviation_export_rows')).map(row => ({ ...row })),
          [{ export_id: batch.id, deviation_id: unrelated }]);
      });

      await t.test('double reset leaves every application table and the registry identical', async () => {
        const before = await snapshot(db);
        assert.deepEqual(await reset(db), { removed: 0, cascaded: {} });
        assert.deepEqual(await snapshot(db), before);
      });
    });
  });
}

test('the SQLite CLI requires explicit provisioning and can reset and apply twice', async t => {
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
  assert.match(run('--reset-apply').stderr, /Demo database marker is missing or invalid/);
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
  assert.deepEqual(JSON.parse(resetInDemo.stdout), { reset: true, removed: 0, cascaded: {} });
  const nonDemoSite = await addNonDemoSite(db);
  const before = await snapshot(db);
  const seed = run('--apply');
  assert.equal(seed.status, 0, seed.stderr);
  const initial = JSON.parse(seed.stdout);
  assert.equal(initial.applied, true);
  const seeded = await snapshot(db);
  let removed;
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = run('--reset-apply');
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.applied, true);
    assert.deepEqual(output.counts, initial.counts);
    assert.ok(output.reset.removed > 0);
    removed ??= output.reset.removed;
    assert.deepEqual(output.reset, { removed, cascaded: {} });
    const after = await snapshot(db);
    assert.deepEqual(tableCounts(after), tableCounts(seeded));
    assertFixtureLedger(before, after);
    assert.deepEqual(await db.get('SELECT * FROM sites WHERE id = ?', nonDemoSite.id), nonDemoSite);
  }
});
