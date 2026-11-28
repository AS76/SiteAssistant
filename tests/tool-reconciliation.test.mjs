import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createServer } from '../server/http.mjs';
import { saveModuleAccess } from '../server/module-access.mjs';
import { createSite } from '../server/repository.mjs';
import { writeRegistry } from '../server/site-registry.mjs';
import { createTool, toolCompanyReconciliation as batches, updateTool } from '../server/tools.mjs';
import { authFixture, requestListener } from './helpers/auth.mjs';
import { isPg, openSqliteTestDb, openTestDb } from './helpers/db.mjs';

const occurrence = recordId => ({ recordId, field: 'company' });
const link = (company, relationship = 'custodian') => ({
  action: 'link', reason: 'Checked the equipment record', relationship, companyId: company.id, companyRevision: company.revision,
});
const decisionItem = ({ recordId, field, revision }, decision) => ({ recordId, field, revision, decision });
const request = (items, decision) => ({ batchId: randomUUID(), decisions: items.map(item => decisionItem(item, decision)) });

async function siteFixture(db, users) {
  const site = await createSite(db, { code: randomUUID(), name: 'Synthetic site' });
  for (const role of ['owner', 'editor', 'verifier', 'viewer']) {
    await db.run('INSERT INTO site_members (site_id, user_id, role) VALUES (?, ?, ?)', site.id, users[role].id, role);
  }
  return {
    site,
    company: name => writeRegistry(db, { siteId: site.id, collection: 'companies', action: 'create' },
      { name, reason: 'Synthetic registry entry' }, users.owner),
    tool: (name, company = null) => createTool(db, { siteId: site.id, name, company }, users.editor),
  };
}

function checked(response, status, code) {
  assert.equal(response.status, status, JSON.stringify(response.body));
  if (code) assert.equal(response.body.code, code);
  return response.body;
}

