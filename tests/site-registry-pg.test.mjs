import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createSite } from '../server/repository.mjs';
import { writeRegistry } from '../server/site-registry.mjs';
import { isPg, openTestDb } from './helpers/db.mjs';

test('059 serializes overlapping affiliation writes on independent PostgreSQL connections',
  { skip: !isPg, timeout: 30000 }, async t => {
    const { db, reopen, close } = await openTestDb();
    const peer = await reopen();
    t.after(async () => { await peer.close(); await close(); });
    const site = await createSite(db, { code: 'EXAMPLE', name: 'Example site' });
    const actor = { id: randomUUID() };
    await db.run(`INSERT INTO users (id, email, name, password_hash, password_algo, created_at)
      VALUES (?, 'synthetic@example.invalid', 'Example owner', 'unused', 'scrypt', ?)`, actor.id, new Date().toISOString());
    await db.run("INSERT INTO site_members (site_id, user_id, role) VALUES (?, ?, 'owner')", site.id, actor.id);
    const scope = collection => ({ siteId: site.id, collection, action: 'create' });
    const make = (collection, input, connection = db) => writeRegistry(connection, scope(collection),
      { reason: 'Concurrency fixture', ...input }, actor);
    const person = await make('people', { name: 'Example person' });
    const company = await make('companies', { name: 'Example company' });
    const affiliation = { personId: person.id, companyId: company.id, relationship: 'contracted', source: 'manual',
      validFrom: '2030-02-01T10:00:00.000Z' };

    const { promise: acquired, resolve: notifyAcquired } = Promise.withResolvers();
    const { promise: release, resolve: releaseFirst } = Promise.withResolvers();
    const { promise: attempted, resolve: notifyAttempt } = Promise.withResolvers();
    t.signal.addEventListener('abort', releaseFirst, { once: true });
    const interceptLock = (connection, intercept) => ({
      transaction: fn => connection.transaction(tx => fn({
        ...tx,
        run: (sql, ...params) => sql === 'UPDATE sites SET id = id WHERE id = ?'
          ? intercept(() => tx.run(sql, ...params)) : tx.run(sql, ...params),
      })),
    });
    const first = make('affiliations', affiliation, interceptLock(db, async run => {
      const result = await run();
      notifyAcquired();
      await release;
      return result;
    }));
    await Promise.race([acquired, first]);
    const second = make('affiliations', affiliation, interceptLock(peer, run => {
      const pending = run();
      notifyAttempt();
      return pending;
    }));
    await Promise.race([attempted, second]).finally(releaseFirst);
    await Promise.all([
      first,
      assert.rejects(second, { status: 409, code: 'REGISTRY_INTERVAL_OVERLAP' }),
    ]);
    const rows = await db.all('SELECT id FROM registry_affiliations WHERE site_id = ?', site.id);
    assert.equal(rows.length, 1);
  });
