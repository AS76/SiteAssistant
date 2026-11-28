import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { createApi } from '../app/api.mjs';
import { createOfflineStore, scopeFor } from '../app/offline.mjs';
import { createServer } from '../server/http.mjs';
import { saveModuleAccess } from '../server/module-access.mjs';
import { recogniseResponsibles } from '../server/recognise-responsibles.mjs';
import { migrate } from '../server/migrations/index.mjs';
import { setMember } from '../server/repository.mjs';
import { translatePlaceholders } from '../server/storage/pg.mjs';
import { authFixture, requestListener } from './helpers/auth.mjs';
import { openSqliteTestDb } from './helpers/db.mjs';
import { assertAtomicTaskAssignmentSwap, assertConcurrentTaskAssignments, day, decisionItem, link, occurrence, request,
  siteFixture, stamp } from './helpers/task-reconciliation.mjs';
import { mockIndexedDB, mockLocks } from './helpers/indexeddb.mjs';

const unresolvedDecision = { action: 'unresolved', reason: 'Two eligible homonyms in the source' };
const hasCode = code => error => error.code === code;
const iso = value => new Date(value).toISOString();

async function openPGlite(t) {
  const pg = new PGlite();
  t.after(() => pg.close());
  const adapt = connection => ({
    exec: sql => connection.exec(sql),
    all: async (sql, ...args) => (await connection.query(translatePlaceholders(sql), args)).rows,
    get: async (sql, ...args) => (await connection.query(translatePlaceholders(sql), args)).rows[0],
    run: async (sql, ...args) => ({ rowCount: (await connection.query(translatePlaceholders(sql), args)).affectedRows }),
    isUniqueViolation: error => error.code === '23505',
  });
  const db = { ...adapt(pg), transaction: fn => pg.transaction(tx => fn(adapt(tx))) };
  await migrate(db, { driver: 'pg' });
  return db;
}

function testBoth(title, run) {
  test(title + ' (SQLite)', async t => {
    const { db, close } = await openSqliteTestDb();
    t.after(close);
    await run(t, db);
  });
  test(title + ' (PGlite)', async t => run(t, await openPGlite(t)));
}

function checked(response, status, code) {
  assert.equal(response.status, status, JSON.stringify(response.body));
  if (code) assert.equal(response.body.code, code);
  return response.body;
}

function taskRoutes(db, cookies, site) {
  const api = requestListener(createServer(db));
  const base = `/api/sites/${site.id}/people-reconciliation/tasks`;
  const send = (path, body, role = 'editor') => api(base + path,
    { method: body === undefined ? 'GET' : 'POST', body, cookie: cookies[role] });
  return {
    api, send,
    preview: async (occurrences, role = 'editor') => checked(await send('/previews', { occurrences }, role), 200),
    detail: async (task, role = 'viewer') => checked(await api(`/api/tasks/${task.id}?include=assignment_history`, { cookie: cookies[role] }), 200),
    transition: async (task, to, body = {}, role = 'editor', status = 200) => checked(
      await api(`/api/tasks/${task.id}/transition`, { method: 'POST', body: { to, ...body }, cookie: cookies[role] }), status),
  };
}