test(`Tools reconciliation through HTTP (${isPg ? 'PostgreSQL' : 'SQLite'})`, async t => {
  const { db, close } = await openTestDb();
  t.after(close);
  const { users, cookies } = await authFixture(db);
  const f = await siteFixture(db, users), foreign = await siteFixture(db, users);
  const company = await f.company('Synthetic contractor');
  const homonym = await f.company(company.name);
  const other = await foreign.company(company.name);
  const tool = await f.tool('Ladder', company.name);
  const edited = await f.tool('Lift', company.name);
  const replaced = await f.tool('Drill', company.name);
  const empty = await f.tool('Sander');
  const api = requestListener(createServer(db));
  const base = `/api/sites/${f.site.id}/people-reconciliation/tools`;
  const send = (path, body, role = 'editor') => api(base + path,
    { method: body === undefined ? 'GET' : 'POST', body, cookie: cookies[role] });
  const preview = async (records, role) => checked(await send('/previews', { occurrences: records.map(row => occurrence(row.id)) }, role), 200);
  const list = async (role = 'viewer', companyFilter) => checked(await api(`/api/tools?site_id=${f.site.id}` +
    (companyFilter ? '&company=' + encodeURIComponent(companyFilter) : ''), { cookie: cookies[role] }), 200);
  const scopes = [tool, edited, replaced];
  const before = await preview(scopes, 'verifier');
  assert.equal(before.adoption.enabled, false);
  assert.equal(before.counts.unresolved, 3);
  assert.deepEqual(new Set(before.items[0].candidates.records.map(row => row.id)), new Set([company.id, homonym.id]));
  assert.equal((await preview([empty], 'viewer')).items[0].source.company, null);
  assert.equal(await db.get('SELECT id FROM reconciliation_batches'), undefined);
  assert.equal(await db.get('SELECT tool_id FROM tool_company_links'), undefined);

  const first = request(before.items, link(company));
  checked(await send('/batches', first), 409, 'RECONCILIATION_DISABLED');
  checked(await send('/adoption', {}, 'editor'), 403, 'TOOL_FORBIDDEN');
  checked(await send('/adoption', {}, 'owner'), 200);
  checked(await send(`/batches/${first.batchId}/apply`, {}), 404, 'RECONCILIATION_NOT_FOUND');
  for (const role of ['verifier', 'viewer']) {
    checked(await send('/batches', first, role), 403, 'TOOL_FORBIDDEN');
    checked(await send(`/batches/${first.batchId}/apply`, {}, role), 403, 'TOOL_FORBIDDEN');
  }
  checked(await send('/batches', request(before.items, { ...link(company), companyId: undefined })), 400, 'TOOL_INVALID');
  checked(await send('/batches', request(before.items, { action: 'create', name: company.name,
    reason: 'Check duplicate rejection', relationship: 'supplier' })), 409, 'TOOL_COMPANY_AMBIGUOUS');
  checked(await send('/batches', request(before.items, link(other))), 404, 'TOOL_COMPANY_NOT_FOUND');
  checked(await api(`/api/tools/${tool.id}`, { method: 'PATCH', body: { company_id: company.id }, cookie: cookies.editor }), 400, 'TOOL_INVALID');

  const recorded = checked(await send('/batches', first), 200);
  assert.deepEqual(checked(await send('/batches', first), 200), recorded);
  assert.equal(recorded.status, 'decided');
  assert.equal(await db.get('SELECT tool_id FROM tool_company_links'), undefined);
  const conflicting = { ...first, decisions: first.decisions.map(item => decisionItem(item, link(homonym))) };
  checked(await send('/batches', conflicting), 409, 'RECONCILIATION_DECISION_CONFLICT');

  const applied = checked(await send(`/batches/${first.batchId}/apply`, {}), 200);
  assert.deepEqual(applied.counts, { total: 3, matched: 3, applied: 3, unresolved: 0, stale: 0, conflicting: 0 });
  assert.deepEqual(checked(await send(`/batches/${first.batchId}/apply`, {}), 200), applied);
  const detail = checked(await send(`/batches/${first.batchId}`), 200);
  assert.equal(detail.decidedBy, users.editor.id);
  assert.ok(detail.items.every(item => item.target.name === company.name && item.source.company === company.name && item.source.link === null));
  const filtered = await list('viewer', company.name);
  assert.equal(filtered.length, 3);
  assert.ok(filtered.every(row => row.company === company.name && row.company_id === company.id && row.company_relationship === 'custodian'));
  const changes = await db.all("SELECT actor, changes FROM audit_events WHERE entity_id = ? AND action = 'update'", tool.id);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].actor, users.editor.id);
  assert.deepEqual(JSON.parse(changes[0].changes).company_id, { from: null, to: company.id });

  await saveModuleAccess(db, { siteId: f.site.id, memberId: users.viewer.id, module: 'registry', allowed: false }, users.owner);
  checked(await send('/previews', { occurrences: [occurrence(tool.id)] }, 'viewer'), 403, 'MODULE_FORBIDDEN');
  assert.equal((await list()).find(row => row.id === tool.id).company_id, undefined);

  // A normal edit survives compensation; a changed source label or a newer link is reported.
  await updateTool(db, tool.id, { notes: 'Intervention after approval' }, users.editor);
  await updateTool(db, edited.id, { company: 'Manually corrected label' }, users.editor);
  const replacement = request((await preview([replaced])).items, link(homonym, 'owner'));
  checked(await send('/batches', replacement), 200);
  checked(await send(`/batches/${replacement.batchId}/apply`, {}), 200);
  const rollbackPath = `/batches/${first.batchId}/rollback`;
  const rollback = { reason: 'Check compensating rollback' };
  checked(await send(rollbackPath, rollback, 'editor'), 403, 'TOOL_FORBIDDEN');
  const undone = checked(await send(rollbackPath, rollback, 'owner'), 200);
  assert.deepEqual(undone.counts, { compensated: 1, conflicting: 2 });
  assert.equal(undone.adoption.enabled, false);
  assert.deepEqual(checked(await send(rollbackPath, rollback, 'owner'), 200), undone);
  checked(await send(rollbackPath, { reason: 'Different rollback' }, 'owner'), 409, 'RECONCILIATION_DECISION_CONFLICT');
  assert.deepEqual(checked(await send(`/batches/${first.batchId}/apply`, {}), 200), applied);
  const legacy = await list('owner');
  assert.ok(legacy.every(row => row.company_id === null));
  assert.equal(legacy.find(row => row.id === tool.id).notes, 'Intervention after approval');
  assert.equal(legacy.find(row => row.id === edited.id).company, 'Manually corrected label');
  assert.equal((await db.get('SELECT company_id FROM tool_company_links WHERE tool_id = ?', replaced.id)).company_id, homonym.id);
  const historical = checked(await send(`/batches/${first.batchId}`), 200);
  assert.deepEqual(historical.items, detail.items);
  assert.equal(historical.status, 'rolled_back');
  assert.equal((await db.all("SELECT id FROM audit_events WHERE entity_id = ? AND action = 'update'", tool.id)).length, 3);

  checked(await send('/adoption', {}, 'owner'), 200);
  const reconsider = request((await preview([tool])).items, link(company));
  checked(await send('/batches', reconsider), 200);
  assert.equal(checked(await send(`/batches/${reconsider.batchId}/apply`, {}), 200).counts.applied, 1);
  assert.equal((await list('owner')).find(row => row.id === replaced.id).company_id, homonym.id);

  const unresolved = request((await preview([empty])).items, { action: 'unresolved', reason: 'Missing evidence' });
  checked(await send('/batches', unresolved), 200);
  assert.equal(checked(await send(`/batches/${unresolved.batchId}/apply`, {}), 200).counts.unresolved, 1);
  const typedCreate = request((await preview([empty])).items, { action: 'create', name: 'Synthetic supplier',
    relationship: 'supplier', reason: 'New company confirmed' });
  checked(await send('/batches', typedCreate), 200);
  const creation = checked(await send(`/batches/${typedCreate.batchId}/apply`, {}), 200);
  assert.equal(creation.counts.applied, 1);
  const createdId = creation.items[0].target.id;
  assert.equal((await db.get('SELECT count(*) AS n FROM registry_history WHERE record_id = ?', createdId)).n.toString(), '1');
  await assert.rejects(db.run('UPDATE tool_company_links SET company_id = ? WHERE tool_id = ?', other.id, empty.id),
    /foreign key/i);
  await writeRegistry(db, { siteId: f.site.id, collection: 'companies', id: createdId, action: 'archive' },
    { revision: creation.items[0].target.revision, reason: 'Archived company remains in history' }, users.owner);
  const archived = (await list('owner')).find(row => row.id === empty.id);
  assert.equal(archived.company_label, 'Synthetic supplier');
  assert.ok(archived.company_archived_at);
  checked(await send(`/batches/${typedCreate.batchId}/rollback`, rollback, 'owner'), 200);
  assert.ok(await db.get('SELECT id FROM registry_companies WHERE id = ?', createdId));
});

