import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createSite, createTask } from '../../server/repository.mjs';
import { writeRegistry } from '../../server/site-registry.mjs';
import { taskAssignmentReconciliation as batches, withTaskAssignmentHistory } from '../../server/task-reconciliation.mjs';
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

export async function assertAtomicTaskAssignmentSwap(db) {
  const { users } = await authFixture(db);
  const f = await siteFixture(db, users);
  const site = f.site.id;
  const editor = users.editor;
  const task = await f.task();
  const a = await f.person('Synthetic person A');
  const b = await f.person('Synthetic person B');
  const aExecutor = await f.grant(a, 'executor');
  const aVerifier = await f.grant(a, 'verifier');
  const bExecutor = await f.grant(b, 'executor');
  const bVerifier = await f.grant(b, 'verifier');
  const occurrences = [occurrence(task.id), occurrence(task.id, 'verifier')];
  const plan = async (executor, verifier) => {
    const { items } = await batches.preview(db, site, { occurrences }, editor);
    const [executorItem, verifierItem] = items;
    return request(decisionItem(executorItem, executor), decisionItem(verifierItem, verifier));
  };
  const initialPair = [link('person', a, aExecutor), link('person', b, bVerifier)];
  const swappedPair = [link('person', b, bExecutor), link('person', a, aVerifier)];

  await batches.activate(db, site, users.owner);
  const initial = await plan(...initialPair);
  await batches.decide(db, site, initial, editor);
  const first = await batches.apply(db, site, initial.batchId, editor);
  assert.deepEqual(first.items.map(item => [item.status, item.version, item.target.id]), [
    ['applied', 1, a.id], ['applied', 1, b.id],
  ]);

  const swap = await plan(...swappedPair);
  const decision = await batches.decide(db, site, swap, editor);
  assert.equal(decision.status, 'decided');
  const applied = await batches.apply(db, site, swap.batchId, editor);
  assert.deepEqual(applied.counts, { total: 2, matched: 2, applied: 2, unresolved: 0, stale: 0, conflicting: 0 });
  assert.deepEqual(applied.items.map(item => [item.field, item.status, item.version, item.target.id]), [
    ['executor', 'applied', 2, b.id], ['verifier', 'applied', 2, a.id],
  ]);
  assert.deepEqual(await batches.apply(db, site, swap.batchId, editor), applied);

  const audit = await batches.read(db, site, swap.batchId, editor);
  assert.equal(audit.status, 'applied');
  assert.equal(audit.decidedBy, editor.id);
  assert.equal(audit.appliedBy, editor.id);
  assert.deepEqual(audit.apply, applied);
  const appliedAt = new Date(audit.appliedAt).toISOString();
  const readHistory = async () => (await withTaskAssignmentHistory(db, task, editor, 'editor')).assignment_history;
  const history = await readHistory();
  assert.equal(history.length, 4);
  for (const [index, item] of applied.items.entries()) {
    const { field } = item;
    const [current, prior] = history.filter(row => row.field === field);
    assert.deepEqual(audit.items[index].decision, swappedPair[index]);
    assert.deepEqual(audit.items[index].source.link.snapshot, first.items[index].target);
    assert.deepEqual(audit.items[index].target, item.target);
    assert.deepEqual([current.batch_id, current.version, current.current, current.valid_to, current.end_action],
      [swap.batchId, 2, true, null, null]);
    assert.deepEqual([prior.batch_id, prior.version, prior.current, prior.end_action],
      [initial.batchId, 1, false, 'superseded']);
    assert.deepEqual(current.snapshot, item.target);
    assert.deepEqual(prior.snapshot, first.items[index].target);
    assert.equal(current.original_label, task[field]);
    assert.equal(prior.original_label, task[field]);
    assert.equal(item.validFrom, appliedAt);
    assert.equal(new Date(current.valid_from).toISOString(), appliedAt);
    assert.equal(new Date(prior.valid_to).toISOString(), appliedAt);
  }
  const accounts = await db.get('SELECT executor_id, verifier_id FROM tasks WHERE id = ?', task.id);
  assert.equal(accounts.executor_id, null);
  assert.equal(accounts.verifier_id, null);

  const ambiguous = await plan(initialPair[0], swappedPair[1]);
  await assert.rejects(batches.decide(db, site, ambiguous, editor), { code: 'SEPARATE_PEOPLE_REQUIRED' });

  const swapBack = await plan(...initialPair);
  await batches.decide(db, site, swapBack, editor);
  await f.registry('authority-roles', { revision: bVerifier.revision }, 'revoke', bVerifier.id);
  const invalidated = await batches.apply(db, site, swapBack.batchId, editor);
  assert.deepEqual(invalidated.items.map(item => [item.field, item.status, item.code]), [
    ['executor', 'conflicting', 'SEPARATE_PEOPLE_REQUIRED'],
    ['verifier', 'conflicting', 'TASK_ASSIGNMENT_TARGET_CHANGED'],
  ]);
  assert.deepEqual(await readHistory(), history);
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