testBoth('Tasks reconcile explicit typed decisions and retain dated snapshots and account permissions', async (t, db) => {
  const { users, cookies } = await authFixture(db);
  const f = await siteFixture(db, users);
  const r = taskRoutes(db, cookies, f.site);
  const person = await f.person('Synthetic executor');
  const authority = await f.grant(person, 'executor');
  const reviewer = await f.person('Synthetic reviewer');
  const reviewerAuthority = await f.grant(reviewer, 'verifier');
  const confirmed = await f.registry('account-links', { personId: reviewer.id, accountId: users.verifier.id });
  const company = await f.company('Synthetic contractor');
  const task = await f.task();
  const withAccount = await f.task({ verifier_id: users.verifier.id });
  const accountPreview = await r.preview([occurrence(withAccount.id, 'verifier')], 'viewer');
  assert.deepEqual(accountPreview.items[0].source.accounts.verifier.atCreation,
    { personId: reviewer.id, validFrom: iso(confirmed.valid_from) });
  const older = await f.task({ verifier_id: users.verifier.id });
  await db.run('UPDATE tasks SET created_at = ? WHERE id = ?', '2000-01-01T00:00:00Z', older.id);
  const olderPreview = await r.preview([occurrence(older.id, 'verifier')]);
  assert.equal(olderPreview.items[0].source.accounts.verifier.atCreation, null);
  assert.equal(olderPreview.items[0].source.accounts.verifier.current.personId, reviewer.id);
  const memberships = await db.all('SELECT * FROM site_members ORDER BY site_id, user_id');
  const accounts = await db.all('SELECT id FROM users ORDER BY id');

  const selects = [occurrence(task.id), occurrence(task.id, 'verifier'), occurrence(task.id, 'company')];
  const preview = await r.preview(selects, 'verifier');
  assert.equal(preview.adoption.enabled, false);
  assert.equal(preview.counts.unresolved, 3);
  assert.deepEqual(await db.all('SELECT * FROM reconciliation_batches'), []);
  const choices = { executor: link('person', person, authority), verifier: link('person', reviewer, reviewerAuthority),
    company: link('company', company) };
  const approval = request(...preview.items.map(item => decisionItem(item, choices[item.field])));
  checked(await r.send('/batches', approval), 409, 'RECONCILIATION_DISABLED');
  checked(await r.send('/adoption', {}), 403, 'FORBIDDEN');
  checked(await r.send('/adoption', {}, 'owner'), 200);
  for (const role of ['verifier', 'viewer']) checked(await r.send('/batches', approval, role), 403, 'FORBIDDEN');
  const decided = checked(await r.send('/batches', approval), 200);
  assert.deepEqual(checked(await r.send('/batches', approval), 200), decided);
  assert.deepEqual(await db.all('SELECT * FROM task_assignment_links'), []);
  const batchPath = `/batches/${approval.batchId}`;
  checked(await r.send(batchPath + '/apply', {}, 'verifier'), 403, 'FORBIDDEN');
  const outcome = checked(await r.send(batchPath + '/apply', {}), 200);
  assert.equal(outcome.counts.applied, 3);
  assert.deepEqual(checked(await r.send(batchPath + '/apply', {}), 200), outcome);
  assert.equal(checked(await r.send(batchPath, undefined, 'viewer'), 200).items.length, 3);
  const { assignment_history: history, ...detail } = await r.detail(task);
  assert.equal(detail.executor, task.executor);
  assert.equal(detail.verifier, task.verifier);
  assert.equal(detail.company, task.company);
  assert.equal(detail.executor_id, null);
  assert.equal(detail.verifier_id, null);
  const assigned = history.find(entry => entry.field === 'executor');
  assert.equal(assigned.original_label, 'Recorded  executor');
  assert.deepEqual(assigned.snapshot.authority, { id: authority.id, revision: 1, role: 'executor',
    validFrom: iso(authority.valid_from), validTo: iso(authority.valid_to) });
  assert.ok(assigned.current);
  assert.equal(assigned.snapshot.name, person.name);
  assert.equal(assigned.valid_from, outcome.items.find(item => item.field === 'executor').validFrom);
  assert.deepEqual(await db.all('SELECT * FROM site_members ORDER BY site_id, user_id'), memberships);
  assert.deepEqual(await db.all('SELECT id FROM users ORDER BY id'), accounts);

  await saveModuleAccess(db, { siteId: f.site.id, memberId: users.viewer.id, module: 'registry', allowed: false }, users.owner);
  assert.equal((await r.detail(task)).assignment_history, undefined);
  checked(await r.send('/previews', { occurrences: selects }, 'viewer'), 403, 'MODULE_FORBIDDEN');

  await f.registry('people', { name: 'Renamed synthetic person', revision: person.revision }, 'update', person.id);
  await f.registry('authority-roles', { revision: authority.revision }, 'revoke', authority.id);
  await assert.rejects(f.registry('people', { revision: person.revision + 1 }, 'archive', person.id),
    hasCode('REGISTRY_ACTIVE_REFERENCES'));
  await f.grant(person, 'inspector');
  assert.deepEqual((await r.detail(task, 'verifier')).assignment_history, history);
  assert.equal((await r.transition(task, 'in_progress')).status, 'in_progress');
  await r.transition(task, 'to_verify', { note: 'Synthetic submission' });
  const waiver = { waiver: true, reason: 'Synthetic closure waiver reason' };
  assert.equal((await r.transition(task, 'closed', waiver, 'verifier', 403)).code, 'FORBIDDEN');
  await r.transition(task, 'closed', waiver, 'owner');
  await f.registry('companies', { revision: company.revision }, 'archive', company.id);
  const archivedLink = (await r.detail(task, 'verifier')).assignment_history.find(entry => entry.field === 'company');
  assert.ok(archivedLink.archived_at);
  assert.equal(archivedLink.current, false);
  assert.equal(archivedLink.snapshot.name, company.name);
  assert.equal(checked(await r.send('/candidates?field=company'), 200).total, 0);
});