test(`Tools reconciliation serializes independent ${isPg ? 'PostgreSQL' : 'SQLite'} writers`, { timeout: 30000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'tools-reconciliation-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { db, reopen, close } = await (isPg ? openTestDb() : openSqliteTestDb(join(directory, 'test.db')));
  const peer = await reopen();
  t.after(async () => { await peer.close(); await close(); });
  const { users } = await authFixture(db);
  const f = await siteFixture(db, users);
  const company = await f.company('Synthetic contractor');
  const tool = await f.tool('Ladder', company.name);
  const { id: site } = f.site;
  const items = async row => (await batches.preview(db, site, { occurrences: [occurrence(row.id)] }, users.editor)).items;
  const approve = async (source, choice) => {
    const input = request(source, choice);
    await batches.decide(db, site, input, users.editor);
    return input.batchId;
  };
  await batches.activate(db, site, users.owner);
  const sameSource = await items(tool);
  const firstId = await approve(sameSource, link(company, 'custodian'));
  const competingId = await approve(sameSource, link(company, 'supplier'));

  // Hold the first transaction's site lock until an independent writer has attempted it.
  const { promise: acquired, resolve: notifyAcquired } = Promise.withResolvers();
  const { promise: attempted, resolve: notifyAttempt } = Promise.withResolvers();
  const { promise: release, resolve: releaseFirst } = Promise.withResolvers();
  t.signal.addEventListener('abort', releaseFirst, { once: true });
  const interceptLock = (connection, intercept) => ({
    transaction: operation => connection.transaction(tx => operation({
      ...tx,
      run: (sql, ...params) => sql === 'UPDATE sites SET id = id WHERE id = ?'
        ? intercept(() => tx.run(sql, ...params)) : tx.run(sql, ...params),
    })),
  });
  const first = batches.apply(interceptLock(db, async run => {
    const result = await run();
    notifyAcquired();
    await release;
    return result;
  }), site, firstId, users.editor);
  await Promise.race([acquired, first]);
  const second = batches.apply(interceptLock(peer, run => {
    notifyAttempt();
    return run();
  }), site, competingId, users.editor);
  await Promise.race([attempted, second]).finally(releaseFirst);
  const [winner, stale] = await Promise.all([first, second]);
  assert.equal(winner.counts.applied, 1);
  assert.equal(stale.counts.stale, 1);
  assert.deepEqual(await batches.apply(peer, site, firstId, users.editor), winner);
  assert.equal((await db.get('SELECT batch_id FROM tool_company_links WHERE tool_id = ?', tool.id)).batch_id, firstId);
  const audits = await db.all("SELECT id FROM audit_events WHERE entity_id = ? AND action = 'update'", tool.id);
  assert.equal(audits.length, 1);

  const other = await f.tool('Drill', company.name);
  const replayId = await approve(await items(other), link(company));
  const [left, right] = await Promise.all([db, peer].map(connection => batches.apply(connection, site, replayId, users.editor)));
  assert.deepEqual(left, right);
  assert.equal(left.counts.applied, 1);

  const changed = await f.tool('Grinder', company.name);
  const changing = await approve(await items(changed), link(company));
  await updateTool(peer, changed.id, { company: 'Corrected source value' }, users.editor);
  assert.equal((await batches.apply(db, site, changing, users.editor)).counts.stale, 1);

  const target = await f.tool('Tripod', company.name);
  const waiting = await approve(await items(target), link(company));
  await writeRegistry(peer, { siteId: site, collection: 'companies', id: company.id, action: 'update' },
    { revision: company.revision, name: 'Updated registry label', reason: 'Synthetic rename' }, users.owner);
  const invalidated = await batches.apply(db, site, waiting, users.editor);
  assert.equal(invalidated.counts.conflicting, 1);
  assert.equal(invalidated.items[0].code, 'TOOL_COMPANY_CHANGED');
});
