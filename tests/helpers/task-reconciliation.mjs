import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createSite, createTask } from '../../server/repository.mjs';
import { writeRegistry } from '../../server/site-registry.mjs';
import { taskAssignmentReconciliation as batches } from '../../server/task-reconciliation.mjs';
import { authFixture } from './auth.mjs';

export const day = 86_400_000;
export const stamp = delta => new Date(Date.now() + delta).toISOString();
export const occurrence = (recordId, field = 'executor') => ({ recordId, field });
const reason = 'Synthetic evidence checked';
export const link = (kind, target, authority) => ({
  action: 'link', reason, kind, targetId: target.id, targetRevision: target.revision,
  ...(authority ? { authorityId: authority.id, authorityRevision: authority.revision } : {}),
});
export const decisionItem = ({ recordId, field, revision }, decision) => ({ recordId, field, revision, decision });
export const request = (...decisions) => ({ batchId: randomUUID(), decisions });

export async function siteFixture(db, users) {
  const site = await createSite(db, { code: randomUUID(), name: 'Synthetic site' });
  for (const [role, user] of Object.entries(users)) {
    await db.run('INSERT INTO site_members (site_id, user_id, role) VALUES (?, ?, ?)', site.id, user.id, role);
  }
  const registry = (collection, input, action = 'create', id) => writeRegistry(db,
    { siteId: site.id, collection, action, id }, { ...input, reason }, users.owner);
  return {
    site, registry,
    person: name => registry('people', { name }),
    grant: (person, role, validFrom = stamp(-day), validTo = stamp(day)) =>
      registry('authority-roles', { personId: person.id, role, validFrom, validTo }),
    company: name => registry('companies', { name }),
    team: name => registry('teams', { name }),
    task: (input = {}) => createTask(db, { siteId: site.id, title: 'Synthetic task',
      executor: 'Recorded  executor', verifier: 'Recorded reviewer', company: 'Recorded  company', ...input }),
  };
}

export async function assertConcurrentTaskAssignments(t, { db, reopen, close }) {
  const peer = await reopen();
  t.after(async () => { await peer.close(); await close(); });
  const { users } = await authFixture(db);
  const f = await siteFixture(db, users);
  const site = f.site.id;
  const task = await f.task();
  const firstTeam = await f.team('First synthetic crew'), secondTeam = await f.team('Second synthetic crew');
  await batches.activate(db, site, users.owner);
  const [preview] = (await batches.preview(db, site, { occurrences: [occurrence(task.id)] }, users.editor)).items;
  const first = request(decisionItem(preview, link('team', firstTeam)));
  const second = request(decisionItem(preview, link('team', secondTeam)));
  await batches.decide(db, site, first, users.editor);
  await batches.decide(peer, site, second, users.editor);

  const acquired = Promise.withResolvers(), attempted = Promise.withResolvers(), release = Promise.withResolvers();
  t.signal.addEventListener('abort', release.resolve, { once: true });
  const interceptLock = (connection, intercept) => ({
    transaction: operation => connection.transaction(tx => operation({
      ...tx, run: (sql, ...params) => sql === 'UPDATE sites SET id = id WHERE id = ?'
        ? intercept(() => tx.run(sql, ...params)) : tx.run(sql, ...params),
    })),
  });
  const winner = batches.apply(interceptLock(db, async run => {
    const result = await run();
    acquired.resolve();
    await release.promise;
    return result;
  }), site, first.batchId, users.editor);
  await Promise.race([acquired.promise, winner]);
  const loser = batches.apply(interceptLock(peer, run => {
    attempted.resolve();
    return run();
  }), site, second.batchId, users.editor);
  await Promise.race([attempted.promise, loser]).finally(release.resolve);
  const [applied, stale] = await Promise.all([winner, loser]);
  assert.equal(applied.counts.applied, 1);
  assert.equal(stale.counts.stale, 1);
  assert.deepEqual(await batches.apply(peer, site, first.batchId, users.editor), applied);
  assert.deepEqual((await db.all('SELECT batch_id, team_id FROM task_assignment_links WHERE task_id = ?', task.id)).map(row => ({ ...row })),
    [{ batch_id: first.batchId, team_id: firstTeam.id }]);
}