testBoth('Tasks keep homonyms unresolved and reject stale authority, equivalence and cross-site links', async (t, db) => {
  const { users, cookies } = await authFixture(db);
  const f = await siteFixture(db, users), foreign = await siteFixture(db, users);
  const r = taskRoutes(db, cookies, f.site);
  const a = await f.person(users.editor.name), b = await f.person(a.name), outside = await foreign.person(a.name);
  const aRole = await f.grant(a, 'executor');
  const aVerifier = await f.grant(a, 'verifier');
  const bRole = await f.grant(b, 'executor');
  const foreignRole = await foreign.grant(outside, 'executor');
  const expired = await f.person('Synthetic expired role');
  const expiredRole = await f.grant(expired, 'executor', stamp(-2 * day), stamp(-day));
  const team = await f.team(a.name);
  const task = await f.task({ executor: a.name });
  const otherTask = await foreign.task({ executor: a.name });
  checked(await r.send('/adoption', {}, 'owner'), 200);
  const preview = () => r.preview([occurrence(task.id), occurrence(task.id, 'verifier')]);
  const items = (await preview()).items;
  const [executor, verifier] = items;
  assert.equal(executor.status, 'unresolved');
  assert.equal(executor.candidates.total, 3);
  assert.deepEqual(new Set(executor.candidates.records.map(row => row.id)), new Set([a.id, b.id, team.id]));
  checked(await r.send('/previews', { occurrences: [occurrence(otherTask.id)] }), 404, 'RECONCILIATION_SOURCE_NOT_FOUND');
  const approve = (item, decision, status, code) => r.send('/batches', request(decisionItem(item, decision)))
    .then(response => checked(response, status, code));
  await approve(executor, link('person', outside, foreignRole), 404, 'TASK_ASSIGNMENT_TARGET_NOT_FOUND');
  await approve(executor, link('person', expired, expiredRole), 404, 'TASK_ASSIGNMENT_TARGET_NOT_FOUND');
  await approve(verifier, link('team', team), 400, 'VALIDATION_ERROR');
  checked(await r.send('/batches', request(decisionItem(executor, link('person', a, aRole)), decisionItem(verifier, link('person', a, aVerifier)))),
    409, 'SEPARATE_PEOPLE_REQUIRED');

  const undecided = request(decisionItem(executor, unresolvedDecision));
  checked(await r.send('/batches', undecided), 200);
  checked(await r.send('/batches', undecided), 200);
  const unresolvedPath = `/batches/${undecided.batchId}/apply`;
  const unresolved = checked(await r.send(unresolvedPath, {}), 200);
  assert.equal(unresolved.counts.unresolved, 1);
  assert.deepEqual(checked(await r.send(unresolvedPath, {}), 200), unresolved);
  assert.equal((await db.get('SELECT count(*) AS n FROM reconciliation_items')).n.toString(), '1');
  assert.deepEqual(await db.all('SELECT * FROM task_assignment_links'), []);
  assert.equal((await recogniseResponsibles(db, f.site.id, { apply: true })).linked, 0);
  assert.equal((await r.detail(task)).executor_id, null);

  const revoked = request(decisionItem(executor, link('person', b, bRole)));
  checked(await r.send('/batches', revoked), 200);
  await f.registry('authority-roles', { revision: bRole.revision }, 'revoke', bRole.id);
  const invalidated = checked(await r.send(`/batches/${revoked.batchId}/apply`, {}), 200);
  assert.equal(invalidated.items[0].code, 'TASK_ASSIGNMENT_TARGET_CHANGED');
  await approve(executor, link('person', b, bRole), 404, 'TASK_ASSIGNMENT_TARGET_NOT_FOUND');

  t.mock.timers.enable({ apis: ['Date'], now: new Date() });
  const cutoff = stamp(60_000);
  const expiringRole = await f.grant(b, 'executor', stamp(0), cutoff);
  const expires = await approve(executor, link('person', b, expiringRole), 200);
  t.mock.timers.setTime(Date.parse(cutoff));
  const expiredResult = checked(await r.send(`/batches/${expires.id}/apply`, {}), 200);
  assert.equal(expiredResult.items[0].code, 'TASK_ASSIGNMENT_TARGET_CHANGED');
  assert.equal(checked(await r.send('/candidates?field=executor'), 200).records.some(row => row.id === b.id), false);

  const accountTask = await f.task({ executor: 'Other label for reviewer identity', verifier_id: users.verifier.id });
  const pendingAccount = (await r.preview([occurrence(accountTask.id)])).items[0];
  const accountBatch = await approve(pendingAccount, link('person', a, aRole), 200);
  checked(await r.send(`/batches/${accountBatch.id}/apply`, {}), 200);
  await assert.rejects(f.registry('account-links', { personId: a.id, accountId: users.verifier.id }),
    hasCode('SEPARATE_PEOPLE_REQUIRED'));
  await assert.rejects(db.run('UPDATE task_assignment_links SET person_id = ? WHERE task_id = ?', outside.id, accountTask.id), /foreign key/i);
  const otherAccountTask = await f.task({ verifier_id: users.owner.id });
  await f.registry('account-links', { personId: a.id, accountId: users.owner.id });
  const pendingOtherAccount = (await r.preview([occurrence(otherAccountTask.id)])).items[0];
  await approve(pendingOtherAccount, link('person', a, aRole), 409, 'SEPARATE_PEOPLE_REQUIRED');
  const staged = await approve(executor, link('team', team), 200);
  await setMember(db, f.site.id, { user_id: users.editor.id, role: 'viewer' }, users.owner);
  checked(await r.send(`/batches/${staged.id}/apply`, {}, 'owner'), 403, 'FORBIDDEN');
});

