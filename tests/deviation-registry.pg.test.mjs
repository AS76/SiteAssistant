import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

const enabled = process.env.DB_DRIVER === 'pg' && process.env.DATABASE_URL_TEST && process.env.SA_TEST_DB;
const skip = !enabled && 'Requires DB_DRIVER=pg, DATABASE_URL_TEST and SA_TEST_DB for a dedicated test database.';

test('062 serializes competing deviation approvals on real PostgreSQL and enforces site-scoped links',
  { skip, timeout: 30000 }, async t => {
    // The shared guard verifies the name in the URL and current_database() before any DDL.
    const { openTestDb } = await import('./helpers/db.mjs');
    const { authFixture } = await import('./helpers/auth.mjs');
    const { siteFixture, decisionItem, link, occurrence, request } = await import('./helpers/task-reconciliation.mjs');
    const { deviationRegistryReconciliation: batches } = await import('../server/deviation-registry.mjs');
    const { updateDeviationAttribution } = await import('../server/deviations.mjs');
    const { db, reopen, close } = await openTestDb();
    t.after(close);
    const peer = await reopen();
    t.after(() => peer.close());

    const { users: { owner, editor, verifier } } = await authFixture(db);
    const f = await siteFixture(db, { owner, editor, verifier });
    const other = await siteFixture(db, { owner });
    const site = f.site.id, id = randomUUID();
    const author = await f.person('Synthetic author');
    const alternate = await f.person('Synthetic alternate author');
    const foreign = await other.person(author.name);
    await db.run("INSERT INTO deviations (id, site_id, title, author, created_at, status) VALUES (?, ?, ?, ?, ?, 'open')",
      id, site, 'Synthetic deviation', author.name, new Date().toISOString());

    await batches.activate(db, site, owner);
    const preview = async () => (await batches.preview(db, site, { occurrences: [occurrence(id, 'author')] }, verifier)).items[0];
    const item = await preview();
    const first = request(decisionItem(item, link('person', author)));
    const second = request(decisionItem(item, link('person', alternate)));
    await batches.decide(db, site, first, editor);
    await batches.decide(peer, site, second, editor);

    const results = await Promise.all([batches.apply(db, site, first.batchId, editor), batches.apply(peer, site, second.batchId, owner)]);
    assert.deepEqual(results.map(result => result.items[0].status).sort(), ['applied', 'stale']);
    const saved = results.find(result => result.counts.applied === 1);
    assert.deepEqual(await batches.apply(peer, site, saved.batchId, editor), saved);
    const persisted = await db.all('SELECT person_id, snapshot, version FROM deviation_registry_links WHERE deviation_id = ?', id);
    assert.equal(persisted.length, 1);
    assert.equal(persisted[0].version, 1);
    assert.equal(persisted[0].person_id, saved.items[0].target.id);
    assert.deepEqual(JSON.parse(persisted[0].snapshot), saved.items[0].target);
    await assert.rejects(db.run('UPDATE deviation_registry_links SET person_id = ? WHERE deviation_id = ?', foreign.id, id),
      { code: '23503', constraint: 'deviation_registry_person_fk' });

    const later = await f.person('Synthetic later author');
    const archiveRace = request(decisionItem(await preview(), link('person', later)));
    await batches.decide(db, site, archiveRace, editor);
    await f.registry('people', { revision: later.revision }, 'archive', later.id);
    assert.equal((await batches.apply(peer, site, archiveRace.batchId, editor)).items[0].code, 'DEVIATION_REGISTRY_TARGET_CHANGED');

    await updateDeviationAttribution(peer, id, { causingCompany: 'Manual attribution', resolvingCompany: null, attributionState: 'agreed' }, editor);
    const rollback = await batches.rollback(db, site, saved.batchId, { reason: 'Synthetic rollback' }, owner);
    assert.deepEqual(rollback.counts, { compensated: 1, conflicting: 0 });
    const row = await db.get('SELECT author, causing_company, attribution_state FROM deviations WHERE id = ?', id);
    assert.deepEqual(row, { author: author.name, causing_company: 'Manual attribution', attribution_state: 'agreed' });
    const audit = await db.all("SELECT actor_id, source FROM deviation_events WHERE deviation_id = ? AND action = 'registry_rollback'", id);
    assert.deepEqual(audit, [{ actor_id: owner.id, source: 'internal' }]);
  });