test('Tasks swap executor and verifier atomically (SQLite)', async t => {
  const { db, close } = await openSqliteTestDb();
  t.after(close);
  await assertAtomicTaskAssignmentSwap(db);
});

testBoth('Tasks compensate only the batch version and preserve later manual work', async (t, db) => {
  const { users, cookies } = await authFixture(db);
  const f = await siteFixture(db, users);
  const r = taskRoutes(db, cookies, f.site);
  const team = await f.team('Synthetic installation crew');
  const original = await f.company('Synthetic original contractor');
  const replacement = await f.company('Synthetic replacement contractor');
  const task = await f.task({ executor: users.editor.name });
  const selects = [occurrence(task.id), occurrence(task.id, 'company')];
  checked(await r.send('/adoption', {}, 'owner'), 200);
  const first = await r.preview(selects);
  const input = request(...first.items.map(item => decisionItem(item,
    item.field === 'company' ? link('company', original) : link('team', team))));
  const path = `/batches/${input.batchId}`;
  checked(await r.send('/batches', input), 200);
  checked(await r.send(path + '/apply', {}), 200);
  assert.equal((await recogniseResponsibles(db, f.site.id, { apply: true })).linked, 0);
  const manual = await r.transition(task, 'blocked', { reason: 'Manual intervention after linking' });
  const companyPreview = await r.preview([occurrence(task.id, 'company')]);
  const superseding = request(decisionItem(companyPreview.items[0], link('company', replacement)));
  checked(await r.send('/batches', superseding), 200);
  checked(await r.send(`/batches/${superseding.batchId}/apply`, {}), 200);
  const compensation = { reason: 'Synthetic compensation' };
  const rolledBack = checked(await r.send(path + '/rollback', compensation, 'owner'), 200);
  assert.deepEqual(rolledBack.counts, { compensated: 1, conflicting: 1 });
  assert.equal(rolledBack.adoption.enabled, false);
  assert.deepEqual(checked(await r.send(path + '/rollback', compensation, 'owner'), 200), rolledBack);
  const detail = await r.detail(task);
  assert.equal(detail.status, 'blocked');
  assert.equal(detail.executor_id, null);
  assert.equal(detail.company, task.company);
  assert.deepEqual(detail.events, manual.events);
  assert.deepEqual(detail.assignment_history.map(row => [row.snapshot.id, row.end_action, row.current]), [
    [replacement.id, null, false], [original.id, 'superseded', false], [team.id, 'compensated', false],
  ]);
  checked(await r.send('/adoption', {}, 'owner'), 200);
  const next = await r.preview([occurrence(task.id)]);
  const retry = request(decisionItem(next.items[0], link('team', team)));
  checked(await r.send('/batches', retry), 200);
  assert.equal(checked(await r.send(`/batches/${retry.batchId}/apply`, {}), 200).items[0].version, 2);
  assert.equal((await r.detail(task)).assignment_history.filter(row => row.current).length, 2);
});

testBoth('Queued task creates and transitions survive registry linking with the real API contract', async (t, db) => {
  const { users, cookies } = await authFixture(db);
  const f = await siteFixture(db, users);
  const r = taskRoutes(db, cookies, f.site);
  const team = await f.team('Synthetic crew');
  const baseUrl = '';
  const userId = users.editor.id;
  const scope = scopeFor(baseUrl, userId);
  const storage = { indexedDB: mockIndexedDB(), locks: mockLocks() };
  const queue = createOfflineStore(storage);
  await queue.setMirror('active', { scope, baseUrl, session: { user: { id: userId } } });
  await queue.setMirror(`state:${scope}`, { tasks: [] });
  const payload = { siteId: f.site.id, title: 'Queued synthetic task', assignee: team.name, reviewer: 'Synthetic verifier' };
  const create = await queue.enqueue({ scope, op_type: 'create_task', payload });
  await queue.enqueue({ scope, op_type: 'transition_task', entity_id: create.entity_id, payload: {
    task: { ...payload, id: create.entity_id, status: 'todo' }, input: { to: 'in_progress', actor: users.editor.name },
  } });
  const requests = [];
  let created;
  const api = createApi({ baseUrl, fresh: true, fetchImpl: async (url, input) => {
    const headers = Object.fromEntries(new Headers(input.headers));
    const response = await r.api(url, { method: input.method, headers, cookie: cookies.editor,
      body: input.body === undefined ? undefined : JSON.parse(input.body) });
    if (url === '/api/tasks' && input.method === 'POST') {
      requests.push([headers['idempotency-key'], input.body]);
      if (!created) {
        created = checked(response, 201);
        throw new Error('Synthetic lost reply after commit');
      }
    }
    return Response.json(response.body, { status: response.status, headers: response.headers });
  } });
  assert.equal((await queue.replayOps(api, { scope, userId })).pending, 2);
  assert.equal((await r.detail(created)).assignment_history, undefined);
  checked(await r.send('/adoption', {}, 'owner'), 200);
  const [preview] = (await r.preview([occurrence(created.id)])).items;
  const decision = request(decisionItem(preview, link('team', team)));
  checked(await r.send('/batches', decision), 200);
  checked(await r.send(`/batches/${decision.batchId}/apply`, {}), 200);
  const reloaded = createOfflineStore(storage);
  assert.deepEqual(await reloaded.replayOps(api, { scope, userId }), { confirmed: 2, failed: 0, pending: 0 });
  assert.deepEqual(requests[0], requests[1]);
  assert.equal(requests[1][0], create.idempotency_key);
  assert.equal((await db.get('SELECT count(*) AS n FROM tasks WHERE site_id = ?', f.site.id)).n.toString(), '1');
  const detail = await r.detail(created);
  assert.equal(detail.status, 'in_progress');
  assert.equal(detail.events.length, 2);
  assert.equal(detail.assignment_history.length, 1);
  assert.equal(detail.assignment_history[0].snapshot.kind, 'team');
  assert.deepEqual(await reloaded.listOps(scope), []);
});

test('Tasks serialize concurrent decisions from independent SQLite connections', { timeout: 30000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'task-reconciliation-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await assertConcurrentTaskAssignments(t, await openSqliteTestDb(join(directory, 'test.db')));
});
